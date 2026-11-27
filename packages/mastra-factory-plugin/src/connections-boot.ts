/**
 * The DOM bootstrap injected into the built Factory SPA by
 * scripts/patch-factory-ui.mjs (hitly-net/hitly#218).
 *
 * Upstream Factory has no plugin slot on Settings → Connections, so instead of
 * editing minified React chunks this bootstrap is loaded as a normal module
 * from the plugin's own route (`…/settings/cards/boot.js`, under `/web`, which the
 * SPA fallback never shadows). It watches the SPA for the Connections screen
 * and appends one card per registered connection plugin.
 *
 * Rules this code must keep:
 * - plain browser JavaScript, no imports, no framework — it runs inside a
 *   third-party SPA it does not own;
 * - never throw out of the observer and never break the host page; every
 *   failure is a `console.warn`;
 * - render only server-approved, secret-free strings, and only via
 *   `textContent` — the card data is untrusted input to this DOM;
 * - stay a no-op when the Connections screen (or its anchor) is not found, so
 *   a Factory version drift degrades to "no cards", never to a broken page.
 */

export interface ConnectionsBootConfig {
  /** Plugin settings base, e.g. `/web/integrations/hitly/settings`. */
  basePath: string
  /** Selector candidates used to find the Connections screen anchor. First match wins. */
  anchorSelectors?: string[]
  /** Text patterns matched against headings when no selector matches. */
  anchorTexts?: string[]
  /** Observer tick while the page is still mounting (ms). */
  pollMs?: number
  /** Stop watching after this long if the screen never appears (ms). */
  maxWaitMs?: number
}

export const DEFAULT_ANCHOR_SELECTORS = [
  'main [data-testid="connections-settings"]',
  '[data-testid="connections"]',
  '[data-test="connections"]',
  'main [data-connections]',
]

export const DEFAULT_ANCHOR_TEXTS = ['Connections', 'Integrations']

/** Operator escape hatch: one extra selector tried before the built-in anchors. */
export const ANCHOR_ENV_VAR = 'HITLY_CONNECTION_CARDS_ANCHOR'

function hostEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env ?? {}
}

/** The anchor selectors to bake into the bootstrap, with the operator's override first. */
export function anchorSelectorsWithEnv(
  env: Record<string, string | undefined> = hostEnv(),
  defaults: string[] = DEFAULT_ANCHOR_SELECTORS,
): string[] {
  const extra = (env[ANCHOR_ENV_VAR] ?? '').trim()
  return extra ? [extra, ...defaults] : [...defaults]
}

/** Route the patch script tag points at; the plugin serves it under `/web` so the SPA fallback never wins. */
export const BOOT_SCRIPT_PATH = '/web/integrations/hitly/settings/cards/boot.js'

const CONTAINER_ID = 'hitly-connection-cards'

/**
 * Render the bootstrap as a self-contained classic script. `config` is
 * embedded with JSON.stringify, so no user-supplied text reaches the source.
 */
export function renderConnectionsBootScript(config: ConnectionsBootConfig): string {
  const options = {
    basePath: config.basePath,
    anchorSelectors: config.anchorSelectors ?? DEFAULT_ANCHOR_SELECTORS,
    anchorTexts: config.anchorTexts ?? DEFAULT_ANCHOR_TEXTS,
    pollMs: config.pollMs ?? 250,
    maxWaitMs: config.maxWaitMs ?? 15000,
  }
  return `(function () {
  'use strict';
  if (globalThis.__HITLY_FACTORY_UI_PATCH__ === false) return;
  if (globalThis.__HITLY_CONNECTIONS_BOOTED__) return;
  globalThis.__HITLY_CONNECTIONS_BOOTED__ = true;
  var OPT = ${JSON.stringify(options)};
  var CONTAINER_ID = ${JSON.stringify(CONTAINER_ID)};
  function warn() {
    try { (console.warn || function () {}).apply(console, arguments); } catch (e) { /* ignore */ }
  }
  function headingMatches(el) {
    var text = (el.textContent || '').trim().toLowerCase();
    for (var i = 0; i < OPT.anchorTexts.length; i++) {
      if (text === OPT.anchorTexts[i].toLowerCase()) return true;
    }
    return false;
  }
  function findAnchor() {
    if (!document.body) return null;
    try {
      for (var i = 0; i < OPT.anchorSelectors.length; i++) {
        var hit = document.querySelector(OPT.anchorSelectors[i]);
        if (hit) return hit;
      }
      var headings = document.querySelectorAll('h1, h2, h3');
      for (var j = 0; j < headings.length; j++) {
        if (headingMatches(headings[j])) return headings[j];
      }
    } catch (e) { warn('hitly connections: anchor lookup failed', e); }
    return null;
  }
  function statusClass(status) {
    return 'hitly-card-status hitly-card-status-' + String(status || 'error').replace(/[^a-z0-9-]/g, '-');
  }
  function buildCard(card) {
    var el = document.createElement('div');
    el.className = 'hitly-connection-card';
    el.setAttribute('data-card-id', String(card.id || ''));
    function add(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = text == null ? '' : String(text);
      el.appendChild(node);
      return node;
    }
    var head = document.createElement('div');
    head.className = 'hitly-connection-card-head';
    var icon = document.createElement('span');
    icon.className = 'hitly-card-icon';
    icon.textContent = card.icon || '\\u25CF';
    head.appendChild(icon);
    var name = document.createElement('span');
    name.className = 'hitly-card-name';
    name.textContent = card.name || card.id || '';
    head.appendChild(name);
    var status = document.createElement('span');
    status.className = statusClass(card.status);
    status.textContent = card.label || card.status || '';
    head.appendChild(status);
    el.appendChild(head);
    if (card.description) add('p', 'hitly-card-description', card.description);
    if (card.detail) add('p', 'hitly-card-detail', card.detail);
    if (card.settingsPath) {
      var link = document.createElement('a');
      link.className = 'hitly-card-settings';
      link.href = card.settingsPath;
      link.textContent = 'Open settings';
      el.appendChild(link);
    }
    return el;
  }
  function injectStyles() {
    if (document.getElementById('hitly-connection-card-styles')) return;
    var style = document.createElement('style');
    style.id = 'hitly-connection-card-styles';
    style.textContent = [
      '.hitly-connection-cards{display:flex;flex-wrap:wrap;gap:.75rem;margin:.75rem 0 1.5rem}',
      '.hitly-connection-card{border:1px solid rgba(128,128,128,.35);border-radius:.5rem;padding:.6rem .75rem;min-width:15rem;max-width:22rem;font:inherit}',
      '.hitly-connection-card-head{display:flex;align-items:center;gap:.4rem;font-weight:600}',
      '.hitly-card-status{margin-left:auto;font-size:.75rem;font-weight:500;padding:.05rem .45rem;border-radius:.6rem;border:1px solid rgba(128,128,128,.35)}',
      '.hitly-card-status-connected{color:#1c6b24;background:rgba(28,107,36,.1)}',
      '.hitly-card-status-env-fallback{color:#8a5b00;background:rgba(138,91,0,.1)}',
      '.hitly-card-status-not-connected{color:#666;background:rgba(128,128,128,.12)}',
      '.hitly-card-status-error{color:#a11919;background:rgba(161,25,25,.1)}',
      '.hitly-card-description,.hitly-card-detail{margin:.3rem 0 0;font-size:.8rem;opacity:.85}',
      '.hitly-card-settings{display:inline-block;margin-top:.45rem;font-size:.8rem}'
    ].join('\\n');
    document.head.appendChild(style);
  }
  function render(anchor, cards) {
    var host = anchor.parentElement || anchor;
    var container = document.getElementById(CONTAINER_ID);
    if (!container || !host.contains(container) || container.parentElement !== host) {
      if (container) container.remove();
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.className = 'hitly-connection-cards';
      container.setAttribute('data-hitly-connection-cards', 'true');
      injectStyles();
      host.insertBefore(container, anchor.nextSibling);
    }
    container.textContent = '';
    for (var i = 0; i < cards.length; i++) container.appendChild(buildCard(cards[i]));
    container.style.display = 'flex';
  }
  function fetchCards() {
    return fetch(OPT.basePath + '/cards/api', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('cards endpoint returned ' + res.status);
        return res.json();
      })
      .then(function (data) { return (data && data.cards) || []; });
  }
  var started = Date.now();
  var pending = false;
  var lastCards = null;
  var lastFetchAt = 0;
  function onDomChange() {
    if (pending) return;
    if (Date.now() - lastFetchAt < OPT.pollMs) return;
    var anchor = findAnchor();
    if (!anchor) return;
    var existing = document.getElementById(CONTAINER_ID);
    if (lastCards && existing && existing.parentNode && existing.children.length === lastCards.length) return;
    pending = true;
    lastFetchAt = Date.now();
    if (lastCards) {
      render(anchor, lastCards);
      pending = false;
      return;
    }
    fetchCards().then(function (cards) {
      pending = false;
      if (!cards.length) return;
      lastCards = cards;
      var current = findAnchor();
      if (current) render(current, cards);
    }).catch(function (error) {
      pending = false;
      warn('hitly connections: cards unavailable', error);
    });
  }
  var hasObserver = false;
  if (globalThis.MutationObserver && document.body) {
    try {
      var observer = new MutationObserver(onDomChange);
      observer.observe(document.body, { childList: true, subtree: true });
      hasObserver = true;
    } catch (e) { warn('hitly connections: observer unavailable', e); }
  }
  // The interval covers the screen mounting before the observer attached, and
  // browsers without MutationObserver. With an observer running it is only a
  // grace period: once the cards are up, or the screen has clearly not come,
  // it stops — a Factory page without a Connections screen must not be polled forever.
  var timer = setInterval(function () {
    onDomChange();
    if (!hasObserver) return;
    if (lastCards || Date.now() - started > OPT.maxWaitMs) clearInterval(timer);
  }, OPT.pollMs);
  if (document.readyState === 'complete' || document.readyState === 'interactive') onDomChange();
})();
`;
}
