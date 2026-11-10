// ---------------------------------------------------------------------------
// TEMPORARY (MVP pilot with the team and friends): sends every visit, page view and
// action, with the signed-in email, to the team's Google Sheet (tracking/Code.gs).
// Exempt from the privacy rules in CLAUDE.md until it is removed. To remove: delete this
// file, its <script> tag in index.html and EVENTS_URL in config.js. app.js's track() calls
// then do nothing.
// Event names match Code.gs's report: visit, view, click, signup_start, signup_complete,
// gate_seen, firm_open, filter, contribute, tracker_add, tracker_status, tracker_remove,
// session_end.
// ---------------------------------------------------------------------------
(function () {
  const CFG = window.BASERATE_CONFIG || {};
  const ENDPOINT = CFG.EVENTS_URL || '';
  const VERSION = 'baserate-' + (CFG.DEMO || !CFG.SUPABASE_URL ? 'demo' : 'live');

  const store = {
    get(k, d) { try { const v = localStorage.getItem('br_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('br_' + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem('br_' + k); } catch (e) {} },
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem('br_' + k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem('br_' + k, v); } catch (e) {} },
  };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const safeHost = (u) => { try { return new URL(u).hostname; } catch (e) { return 'unknown'; } };
  const view = () => (location.hash || '#/').replace(/^#\/?/, '') || 'home';

  let visitor = store.get('vid', null);
  const isNew = !visitor;
  if (!visitor) { visitor = 'v_' + rid(); store.set('vid', visitor); store.set('first_seen', new Date().toISOString()); }

  const qs = new URLSearchParams(location.search);
  const urlSrc = (qs.get('src') || qs.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 40);
  const otherSite = document.referrer && safeHost(document.referrer) !== location.hostname;
  const firstSrc = store.get('first_src', null) || urlSrc || (otherSite ? 'referral:' + safeHost(document.referrer) : 'direct');
  store.set('first_src', firstSrc);

  let session = ss.get('sid');
  let newSession = false;
  if (!session) { session = 's_' + rid(); ss.set('sid', session); newSession = true; store.set('visits', store.get('visits', 0) + 1); }
  const sessionSrc = urlSrc || ss.get('ssrc') || (otherSite ? 'referral:' + safeHost(document.referrer) : 'direct');
  ss.set('ssrc', sessionSrc);

  const started = Date.now();
  let maxScroll = 0, eventsThisSession = 0, email = '';
  const device = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'mobile' : 'desktop';

  function row(event, detail) {
    return { ts: new Date().toISOString(), event, view: view(), detail: detail || {},
      visitor, session, visit_num: store.get('visits', 1), new_visitor: isNew && newSession,
      src: sessionSrc, first_src: firstSrc, device, referrer: document.referrer ? safeHost(document.referrer) : '',
      email, version: VERSION, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '' };
  }
  function send(event, detail) {
    eventsThisSession++;
    const r = row(event, detail);
    const log = store.get('log', []); log.unshift(r); store.set('log', log.slice(0, 200));
    if (!ENDPOINT) return;
    try { fetch(ENDPOINT, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(r) }).catch(() => {}); } catch (e) {}
  }
  function endSession() {
    if (!ENDPOINT) return;
    const r = row('session_end', { seconds: Math.round((Date.now() - started) / 1000), max_scroll_pct: maxScroll, events: eventsThisSession });
    r.new_visitor = false; r.referrer = '';
    try { navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(r)], { type: 'text/plain' })); } catch (e) {}
  }
  addEventListener('scroll', () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    if (h > 0) maxScroll = Math.max(maxScroll, Math.round((scrollY / h) * 100));
  }, { passive: true });
  let ended = false;
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && !ended) { ended = true; endSession(); } else if (document.visibilityState === 'visible') { ended = false; } });
  addEventListener('pagehide', () => { if (!ended) { ended = true; endSession(); } });

  // clicks on buttons and links, labelled by their text
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, a.btn, nav a, [data-track]');
    if (el) send('click', { target: el.dataset.track || (el.textContent || '').trim().slice(0, 60) || el.id });
  });

  let lastView = null;
  addEventListener('hashchange', () => { const v = view(); if (v !== lastView) { send('view', { from: lastView, to: v }); lastView = v; } });

  window.BaserateEvents = {
    send,
    setEmail(v) { email = v || ''; },
    connected: !!ENDPOINT,
    info: () => ({ visitor, src: sessionSrc, first_src: firstSrc, visits: store.get('visits', 1), log: store.get('log', []) }),
    reset() { ['vid', 'first_src', 'visits', 'first_seen', 'log'].forEach((k) => store.del(k)); try { sessionStorage.clear(); } catch (e) {} },
  };
  lastView = view();
  send('visit', { landing: lastView, returning: !isNew, path: location.pathname });
})();
