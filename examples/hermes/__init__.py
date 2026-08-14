"""Hitly plugin for Hermes Agent — approval transport + kanban block/review."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 1.5
_poller_started = False
_file_lock = threading.Lock()

_OPEN_STATUSES = frozenset({"pending", "failed_resume"})
_ACCEPT_DECISIONS = frozenset({"accept", "respond", "edit"})
_REJECT_DECISIONS = frozenset({"reject", "ignore", "cancel"})


def _hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME", "").strip()
    return Path(raw) if raw else Path.home() / ".hermes"


def _kanban_store() -> Path:
    return _hermes_home() / "hitly-kanban.json"


def _settings(ctx: Any) -> dict[str, str]:
    def read(key: str, env: str) -> str:
        value = ""
        try:
            raw = ctx.get_config(key, default="")
            if isinstance(raw, str):
                value = raw.strip()
        except Exception:
            value = ""
        return value or os.environ.get(env, "").strip()

    return {
        "api_url": read("api_url", "HITLY_API_URL").rstrip("/"),
        "api_key": read("api_key", "HITLY_API_KEY"),
        "project_id": read("project_id", "HITLY_PROJECT_ID"),
    }


def _request_json(
    settings: dict[str, str],
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
    timeout: float = 30,
) -> dict[str, Any]:
    url = f"{settings['api_url']}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "accept": "application/json",
        "authorization": f"Bearer {settings['api_key']}",
    }
    if data is not None:
        headers["content-type"] = "application/json"
    if idempotency_key:
        headers["idempotency-key"] = idempotency_key
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        snippet = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Hitly {method} {path} failed ({error.code}): {snippet}") from error


def _iso_expiry(seconds: float) -> str:
    when = datetime.now(timezone.utc) + timedelta(seconds=max(seconds, 1))
    return when.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _load_kanban_items() -> list[dict[str, str]]:
    path = _kanban_store()
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and item.get("approval_id") and item.get("task_id")]


def _save_kanban_items(items: list[dict[str, str]]) -> None:
    path = _kanban_store()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"items": items}, indent=2) + "\n", encoding="utf-8")


def _remember_kanban(task_id: str, approval_id: str, run_id: str, kanban_status: str) -> None:
    with _file_lock:
        items = _load_kanban_items()
        key = (task_id, run_id)
        items = [item for item in items if (item.get("task_id"), item.get("run_id")) != key]
        items.append(
            {
                "task_id": task_id,
                "approval_id": approval_id,
                "run_id": run_id,
                "kanban_status": kanban_status,
            }
        )
        _save_kanban_items(items)


def _drop_kanban(approval_id: str) -> None:
    with _file_lock:
        items = [item for item in _load_kanban_items() if item.get("approval_id") != approval_id]
        _save_kanban_items(items)


def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if hasattr(obj, name):
            value = getattr(obj, name)
            if value is not None and value != "":
                return value
    return default


def _accept_choice(request: Any) -> str:
    allowed = _attr(request, "allowed_choices", "allowedChoices", default=None)
    if not allowed:
        return "once"
    for choice in ("once", "session"):
        if choice in allowed:
            return choice
    return "deny"


def _respond(request: Any, choice: str) -> Any:
    respond = getattr(request, "respond", None)
    if callable(respond):
        return respond(choice)
    raise RuntimeError("Hermes approval request is missing respond()")


def present(ctx: Any, request: Any) -> Any:
    settings = _settings(ctx)
    if not settings["api_url"] or not settings["api_key"] or not settings["project_id"]:
        logger.error("Hitly transport is missing api_url, api_key, or project_id")
        return _respond(request, "deny")

    timeout = float(_attr(request, "timeout", default=300) or 300)
    command = str(_attr(request, "command", default="") or "")
    description = str(_attr(request, "description", default="") or "")
    request_id = str(_attr(request, "id", "request_id", "digest", default="") or "")
    surface = str(_attr(request, "surface", "presentation_class", "host_class", default="cli") or "cli")
    session_key = str(_attr(request, "session_key", "sessionKey", default="") or "")
    pattern_key = str(_attr(request, "pattern_key", "patternKey", default="") or "")
    run_id = request_id or session_key or f"hermes-{int(time.time())}"

    try:
        created = _request_json(
            settings,
            "POST",
            "/api/v1/approvals",
            body={
                "plugin": "hermes",
                "projectId": settings["project_id"],
                "kind": "command",
                "runId": run_id,
                "requestId": request_id or None,
                "sessionKey": session_key or None,
                "surface": surface,
                "patternKey": pattern_key or None,
                "command": command,
                "description": description or None,
                "expiresAt": _iso_expiry(timeout),
            },
            idempotency_key=request_id or run_id,
        )
    except Exception:
        logger.exception("Hitly command ingest failed")
        return _respond(request, "deny")

    approval_id = created.get("id")
    if not isinstance(approval_id, str) or not approval_id:
        logger.error("Hitly ingest returned no approval id")
        return _respond(request, "deny")

    deadline = time.monotonic() + max(timeout - 2, 5)
    while time.monotonic() < deadline:
        try:
            status = _request_json(settings, "GET", f"/api/v1/approvals/{approval_id}", timeout=15)
        except Exception:
            logger.exception("Hitly command poll failed")
            time.sleep(_POLL_INTERVAL)
            continue
        state = str(status.get("status") or "")
        decision = status.get("decision")
        if state in _OPEN_STATUSES:
            time.sleep(_POLL_INTERVAL)
            continue
        if decision in _ACCEPT_DECISIONS:
            return _respond(request, _accept_choice(request))
        return _respond(request, "deny")
    return _respond(request, "deny")


def _ingest_kanban(
    ctx: Any,
    *,
    task_id: str | None,
    profile_name: str | None,
    kanban_status: str,
    reason: str | None,
    block_kind: str | None,
) -> None:
    if not task_id:
        return
    settings = _settings(ctx)
    if not settings["api_url"] or not settings["api_key"] or not settings["project_id"]:
        logger.error("Hitly kanban ingest skipped: missing settings")
        return
    run_id = os.environ.get("HERMES_KANBAN_RUN_ID", "").strip() or f"{task_id}:{kanban_status}"
    try:
        created = _request_json(
            settings,
            "POST",
            "/api/v1/approvals",
            body={
                "plugin": "hermes",
                "projectId": settings["project_id"],
                "kind": "kanban",
                "runId": run_id,
                "taskId": task_id,
                "profileName": profile_name or os.environ.get("HERMES_PROFILE") or None,
                "kanbanStatus": kanban_status,
                "reason": reason,
                "blockKind": block_kind,
            },
            idempotency_key=f"{task_id}:{run_id}",
        )
    except Exception:
        logger.exception("Hitly kanban ingest failed for %s", task_id)
        return
    approval_id = created.get("id")
    if isinstance(approval_id, str) and approval_id:
        _remember_kanban(task_id, approval_id, run_id, kanban_status)


def _hermes_kanban(*args: str) -> None:
    result = subprocess.run(
        ["hermes", "kanban", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"hermes kanban {' '.join(args)} failed")


def _apply_kanban_decision(item: dict[str, str], status: dict[str, Any]) -> None:
    task_id = item["task_id"]
    decision = status.get("decision")
    response = status.get("response")
    note = response.strip() if isinstance(response, str) and response.strip() else ""
    if decision in _ACCEPT_DECISIONS:
        _hermes_kanban("comment", task_id, note or "Approved in Hitly.")
        _hermes_kanban("unblock", task_id)
        _drop_kanban(item["approval_id"])
        return
    if decision in _REJECT_DECISIONS or str(status.get("status") or "") in {"expired", "cancelled"}:
        _hermes_kanban("comment", task_id, note or f"Rejected in Hitly ({decision or status.get('status')}).")
        _drop_kanban(item["approval_id"])
        return


def _poller_loop(ctx: Any) -> None:
    while True:
        try:
            settings = _settings(ctx)
            if settings["api_url"] and settings["api_key"]:
                with _file_lock:
                    items = list(_load_kanban_items())
                for item in items:
                    try:
                        status = _request_json(
                            settings,
                            "GET",
                            f"/api/v1/approvals/{item['approval_id']}",
                            timeout=15,
                        )
                    except Exception:
                        logger.exception("Hitly kanban poll failed for %s", item.get("approval_id"))
                        continue
                    if str(status.get("status") or "") in _OPEN_STATUSES:
                        continue
                    try:
                        _apply_kanban_decision(item, status)
                    except Exception:
                        logger.exception("Hermes kanban resume failed for %s", item.get("task_id"))
        except Exception:
            logger.exception("Hitly kanban poller iteration failed")
        time.sleep(5)


def _maybe_start_poller(ctx: Any) -> None:
    global _poller_started
    if _poller_started:
        return
    if os.environ.get("HERMES_KANBAN_TASK") or os.environ.get("HERMES_CRON_SESSION"):
        return
    _poller_started = True
    thread = threading.Thread(target=_poller_loop, args=(ctx,), name="hitly-kanban-poller", daemon=True)
    thread.start()


def register(ctx: Any) -> None:
    ctx.register_approval_transport("hitly", lambda request: present(ctx, request))

    def on_blocked(task_id=None, profile_name=None, **kwargs):
        _ingest_kanban(
            ctx,
            task_id=task_id or kwargs.get("taskId"),
            profile_name=profile_name,
            kanban_status="blocked",
            reason=kwargs.get("reason"),
            block_kind=kwargs.get("kind"),
        )

    def on_tool(tool_name, args=None, result=None, task_id=None, **kwargs):
        del result, kwargs
        if tool_name != "kanban_request_review":
            return
        payload = args if isinstance(args, dict) else {}
        _ingest_kanban(
            ctx,
            task_id=str(payload.get("task_id") or task_id or os.environ.get("HERMES_KANBAN_TASK") or ""),
            profile_name=os.environ.get("HERMES_PROFILE"),
            kanban_status="review",
            reason=str(payload.get("summary") or payload.get("reason") or "") or None,
            block_kind="review",
        )

    ctx.register_hook("kanban_task_blocked", on_blocked)
    ctx.register_hook("post_tool_call", on_tool)
    _maybe_start_poller(ctx)
