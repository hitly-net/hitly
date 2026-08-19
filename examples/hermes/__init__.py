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
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_OPEN_STATUSES = frozenset({"pending", "failed_resume"})
_ACCEPT_DECISIONS = frozenset({"accept", "respond", "edit"})
_REJECT_DECISIONS = frozenset({"reject", "ignore", "cancel"})

# Callback state: maps approval_id → response
_callback_responses: dict[str, dict[str, Any]] = {}
_callback_lock = threading.Lock()

# Webhook server state
_webhook_server: HTTPServer | None = None
_webhook_port: int = 0
_webhook_lock = threading.Lock()


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
    with threading.Lock():
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
    with threading.Lock():
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


class _CallbackHandler(BaseHTTPRequestHandler):
    """Receives HITLy resume callbacks for command approvals."""

    def log_message(self, format: str, *args: Any) -> None:
        logger.debug(format, *args)

    def do_POST(self) -> None:
        """Handle POST from HITLy resume."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body_bytes = self.rfile.read(content_length)
            body = json.loads(body_bytes.decode("utf-8"))

            approval_id = body.get("id")
            if not approval_id:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Missing id"}')
                return

            with _callback_lock:
                _callback_responses[approval_id] = body

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')
        except Exception as e:
            logger.exception("Callback handler error")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))


def _ensure_webhook_server() -> int:
    """Start local webhook server if not running. Returns the port."""
    global _webhook_server, _webhook_port
    with _webhook_lock:
        if _webhook_server is not None:
            return _webhook_port

        # Find available port
        server = HTTPServer(("127.0.0.1", 0), _CallbackHandler)
        _webhook_port = server.server_address[1]
        _webhook_server = server

        def serve():
            logger.info(f"HITLy callback server listening on port {_webhook_port}")
            _webhook_server.serve_forever()

        thread = threading.Thread(target=serve, name="hitly-webhook", daemon=True)
        thread.start()

        return _webhook_port


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

    # Start webhook server and build resumeUrl
    port = _ensure_webhook_server()
    resume_url = f"http://127.0.0.1:{port}/hitly-callback"

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
                "resumeUrl": resume_url,
                "metadata": {"runId": run_id},
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

    # Wait for callback
    deadline = time.monotonic() + max(timeout - 2, 5)
    while time.monotonic() < deadline:
        with _callback_lock:
            response = _callback_responses.get(approval_id)
        if response:
            decision = response.get("decision")
            if decision in _ACCEPT_DECISIONS:
                # Clean up
                with _callback_lock:
                    _callback_responses.pop(approval_id, None)
                return _respond(request, _accept_choice(request))
            elif decision in _REJECT_DECISIONS:
                with _callback_lock:
                    _callback_responses.pop(approval_id, None)
                return _respond(request, "deny")
        time.sleep(0.5)

    # Timeout
    with _callback_lock:
        _callback_responses.pop(approval_id, None)
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

    # Kanban also uses callback for resume
    port = _ensure_webhook_server()
    resume_url = f"http://127.0.0.1:{port}/hitly-callback"

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
                "resumeUrl": resume_url,
                "metadata": {"taskId": task_id, "runId": run_id},
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


def _apply_kanban_decision(item: dict[str, str], decision_body: dict[str, Any]) -> None:
    task_id = item["task_id"]
    decision = decision_body.get("decision")
    response = decision_body.get("response")
    note = response.strip() if isinstance(response, str) and response.strip() else ""
    if decision in _ACCEPT_DECISIONS:
        _hermes_kanban("comment", task_id, note or "Approved in HITLy.")
        _hermes_kanban("unblock", task_id)
        _drop_kanban(item["approval_id"])
        return
    if decision in _REJECT_DECISIONS:
        _hermes_kanban("comment", task_id, note or f"Rejected in HITLy ({decision}).")
        _drop_kanban(item["approval_id"])
        return


def _kanban_poller_loop(ctx: Any) -> None:
    """Poll for kanban callback responses and apply them."""
    while True:
        try:
            items = list(_load_kanban_items())
            for item in items:
                approval_id = item.get("approval_id")
                if not approval_id:
                    continue

                with _callback_lock:
                    decision_body = _callback_responses.get(approval_id)

                if decision_body:
                    try:
                        _apply_kanban_decision(item, decision_body)
                        with _callback_lock:
                            _callback_responses.pop(approval_id, None)
                    except Exception:
                        logger.exception("Hermes kanban resume failed for %s", item.get("task_id"))
        except Exception:
            logger.exception("Hitly kanban poller iteration failed")
        time.sleep(2)


_kanban_poller_started = False


def _maybe_start_kanban_poller(ctx: Any) -> None:
    global _kanban_poller_started
    if _kanban_poller_started:
        return
    if os.environ.get("HERMES_KANBAN_TASK") or os.environ.get("HERMES_CRON_SESSION"):
        return
    _kanban_poller_started = True
    thread = threading.Thread(target=_kanban_poller_loop, args=(ctx,), name="hitly-kanban-poller", daemon=True)
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
    _maybe_start_kanban_poller(ctx)
