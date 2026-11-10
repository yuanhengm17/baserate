/* Baserate — single-page app. Hash routes: #/  #/login  #/pipeline  #/submit  #/dashboard  #/odds  #/admin */
(function () {
  const CFG = window.BASERATE_CONFIG || {};
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtPct = (v) => (v == null ? '—' : Math.round(+v) + '%');

  // ------------------------------------------------------------------ backend
  function SupabaseBackend() {
    // Sign-in uses a 6-digit code typed into the page, not a link: school mail scanners
    // (e.g. Microsoft Safe Links) open links before the student does and use them up.
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(error.message); return data; };
    const one = (d) => (Array.isArray(d) ? d[0] || null : d);
    const ok = ({ error }) => { if (error) throw new Error(error.message); };
    const authError = (e) => {
      const m = e.message || '';
      if (/database error|saving new user/i.test(m)) return new Error('Use your school email address. Other addresses cannot sign up.');
      if (/rate limit|seconds/i.test(m)) return new Error('Too many codes requested. Wait a minute, then try again.');
      if (/expired|invalid/i.test(m)) return new Error('That code is wrong or has expired. Request a new one.');
      return new Error(m);
    };
    return {
      isDemo: false,
      async getSession() { const { data } = await sb.auth.getSession(); return data.session; },
      // Supabase calls this inside its auth lock; defer so our own Supabase calls don't deadlock.
      onAuthChange(cb) { sb.auth.onAuthStateChange(() => setTimeout(cb, 0)); },
      async signIn(email) { const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }); if (error) throw authError(error); return { sent: true }; },
      async verifyCode(email, token) { const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' }); if (error) throw authError(error); },
      async signOut() { await sb.auth.signOut(); },
      async getFirms() { const { data, error } = await sb.from('firms').select('id,name,tier,sort_order').eq('active', true).order('sort_order'); if (error) throw new Error(error.message); return data; },
      async getSettings() { const { data, error } = await sb.from('app_settings').select('key,value'); if (error) throw new Error(error.message); return Object.fromEntries(data.map((r) => [r.key, r.value])); },
      async myStatus() { return one(await rpc('my_status')); },
      // ---- my pipeline
      async upsertPipeline(p) {
        return rpc('upsert_my_pipeline', { p_cycle: p.cycle, p_class_year: p.class_year, p_gpa: p.gpa_band, p_intern: p.prior_finance_internship,
          p_club: p.finance_club_member, p_diversity: p.diversity_program, p_share_outreach: p.share_outreach });
      },
      async setShareOutreach(v) { return rpc('set_share_outreach', { p_share: !!v }); },
      async myPipeline() { return rpc('my_pipeline'); },
      async myTouchpoints() { return rpc('my_touchpoints'); },
      async saveFirm(row) {
        const { id, ...fields } = row;
        if (id) { ok(await sb.from('submission_firms').update(fields).eq('id', id)); return id; }
        const { data: sess } = await sb.auth.getSession(); const uid = sess?.session?.user?.id; if (!uid) throw new Error('Not signed in.');
        const { data: s, error: e1 } = await sb.from('submissions').select('id').eq('user_id', uid).single(); if (e1) throw new Error('Start a pipeline first.');
        const { data, error } = await sb.from('submission_firms').insert({ ...fields, submission_id: s.id }).select('id').single();
        if (error) throw new Error(error.message.includes('one_row_per_firm') ? 'That firm is already in your pipeline.' : error.message);
        return data.id;
      },
      async saveNotes(firmId, n) { ok(await sb.from('firm_notes').upsert({ submission_firm_id: firmId, application_url: n.application_url || null, notes: n.notes || null, updated_at: new Date().toISOString() })); },
      async deleteFirm(id) { ok(await sb.from('submission_firms').delete().eq('id', id)); },
      async addTouchpoint(t) { ok(await sb.from('touchpoints').insert(t)); },
      async updateTouchpoint(id, patch) { ok(await sb.from('touchpoints').update(patch).eq('id', id)); },
      async deleteTouchpoint(id) { ok(await sb.from('touchpoints').delete().eq('id', id)); },
      async finalize(outcome) { return one(await rpc('finalize_my_pipeline', { p_outcome: outcome })); },
      async reopen() { return rpc('reopen_my_pipeline'); },
      async deletePipeline() { return rpc('delete_my_pipeline'); },
      // ---- aggregates
      async dash() {
        const [summary, actions, timing, outreach] = await Promise.all([rpc('dash_summary'), rpc('dash_actions'), rpc('dash_timing'), rpc('dash_outreach')]);
        return { summary: one(summary), actions, timing, outreach };
      },
      async outreach() { return rpc('dash_outreach'); },
      async timing() { return rpc('dash_timing'); },
      async myOdds() { return rpc('my_odds'); },
      // ---- admin
      async adminList() { return rpc('admin_submissions'); },
      async adminSetStatus(id, status, notes) { return rpc('admin_set_status', { p_submission_id: id, p_status: status, p_notes: notes ?? null }); },
      async adminMetrics() { return one(await rpc('admin_metrics')); },
      async unlockAdmin(password) { return rpc('unlock_admin', { p_password: password }); },
      async adminSetSetting(key, value) { ok(await sb.from('app_settings').update({ value }).eq('key', key)); },
      async adminSources() { return rpc('admin_sources'); },
      async setMySource(src) { return rpc('set_my_source', { p_src: src }); },
    };
  }

  // DEMO: true → in-browser synthetic backend. DEMO: false needs the Supabase keys; say so
  // instead of silently falling back to the demo.
  const configMissing = !CFG.DEMO && (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY);
  const useDemo = !!CFG.DEMO || configMissing;
  const B = useDemo ? window.DemoBackend : SupabaseBackend();
  $('#mode-badge').textContent = useDemo ? 'Demo mode: synthetic data, nothing leaves your browser' : '';
  if (configMissing) {
    const n = document.createElement('div'); n.className = 'notice bad small config-missing';
    n.innerHTML = '<strong>Not connected yet.</strong> config.js has DEMO set to false but no Supabase URL or key, so this is still the demo. See the README, "Deploy for real".';
    $('#app').before(n);
  }

  // ------------------------------------------------------------------ where visitors come from
  // The ?src= tag on the first link someone used (e.g. ?src=sidechat), or the other site that
  // linked here. Kept in this browser until they sign in, then saved on the account once.
  const SRC_KEY = 'baserate_src';
  const cleanSrc = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_.:-]/g, '').slice(0, 60);
  try {
    const q = new URLSearchParams(location.search);
    let ref = ''; try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch {}
    const src = cleanSrc(q.get('src') || q.get('utm_source')) || (ref && ref !== location.hostname ? cleanSrc('ref:' + ref) : '');
    if (src && !localStorage.getItem(SRC_KEY)) localStorage.setItem(SRC_KEY, src);
  } catch {}
  function sendSource() {
    let src = null; try { src = localStorage.getItem(SRC_KEY); localStorage.removeItem(SRC_KEY); } catch {}
    if (src) B.setMySource(src).catch(() => {});
  }

  // ------------------------------------------------------------------ state
  const S = { session: null, status: null, firms: null, settings: null, login: null };
  async function refresh() {
    S.session = await B.getSession();
    if (S.session) sendSource();
    S.status = S.session ? await B.myStatus() : null;
    // settings are readable only when signed in; until then the defaults apply
    if (!S.settings && S.session) S.settings = await B.getSettings().catch(() => null);
    $('#k-foot').textContent = S.settings?.k_anonymity || '5';
  }
  const kAnon = () => esc(S.settings?.k_anonymity || 5);

  // ------------------------------------------------------------------ labels
  const KIND = { outreach: 'Reached out to someone', coffee_chat: 'Coffee chat or call', info_session: 'Info session', recruiting_event: 'Firm recruiting event', club_event: 'Club event with the firm', other: 'Other' };
  const ACTION = { coffee_chat: 'Coffee chat', outreach: 'Reached out to someone', info_session: 'Info session', recruiting_event: 'Firm recruiting event', club_event: 'Club event with the firm', referral: 'Referral' };
  const LEVEL = { analyst: 'Analyst', associate: 'Associate', vp_plus: 'VP or above', recruiter: 'Recruiter / HR' };
  const CONN = { school_alum: 'Alum of your school', club_alum: 'Alum of your club', friend_family: 'Friend or family', none: 'Cold (no connection)' };
  const FOUND = { alumni_directory: 'Alumni directory', club: 'Through a club', info_session: 'Met at an event', intro: 'Introduced by someone', manual_search: 'Searched on your own' };
  const DIM = { connection: ['Your connection to them', CONN], contact_level: ['Their seniority', LEVEL], found_via: ['How you found them', FOUND] };
  const NEXT = { deadline: 'Application deadline', first_round: 'First round', superday: 'Superday', follow_up: 'Follow up', decision: 'Decision expected' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const GPA_OPTS = ['3.9+', '3.7-3.89', '3.5-3.69', '3.3-3.49', '<3.3', 'Prefer not to say'];
  const OUTCOMES = ['Accepted an IB offer', 'Had IB offers, chose something else', 'No IB offer, took another role', 'No IB offer, still searching', 'Prefer not to say'];
  const PERSON_KINDS = ['outreach', 'coffee_chat'];
  const opts = (map, sel, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') + Object.entries(map).map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

  // ------------------------------------------------------------------ dates (local calendar days)
  const pad = (n) => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const daysSince = (s) => (s ? Math.round((parseISO(todayISO()) - parseISO(s)) / 864e5) : null);
  const fmtDate = (s) => (s ? new Date(parseISO(s)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
  const ago = (s) => { const n = daysSince(s); return n == null ? '' : n === 0 ? 'today' : n === 1 ? 'yesterday' : n > 0 ? `${n}d ago` : `in ${-n}d`; };

  // ------------------------------------------------------------------ nav
  function renderNav(route) {
    const links = [];
    const a = (href, label) => `<a href="${href}" class="${route === href ? 'active' : ''}">${label}</a>`;
    if (S.session) {
      links.push(a('#/pipeline', 'Pipeline'));
      links.push(a('#/dashboard', 'What works'));
      if (S.status?.has_access) links.push(a('#/odds', 'My odds'));
      if (S.status?.is_admin) links.push(a('#/admin', 'Admin'));
      links.push(`<button id="signout" class="link">Sign out</button>`);
    } else {
      links.push(a('#/dashboard', 'What works'));
      links.push(a('#/login', 'Sign in'));
    }
    $('#nav').innerHTML = links.join('');
    const so = $('#signout'); if (so) so.onclick = async () => { await B.signOut(); location.hash = '#/'; };
  }

  // ------------------------------------------------------------------ landing and sign-in
  function viewLanding() {
    return `
      <section class="land">
        <h1>Recruiting for finance?</h1>
        <p class="land-sub">Track every application in one place, and see what actually gets people interviews.</p>
        ${S.session ? '<a class="btn primary big" href="#/pipeline">Open my pipeline</a>'
          : '<a class="btn primary big" href="#/login">Sign up with your school email</a>'}
        ${S.session ? '' : '<p class="land-alt"><a href="#/submit">Already done recruiting? Add your cycle</a></p>'}
        <ol class="how">
          <li><strong>Track your pipeline</strong><span>Add each firm and log coffee chats, outreach and events as they happen.</span></li>
          <li><strong>Give a little</strong><span>Log something in the last ${esc(S.settings?.active_window_days || 30)} days, or add your finished cycle once.</span></li>
          <li><strong>Get the base rates</strong><span>Which actions came before first rounds, who replies, how long each firm takes, and your odds.</span></li>
        </ol>
        <p class="small"><a href="#/dashboard">Preview what you unlock</a></p>
      </section>`;
  }

  // Give-to-get: without access, "What works" and "My odds" show a blurred stand-in and how to
  // unlock it. The stand-in is fixed placeholder text, not data; nothing is fetched.
  function viewLocked() {
    const st = S.status || {};
    const [title, text, href, cta] =
      !S.session ? ['See what actually gets people interviews', 'Sign up with your school email and start your pipeline. That unlocks this page.', '#/login', 'Sign up with your school email']
      : !st.has_submission ? ['Start your pipeline to unlock this', 'A few questions about your profile, about a minute. Anyone tracking their recruiting here sees the numbers.', '#/pipeline', 'Start my pipeline']
      : st.status === 'pending' ? ['Unlocks when your cycle is approved', 'Your finished cycle is in review. Once it is approved, this opens and stays open.', '#/pipeline', 'Open my pipeline']
      : st.status === 'rejected' ? ['Your cycle needs a fix', 'Reopen your pipeline, fix it, and keep logging to see the numbers.', '#/pipeline', 'Open my pipeline']
      : ['Log something to unlock this', `Add a firm or log an action. Anyone who logged something in the last ${esc(S.settings?.active_window_days || 30)} days sees the numbers.`, '#/pipeline', 'Open my pipeline'];
    const fake = [41, 34, 29, 26, 22, 19];
    return `
      <div class="page-h"><h1>What works</h1></div>
      <div class="locked">
        <div class="blur" aria-hidden="true" inert>
          <section class="card"><h2>Which actions help</h2>
            <table class="lean"><tbody>${Object.values(ACTION).map((l, i) => `<tr><td>${esc(l)}</td><td class="num">${fake[i]}%</td><td class="num">${fake[5 - i]}%</td></tr>`).join('')}</tbody></table></section>
          <section class="card"><h2>Who replies to outreach</h2>
            ${Object.values(CONN).map((l, i) => `<div class="rate"><span>${esc(l)}</span><div class="track"><div class="fill" style="width:${70 - i * 15}%"></div></div><span class="v">${70 - i * 15}%</span></div>`).join('')}</section>
        </div>
        <div class="gate"><div class="card">
          <h2>${title}</h2>
          <p class="small muted">${text}</p>
          <a class="btn primary" href="${href}">${cta}</a>
        </div></div>
      </div>`;
  }

  function viewLogin() {
    const L = S.login;
    if (L?.sent) {
      return `
        <h1>Check your email</h1>
        <p class="lead">We sent a sign-in code to <strong>${esc(L.email)}</strong>. Type it here.</p>
        <form id="code-form" class="card narrow">
          <label class="field">Sign-in code
            <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required autofocus placeholder="123456"></label>
          <div class="row" style="margin-top:12px"><button class="primary" type="submit">Sign in</button></div>
          <div id="login-msg">${B.isDemo ? '<p class="small muted">Demo mode: any 6 digits work.</p>' : ''}</div>
        </form>
        <p class="small muted">No email after a minute? Check spam, then <button class="link" id="resend">send a new code</button> or <button class="link" id="restart">use a different email</button>.</p>`;
    }
    return `
      <h1>Sign in</h1>
      <p class="lead">Use your school email. We email you a 6-digit code; there is no password.</p>
      <form id="login" class="card narrow">
        <label class="field">School email
          <input type="email" name="email" required value="${esc(L?.email || '')}" placeholder="you@${esc(CFG.ALLOWED_DOMAIN_HINT || 'college.harvard.edu')}" autocomplete="email"></label>
        <div class="row" style="margin-top:12px"><button class="primary" type="submit">Email me a code</button></div>
        <div id="login-msg"></div>
      </form>`;
  }

  function wireLogin() {
    const msg = (t) => { $('#login-msg').innerHTML = `<div class="notice bad small">${esc(t)}</div>`; };
    const send = async (email, btn) => {
      if (btn) btn.disabled = true;
      try { await B.signIn(email); S.login = { email, sent: true }; await render(); }
      catch (err) { msg(err.message); if (btn) btn.disabled = false; }
    };
    const lf = $('#login');
    if (lf) lf.onsubmit = (e) => { e.preventDefault(); send(new FormData(lf).get('email').trim().toLowerCase(), $('button', lf)); };
    const cf = $('#code-form');
    if (cf) {
      cf.onsubmit = async (e) => {
        e.preventDefault();
        const btn = $('button', cf); btn.disabled = true;
        try { await B.verifyCode(S.login.email, new FormData(cf).get('code').trim()); S.login = null; location.hash = S.next || '#/pipeline'; S.next = null; await render(); }
        catch (err) { msg(err.message); btn.disabled = false; }
      };
      $('#resend').onclick = () => send(S.login.email);
      $('#restart').onclick = () => { S.login = { email: S.login.email }; render(); };
    }
  }

  // ------------------------------------------------------------------ shared form pieces
  function firmOptions(selected, exclude = []) {
    const tiers = ['Bulge Bracket', 'Elite Boutique', 'Middle Market', 'Other'];
    return tiers.map((t) => {
      const fs = S.firms.filter((f) => f.tier === t && !exclude.includes(f.id)); if (!fs.length) return '';
      return `<optgroup label="${t}">${fs.map((f) => `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</optgroup>`;
    }).join('') + `<optgroup label="Not listed"><option value="other">Other (type name)</option></optgroup>`;
  }
  function profileFields(p = {}, { outcome = false, consent = true } = {}) {
    const cycle = S.settings?.current_cycle || 'SA 2027';
    const cycles = [...new Set([p.cycle || cycle, cycle, 'SA 2026', 'SA 2025', 'Full-time 2026', 'Full-time 2025'])];
    const yrs = []; const y0 = new Date().getFullYear(); for (let y = y0 - 1; y <= y0 + 4; y++) yrs.push(y);
    const yn = (name, label, v) => `<label class="field">${label}<select name="${name}"><option value="false" ${!v ? 'selected' : ''}>No</option><option value="true" ${v ? 'selected' : ''}>Yes</option></select></label>`;
    return `
      <div class="grid">
        <label class="field">Recruiting cycle <select name="cycle">${cycles.map((c) => `<option ${c === (p.cycle || cycle) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="field">Class year <select name="class_year">${yrs.map((y) => `<option ${y === (p.class_year || y0 + 1) ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
        <label class="field">GPA band <select name="gpa_band">${GPA_OPTS.map((g) => `<option ${g === (p.gpa_band || '3.7-3.89') ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        ${yn('prior_finance_internship', 'Finance internship before?', p.prior_finance_internship)}
        ${yn('finance_club_member', 'In a finance club?', p.finance_club_member)}
        ${yn('diversity_program', 'Early-insight or diversity program?', p.diversity_program)}
        ${outcome ? `<label class="field">How did it end? <select name="outcome">${OUTCOMES.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>` : ''}
      </div>
      ${consent ? `<label class="check consent"><input type="checkbox" name="share_outreach" ${p.share_outreach ? 'checked' : ''}>
        <span>Count who I reached out to (role and connection, never names) in the anonymous reply rates. <span class="muted">Optional; you can turn it off any time.</span></span></label>`
        : `<input type="hidden" name="share_outreach" value="${p.share_outreach ? 'on' : ''}">`}`;
  }
  const readProfile = (form) => {
    const fd = new FormData(form);
    return { cycle: fd.get('cycle'), class_year: +fd.get('class_year'), gpa_band: fd.get('gpa_band'),
      prior_finance_internship: fd.get('prior_finance_internship') === 'true', finance_club_member: fd.get('finance_club_member') === 'true',
      diversity_program: fd.get('diversity_program') === 'true', share_outreach: !!fd.get('share_outreach') };
  };

  // Person fields for outreach and coffee chats. Categories only: there is no text box.
  function personFields(kind) {
    const yn = (name, label) => `<label class="check"><input type="checkbox" name="${name}"> ${label}</label>`;
    if (!PERSON_KINDS.includes(kind)) return `<div class="row small">${yn('led_to_referral', 'Led to a referral')}</div>`;
    return `
      <div class="grid person">
        <label class="field">Their seniority <select name="contact_level">${opts(LEVEL, null, 'Not sure')}</select></label>
        <label class="field">Your connection <select name="connection">${opts(CONN, null, 'Not sure')}</select></label>
        <label class="field">How you found them <select name="found_via">${opts(FOUND, null, 'Not sure')}</select></label>
      </div>
      <div class="row small">${kind === 'outreach' ? yn('replied', 'Replied') + yn('led_to_chat', 'Led to a chat') : ''}${yn('led_to_referral', 'Led to a referral')}</div>`;
  }
  const readPerson = (form, kind) => {
    const v = (n) => form.querySelector(`[name=${n}]`);
    if (!PERSON_KINDS.includes(kind)) return { led_to_referral: v('led_to_referral')?.checked || null };
    return { contact_level: v('contact_level').value || null, connection: v('connection').value || null, found_via: v('found_via').value || null,
      replied: kind === 'outreach' ? v('replied').checked : null, led_to_chat: kind === 'outreach' ? v('led_to_chat').checked : null,
      led_to_referral: v('led_to_referral').checked };
  };

  // ------------------------------------------------------------------ pipeline
  const STAGES = ['Networking', 'Applied', 'First round', 'Superday', 'Offer', 'Closed'];
  const stageOf = (r) => (r.closed ? 'Closed' : r.offer ? 'Offer' : r.superday ? 'Superday' : r.first_round ? 'First round' : r.applied ? 'Applied' : 'Networking');
  const awaiting = (r) => (r.closed || r.offer ? null : r.superday ? ['superday', r.superday_on] : r.first_round ? ['first round', r.first_round_on] : r.applied ? ['applied', r.applied_on] : null);

  function attentionItems(rows, timing) {
    const typical = Object.fromEntries((timing || []).filter((t) => !t.is_overall).map((t) => [t.label, t.med_days_to_first_round]));
    const overall = (timing || []).find((t) => t.is_overall)?.med_days_to_first_round;
    const items = [];
    rows.forEach((r) => {
      if (r.next_on) {
        const n = daysSince(r.next_on), what = esc(NEXT[r.next_kind] || 'Next step');
        if (n > 0) items.push({ r, sort: -100 + n, cls: 'bad', text: `${what} was ${fmtDate(r.next_on)}. What happened?` });
        else if (n >= -14) items.push({ r, sort: -n, cls: n >= -3 ? 'warn' : '', text: `${what} ${n === 0 ? 'today' : `in ${-n} day${n === -1 ? '' : 's'}`}` });
      }
      const w = awaiting(r);
      if (w && w[0] === 'applied' && w[1]) {
        const n = daysSince(w[1]), usual = typical[r.label] ?? overall;
        if (usual != null && n > usual) items.push({ r, sort: 50 - (n - usual), cls: 'warn', text: `Applied ${n} days ago; first rounds here usually come by day ${usual}` });
        else if (usual == null && n >= 21) items.push({ r, sort: 60, cls: '', text: `Applied ${n} days ago, no first round yet` });
      }
    });
    return items.sort((a, b) => a.sort - b.sort);
  }

  async function viewPipeline() {
    const st = S.status || {};
    if (!st.has_submission) {
      return `
        <h1>Start your pipeline</h1>
        <p class="lead">A few questions so we can compare you with similar students. Never shown with your name.</p>
        <form id="pipeline-setup" class="card">
          ${profileFields({})}
          <div class="row" style="margin-top:14px"><button class="primary" type="submit">Start my pipeline</button><span id="setup-msg" class="small muted"></span></div>
        </form>
        <p class="small muted">Already done recruiting? <a href="#/submit">Add your whole cycle at once</a>.</p>`;
    }
    const [rows, touches, timing, odds] = await Promise.all([B.myPipeline(), B.myTouchpoints(),
      st.has_access ? B.timing().catch(() => []) : [], st.has_access ? B.myOdds().catch(() => []) : []]);
    S.pipe = { rows, touches, odds: new Map(odds.filter((o) => o.rate != null).map((o) => [o.firm_id, o])) };
    const live = st.status === 'in_progress';
    const firmLabel = Object.fromEntries(rows.map((r) => [r.id, r.label]));
    const count = (s) => rows.filter((r) => stageOf(r) === s).length;
    const summary = [`${rows.length} firm${rows.length === 1 ? '' : 's'}`, `${rows.filter((r) => r.applied).length} applied`,
      `${count('First round') + count('Superday')} interviewing`, `${count('Offer')} offer${count('Offer') === 1 ? '' : 's'}`].join(' · ');
    const statusNote = {
      pending: ['warn', 'Under review. Once approved, your cycle counts in the numbers and your access stays on.'],
      approved: ['good', 'Approved. Your cycle counts in the numbers. Thank you.'],
      rejected: ['bad', 'Not accepted: this cycle did not pass the consistency check. Reopen it to fix it.'],
    }[st.status];
    const att = live ? attentionItems(rows, timing).slice(0, 5) : [];
    const card = (r) => {
      const w = awaiting(r);
      const sub = r.next_on ? `<span class="next">${esc(NEXT[r.next_kind] || 'Next')} ${fmtDate(r.next_on)}</span>`
        : w && w[1] ? `<span class="muted">${esc(w[0])} ${ago(w[1])}</span>`
        : r.closed ? `<span class="muted">${r.closed === 'rejected' ? 'rejected' : 'withdrew'}</span>`
        : r.n_outreach ? `<span class="muted">${r.n_replied}/${r.n_outreach} replied</span>` : '';
      const extras = [r.application_url ? `<a href="${esc(r.application_url)}" target="_blank" rel="noopener noreferrer">application ↗</a>` : '', r.notes ? '<span class="muted">notes</span>' : ''].filter(Boolean).join(' · ');
      return `<div class="fcard" data-open-firm="${r.id}" role="button" tabindex="0"><strong>${esc(r.label)}</strong>${sub}${extras ? `<span class="extras">${extras}</span>` : ''}</div>`;
    };
    const recent = touches.slice(0, 6);
    return `
      <div class="page-h"><h1>Pipeline</h1><span class="muted">${summary}</span></div>
      ${statusNote ? `<div class="notice ${statusNote[0]} small">${statusNote[1]}${live ? '' : ' <button class="link" id="reopen">Reopen</button>'}</div>` : ''}
      ${live && !st.has_access ? '<div class="notice small">Log an action or update a firm to unlock "What works" and your odds.</div>' : ''}

      ${att.length ? `<div class="attention">${att.map((i) => `<button class="att ${i.cls}" data-open-firm="${i.r.id}"><strong>${esc(i.r.label)}</strong> ${i.text}</button>`).join('')}</div>` : ''}

      ${live ? `
      <form id="add-firm" class="toolbar">
        <select name="firm" aria-label="Firm">${firmOptions(null, rows.map((r) => r.firm_id).filter(Boolean))}</select>
        <input type="text" name="other" placeholder="Firm name" style="display:none">
        <button type="submit">Add firm</button>
        ${rows.length ? `<button type="button" class="primary" id="log-any">Log an action</button>` : ''}
        ${B.isDemo && !rows.length ? `<button type="button" id="load-sample">Demo: load a sample</button>` : ''}
        <span id="add-firm-msg" class="small muted"></span>
      </form>` : ''}

      ${rows.length ? `<div class="board">${STAGES.map((s) => { const rs = rows.filter((r) => stageOf(r) === s); return `<div class="lane"><div class="lane-h">${s}${rs.length ? ` <span class="muted">${rs.length}</span>` : ''}</div>${rs.map(card).join('')}</div>`; }).join('')}</div>`
        : '<p class="muted">No firms yet. Add the first one above.</p>'}

      ${recent.length ? `
      <h2>Recent actions</h2>
      <div class="actions">${recent.map((t) => `<div class="act">
        <span class="muted small">${t.occurred_on ? fmtDate(t.occurred_on) : '—'}</span>
        <span><strong>${esc(firmLabel[t.submission_firm_id] || '')}</strong> · ${esc(KIND[t.kind])}${t.connection ? ` <span class="muted small">(${esc(CONN[t.connection])})</span>` : ''}</span>
        <span class="small">${t.kind === 'outreach' && live ? `<label class="check"><input type="checkbox" data-tp="${t.id}" data-f="replied" ${t.replied ? 'checked' : ''}> replied</label>` : t.replied ? 'replied' : ''}</span>
        <button class="link small muted" data-del-tp="${t.id}" title="Deleting also removes it from the shared numbers">remove</button></div>`).join('')}</div>` : ''}

      <details class="settings"><summary>Settings</summary>
        <label class="check consent"><input type="checkbox" id="share-toggle" ${st.share_outreach ? 'checked' : ''}>
          <span>Count who I reached out to (role and connection, never names) in the anonymous reply rates.</span></label>
        ${live ? `
        <h3>Profile</h3>
        <form id="profile-form">${profileFields(st, { consent: false })}
          <div class="row" style="margin-top:10px"><button type="submit">Save profile</button><span id="profile-msg" class="small muted"></span></div></form>
        <h3>Done recruiting?</h3>
        <form id="finalize-form" class="row">
          <label class="field">How did it end? <select name="outcome">${OUTCOMES.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>
          <button class="primary" type="submit" style="align-self:end">Finish and share my cycle</button><span id="finalize-msg" class="small muted"></span>
        </form>
        <p class="small muted">After a quick consistency check it joins the anonymous numbers. Please mark the firms that rejected you.</p>` : ''}
        <h3>Delete</h3>
        <button class="danger" id="delete-pipeline">Delete my pipeline and everything in it</button>
      </details>
      <dialog id="firm-dlg"></dialog>
      <dialog id="log-dlg"></dialog>`;
  }

  function firmDialog(r) {
    const tps = S.pipe.touches.filter((t) => t.submission_firm_id === r.id);
    const stage = (name, label, dateName) => `<div class="stage-row"><label class="check"><input type="checkbox" name="${name}" ${r[name] ? 'checked' : ''}> ${label}</label>${dateName ? `<input type="date" name="${dateName}" value="${esc(r[dateName] || '')}" max="${todayISO()}">` : ''}</div>`;
    const o = S.pipe.odds.get(r.firm_id);
    return `
      <form id="firm-form" method="dialog">
        <div class="dlg-h"><h2>${esc(r.label)}</h2><button class="link" value="cancel" formnovalidate aria-label="Close">✕</button></div>
        ${o ? `<p class="small">First-round rate here: <strong>${fmtPct(o.rate)}</strong> <span class="muted">(based on ${esc(o.basis)}; your average across firms is ${fmtPct(o.avg_rate)})</span></p>` : ''}
        ${stage('applied', 'Applied', 'applied_on')}${stage('first_round', 'First round', 'first_round_on')}${stage('superday', 'Superday', 'superday_on')}${stage('offer', 'Offer', 'offer_on')}
        <div class="stage-row"><select name="closed" aria-label="Closed"><option value="">Still open</option><option value="rejected" ${r.closed === 'rejected' ? 'selected' : ''}>Rejected</option><option value="withdrew" ${r.closed === 'withdrew' ? 'selected' : ''}>I withdrew or declined</option></select>
          <input type="date" name="closed_on" value="${esc(r.closed_on || '')}" max="${todayISO()}"></div>
        <div class="stage-row"><select name="next_kind" aria-label="Next step">${opts(NEXT, r.next_kind, 'No next step')}</select><input type="date" name="next_on" value="${esc(r.next_on || '')}"></div>
        <label class="field" style="margin-top:10px">Application or posting link
          <span class="row" style="gap:6px"><input type="url" name="application_url" value="${esc(r.application_url || '')}" placeholder="https://" style="flex:1">${r.application_url ? `<a href="${esc(r.application_url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ''}</span></label>
        <label class="field" style="margin-top:8px">Notes
          <textarea name="notes" rows="4" maxlength="5000" placeholder="Who you talked to, what to follow up on, interview prep…">${esc(r.notes || '')}</textarea></label>
        <p class="small muted" style="margin-top:4px">Private: only you can see notes and links. They are never shared or counted.</p>
        <details class="small"><summary>More</summary>
          ${stage('accepted', 'Accepted the offer')}
          <label class="check"><input type="checkbox" name="referral" ${r.referral ? 'checked' : ''}> I got a referral here</label>
          <p><button type="button" class="link danger" id="rm-firm">Remove this firm</button></p>
        </details>
        <div class="row" style="margin-top:12px"><button class="primary" type="submit" value="save">Save</button><span id="firm-msg" class="small muted"></span></div>
      </form>
      ${tps.length ? `<h3>Actions here</h3><ul class="tp-list">${tps.map((t) => `<li><span class="small muted">${t.occurred_on ? fmtDate(t.occurred_on) : '—'}</span> ${esc(KIND[t.kind])}${t.replied ? ' · replied' : ''}${t.led_to_referral ? ' · referral' : ''}</li>`).join('')}</ul>` : ''}
      ${actionForm(r.id)}`;
  }

  function actionForm(firmId) {
    return `
      <form id="action-form" class="card">
        <h3 style="margin-top:0">Log an action</h3>
        <div class="row">
          ${firmId ? `<input type="hidden" name="sfid" value="${firmId}">` : `<label class="field">Firm <select name="sfid">${S.pipe.rows.map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}</select></label>`}
          <label class="field">What <select name="kind">${opts(KIND, 'outreach')}</select></label>
          <label class="field">Date <input type="date" name="occurred_on" value="${todayISO()}" max="${todayISO()}"></label>
        </div>
        <div id="person-box">${personFields('outreach')}</div>
        <div class="row"><button class="primary" type="submit">Log it</button><span class="small muted">Describe people by role only; names are never stored.</span><span id="action-msg" class="small muted"></span></div>
      </form>`;
  }
  function wireActionForm(dlg) {
    const f = $('#action-form', dlg); if (!f) return;
    const kind = $('select[name=kind]', f), box = $('#person-box', f);
    kind.onchange = () => { box.innerHTML = personFields(kind.value); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      try {
        await B.addTouchpoint({ submission_firm_id: +fd.get('sfid'), kind: fd.get('kind'), occurred_on: fd.get('occurred_on') || null, ...readPerson(f, fd.get('kind')) });
        dlg.close(); await render();
      } catch (err) { $('#action-msg', f).textContent = err.message; }
    };
  }

  function wirePipeline() {
    const setup = $('#pipeline-setup');
    if (setup) {
      setup.onsubmit = async (e) => {
        e.preventDefault();
        try { await B.upsertPipeline(readProfile(setup)); await render(); } catch (err) { $('#setup-msg').textContent = err.message; }
      };
      return;
    }
    const af = $('#add-firm');
    if (af) {
      const sel = $('select[name=firm]', af), other = $('input[name=other]', af);
      sel.onchange = () => { other.style.display = sel.value === 'other' ? '' : 'none'; };
      af.onsubmit = async (e) => {
        e.preventDefault();
        const isOther = sel.value === 'other';
        if (isOther && !other.value.trim()) { $('#add-firm-msg').textContent = 'Type the firm name.'; return; }
        try { await B.saveFirm({ firm_id: isOther ? null : +sel.value, firm_name_other: isOther ? other.value.trim() : null }); await render(); }
        catch (err) { $('#add-firm-msg').textContent = err.message; }
      };
    }
    const sample = $('#load-sample'); if (sample) sample.onclick = async () => { B.loadSample(); await render(); };
    const logAny = $('#log-any'); if (logAny) logAny.onclick = () => { const d = $('#log-dlg'); d.innerHTML = `<div class="dlg-h"><h2>Log an action</h2><button class="link" id="close-log" aria-label="Close">✕</button></div>${actionForm(null)}`; $('#close-log').onclick = () => d.close(); wireActionForm(d); d.showModal(); };
    const reopen = $('#reopen'); if (reopen) reopen.onclick = async () => { await B.reopen(); await render(); };
    $('#share-toggle').onchange = async (e) => { await B.setShareOutreach(e.target.checked); await refresh(); };
    $('#delete-pipeline').onclick = async () => { if (confirm('Delete your whole pipeline? This cannot be undone.')) { await B.deletePipeline(); await render(); } };
    const pf = $('#profile-form'); if (pf) pf.onsubmit = async (e) => { e.preventDefault(); try { await B.upsertPipeline(readProfile(pf)); $('#profile-msg').textContent = 'Saved.'; await refresh(); } catch (err) { $('#profile-msg').textContent = err.message; } };
    const ff = $('#finalize-form'); if (ff) ff.onsubmit = async (e) => {
      e.preventDefault();
      try { await B.finalize(new FormData(ff).get('outcome')); await render(); } catch (err) { $('#finalize-msg').textContent = err.message; }
    };
    const live = S.status?.status === 'in_progress';
    const openFirm = (o) => {
      const r = S.pipe.rows.find((x) => String(x.id) === o.dataset.openFirm); if (!r) return;
      const d = $('#firm-dlg'); d.innerHTML = firmDialog(r); wireFirmDialog(d, r); d.showModal();
    };
    $('#app').onkeydown = (e) => { const o = e.target.closest('.fcard[data-open-firm]'); if (o && live && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFirm(o); } };
    $('#app').onclick = async (e) => {
      if (e.target.closest('a')) return;
      const o = e.target.closest('[data-open-firm]');
      if (o && live) {
        openFirm(o); return;
      }
      const del = e.target.closest('[data-del-tp]');
      if (del) { del.disabled = true; try { await B.deleteTouchpoint(+del.dataset.delTp); await render(); } catch (err) { del.disabled = false; alert(err.message); } }
    };
    $('#app').onchange = async (e) => {
      const cb = e.target.closest('[data-tp]'); if (!cb) return;
      try { await B.updateTouchpoint(+cb.dataset.tp, { [cb.dataset.f]: cb.checked }); await render(); } catch (err) { cb.checked = !cb.checked; alert(err.message); }
    };
  }

  function wireFirmDialog(dlg, r) {
    const f = $('#firm-form', dlg);
    // stage cascade: checking a stage checks the earlier ones; unchecking clears the later ones
    const order = ['applied', 'first_round', 'superday', 'offer', 'accepted'];
    order.forEach((name, i) => {
      const cb = f.elements[name];
      cb.onchange = () => order.forEach((o, j) => { if (cb.checked && j < i) f.elements[o].checked = true; if (!cb.checked && j > i) f.elements[o].checked = false; });
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (e.submitter?.value === 'cancel') { dlg.close(); return; }
      const v = (n) => f.elements[n].value || null, c = (n) => f.elements[n].checked;
      const row = { id: r.id, applied: c('applied'), first_round: c('first_round'), superday: c('superday'), offer: c('offer'), accepted: c('accepted'),
        applied_on: v('applied_on'), first_round_on: v('first_round_on'), superday_on: v('superday_on'), offer_on: v('offer_on'),
        closed: v('closed'), closed_on: v('closed_on'), referral: c('referral'), next_kind: v('next_kind'), next_on: v('next_on') };
      if (row.offer && row.closed === 'rejected') { $('#firm-msg', dlg).textContent = 'A firm cannot be both an offer and a rejection.'; return; }
      ['applied', 'first_round', 'superday', 'offer'].forEach((s) => { if (!row[s]) row[s + '_on'] = null; });
      if (!row.closed) row.closed_on = null;
      if (!row.next_kind) row.next_on = null;
      if (!row.next_on) row.next_kind = null;
      const n = { application_url: v('application_url')?.trim() || null, notes: v('notes')?.trim() || null };
      if (n.application_url && !/^https?:\/\//i.test(n.application_url)) { $('#firm-msg', dlg).textContent = 'Links must start with http:// or https://'; return; }
      try {
        await B.saveFirm(row);
        if ((n.application_url || null) !== (r.application_url || null) || (n.notes || null) !== (r.notes || null)) await B.saveNotes(r.id, n);
        dlg.close(); await render();
      } catch (err) { $('#firm-msg', dlg).textContent = err.message; }
    };
    $('#rm-firm', dlg).onclick = async () => {
      if (!confirm(`Remove ${r.label} and every action logged there?`)) return;
      await B.deleteFirm(r.id); dlg.close(); await render();
    };
    wireActionForm(dlg);
  }

  // ------------------------------------------------------------------ contribute a finished cycle
  function viewSubmit() {
    return `
      <h1>Add your whole cycle</h1>
      <p class="lead">For students who finished recruiting. One row per firm you touched, rejections included.</p>
      <form id="submit-form">
        <div class="card">${profileFields({}, { outcome: true })}</div>
        <div class="card">
          <div class="table-scroll">
          <table id="firm-table">
            <thead><tr><th>Firm</th><th class="num">Coffee chats</th><th class="c">Info session</th><th class="c">Firm event</th><th class="c">Club event</th><th class="c">Referral</th><th class="c">Applied</th><th class="c">1st round</th><th class="c">Superday</th><th class="c">Offer</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
          </div>
          <div class="row" style="margin-top:10px">
            <button type="button" id="add-row">+ Firm</button>
            <button type="button" id="add-bb">+ All bulge brackets</button>
            <button type="button" id="add-eb">+ All elite boutiques</button>
          </div>
          <p class="small muted">Ticking a stage ticks the earlier ones. "+ people" adds who you reached out to at that firm, by role only.</p>
        </div>
        <div class="row">
          <button class="primary" type="submit" id="submit-btn">Submit my cycle</button>
          <span id="submit-msg" class="small muted"></span>
        </div>
      </form>`;
  }

  function personRow() {
    const div = document.createElement('div'); div.className = 'person-line';
    const yn = (name, label) => `<label class="check"><input type="checkbox" name="${name}"> ${label}</label>`;
    div.innerHTML = `<select name="contact_level">${opts(LEVEL, null, 'Seniority?')}</select><select name="connection">${opts(CONN, null, 'Connection?')}</select><select name="found_via">${opts(FOUND, null, 'Found via?')}</select>
      ${yn('replied', 'replied')}${yn('led_to_chat', 'chat')}${yn('led_to_referral', 'referral')}<button type="button" class="link rm-p" aria-label="Remove person">✕</button>`;
    $('.rm-p', div).onclick = () => div.remove();
    return div;
  }

  function addFirmRow(firmId) {
    const tb = $('#firm-table tbody');
    const tr = document.createElement('tr'); tr.className = 'firmrow';
    tr.innerHTML = `
      <td><select name="firm">${firmOptions(firmId)}</select> <input type="text" name="other" placeholder="Firm name" style="display:none"></td>
      <td class="num"><input type="number" name="chats" min="0" max="50" value="0"></td>
      <td class="c"><input type="checkbox" name="info_session"></td>
      <td class="c"><input type="checkbox" name="recruiting_event"></td>
      <td class="c"><input type="checkbox" name="club_event"></td>
      <td class="c"><input type="checkbox" name="referral"></td>
      <td class="c"><input type="checkbox" name="applied" data-stage="1"></td>
      <td class="c"><input type="checkbox" name="first_round" data-stage="2"></td>
      <td class="c"><input type="checkbox" name="superday" data-stage="3"></td>
      <td class="c"><input type="checkbox" name="offer" data-stage="4"></td>
      <td style="white-space:nowrap"><button type="button" class="link add-p">+ people</button> <button type="button" class="link rm" aria-label="Remove row">✕</button></td>`;
    const pr = document.createElement('tr'); pr.className = 'people-row'; pr.style.display = 'none';
    pr.innerHTML = `<td colspan="11"><div class="people"></div></td>`;
    tb.appendChild(tr); tb.appendChild(pr);
    const sel = $('select[name=firm]', tr), other = $('input[name=other]', tr);
    sel.onchange = () => { other.style.display = sel.value === 'other' ? '' : 'none'; };
    $('.rm', tr).onclick = () => { tr.remove(); pr.remove(); };
    $('.add-p', tr).onclick = () => { pr.style.display = ''; $('.people', pr).appendChild(personRow()); };
    tr.querySelectorAll('input[data-stage]').forEach((cb) => {
      cb.onchange = () => {
        const n = +cb.dataset.stage;
        tr.querySelectorAll('input[data-stage]').forEach((o) => {
          const m = +o.dataset.stage;
          if (cb.checked && m < n) o.checked = true;
          if (!cb.checked && m > n) o.checked = false;
        });
      };
    });
  }

  function readSubmitRows(form) {
    return [...form.querySelectorAll('tr.firmrow')].map((tr) => {
      const v = (n) => $(`[name=${n}]`, tr);
      const firm = v('firm').value;
      const people = [...tr.nextElementSibling.querySelectorAll('.person-line')].map((p) => {
        const g = (n) => p.querySelector(`[name=${n}]`);
        return { kind: 'outreach', contact_level: g('contact_level').value || null, connection: g('connection').value || null, found_via: g('found_via').value || null,
          replied: g('replied').checked, led_to_chat: g('led_to_chat').checked, led_to_referral: g('led_to_referral').checked };
      });
      const chats = Array.from({ length: Math.max(0, Math.min(50, +v('chats').value || 0)) }, () => ({ kind: 'coffee_chat' }));
      return {
        firm: { firm_id: firm === 'other' ? null : +firm, firm_name_other: firm === 'other' ? v('other').value.trim() : null,
          referral: v('referral').checked, applied: v('applied').checked, first_round: v('first_round').checked,
          superday: v('superday').checked, offer: v('offer').checked,
          closed: v('applied').checked && !v('offer').checked ? 'rejected' : null },
        actions: [...chats, ...['info_session', 'recruiting_event', 'club_event'].filter((kk) => v(kk).checked).map((kind) => ({ kind })), ...people],
      };
    });
  }

  function wireSubmit() {
    const form = $('#submit-form'); if (!form) return;
    addFirmRow(); addFirmRow(); addFirmRow();
    $('#add-row').onclick = () => addFirmRow();
    $('#add-bb').onclick = () => S.firms.filter((f) => f.tier === 'Bulge Bracket').forEach((f) => addFirmRow(f.id));
    $('#add-eb').onclick = () => S.firms.filter((f) => f.tier === 'Elite Boutique').forEach((f) => addFirmRow(f.id));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const msg = $('#submit-msg'), btn = $('#submit-btn');
      const rows = readSubmitRows(form);
      if (!rows.length) { msg.textContent = 'Add at least one firm.'; return; }
      if (rows.find((r) => r.firm.firm_id == null && !r.firm.firm_name_other)) { msg.textContent = 'One of your "Other" rows has no firm name.'; return; }
      const ids = rows.map((r) => r.firm.firm_id);
      if (ids.some((x, i) => x != null && ids.indexOf(x) !== i)) { msg.textContent = 'You listed the same firm twice.'; return; }
      btn.disabled = true; msg.textContent = 'Submitting…';
      try {
        await B.upsertPipeline(readProfile(form));
        for (const r of rows) {
          const id = await B.saveFirm(r.firm);
          for (const a of r.actions) await B.addTouchpoint({ ...a, submission_firm_id: id });
        }
        await B.finalize(new FormData(form).get('outcome'));
        location.hash = '#/pipeline';
      } catch (err) { msg.textContent = err.message + ' What was saved so far is on your pipeline page.'; btn.disabled = false; }
    };
  }

  // ------------------------------------------------------------------ what works (dashboard)
  const ratio = (a, b) => (a != null && b ? a / b : null);
  const ratioPill = (x) => (x == null ? '' : `<span class="ratio ${x >= 1.25 ? 'up' : x <= 0.8 ? 'down' : ''}">${x.toFixed(1)}×</span>`);

  function replyList(rows) {
    if (!rows.length) return `<p class="muted small">Not enough shared outreach here yet.</p>`;
    return Object.entries(DIM).map(([dim, [title, map]]) => {
      const rs = rows.filter((r) => r.dimension === dim).sort((a, b) => b.pct_replied - a.pct_replied);
      if (!rs.length) return '';
      return `<div class="rates"><h3>${title}</h3>${rs.map((r) => `
        <div class="rate"><span>${esc(map[r.value] || r.value)}</span><div class="track"><div class="fill" style="width:${r.pct_replied}%"></div></div><span class="v">${fmtPct(r.pct_replied)}</span></div>`).join('')}</div>`;
    }).join('');
  }

  async function viewDashboard() {
    let d; try { d = await B.dash(); } catch (e) { return `<div class="notice bad">${esc(e.message)}</div>`; }
    if (!d.summary) return `<h1>What works</h1><div class="notice">Not enough finished cycles yet to show numbers (minimum ${kAnon()} people). Check back soon.</div>`;
    S.dash = d;
    const s = d.summary;
    const acts = Object.keys(ACTION).map((a) => {
      const w = d.actions.find((x) => x.action === a && x.grp === 'With'), wo = d.actions.find((x) => x.action === a && x.grp === 'Without');
      return { a, w, wo, x: ratio(w?.pct_first_round, wo?.pct_first_round) };
    }).sort((p, q) => (q.x ?? -1) - (p.x ?? -1));
    const timing = d.timing.filter((t) => !t.is_overall && t.med_days_to_first_round != null);
    const overall = d.timing.find((t) => t.is_overall);
    const outFirms = [...new Map(d.outreach.filter((r) => r.firm_id != null).map((r) => [r.firm_id, r.label])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const months = (t) => (t.first_round_month_from ? (t.first_round_month_from === t.first_round_month_to ? MONTHS[t.first_round_month_from - 1] : `${MONTHS[t.first_round_month_from - 1]}–${MONTHS[t.first_round_month_to - 1]}`) : '—');
    return `
      <div class="page-h"><h1>What works</h1><span class="muted">${s.n_people} finished cycles · ${s.n_applications} applications · ${fmtPct(s.pct_first_round)} reached a first round</span></div>

      <section class="card">
        <h2>Which actions help</h2>
        <p class="small muted">Share of applications that reached a first round, with vs without each action at that firm beforehand.</p>
        <table class="lean"><thead><tr><th></th><th class="num">Did it</th><th class="num">Didn't</th><th class="num"></th></tr></thead>
          <tbody>${acts.map(({ a, w, wo, x }) => `<tr><td>${esc(ACTION[a])}</td><td class="num">${w ? fmtPct(w.pct_first_round) : '—'}</td><td class="num muted">${wo ? fmtPct(wo.pct_first_round) : '—'}</td><td class="num">${ratioPill(x)}</td></tr>`).join('')}</tbody></table>
        <p class="small muted">Correlation, not cause: people who network more also tend to be stronger candidates.</p>
      </section>

      <section class="card">
        <div class="page-h"><h2>Who replies to outreach</h2>
          <select id="outreach-firm" aria-label="Firm"><option value="">All firms</option>${outFirms.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('')}</select></div>
        <div id="outreach-box">${replyList(d.outreach.filter((r) => r.firm_id == null))}</div>
      </section>

      <section class="card">
        <h2>How long firms take</h2>
        <p class="small muted">Typical days from applying to hearing back${overall?.med_days_to_first_round != null ? `. Across all firms: first round by day ${overall.med_days_to_first_round}, rejection by day ${overall.med_days_to_rejection ?? '—'}` : ''}.</p>
        <table class="lean" id="timing-table"><thead><tr><th>Firm</th><th class="num">First round</th><th class="num">Rejection</th><th class="num">First rounds in</th></tr></thead>
          <tbody>${timing.map((t, i) => `<tr ${i >= 8 ? 'hidden class="more"' : ''}><td>${esc(t.label)}</td><td class="num">day ${t.med_days_to_first_round}</td><td class="num muted">${t.med_days_to_rejection != null ? 'day ' + t.med_days_to_rejection : '—'}</td><td class="num">${months(t)}</td></tr>`).join('')}</tbody></table>
        ${timing.length > 8 ? `<button type="button" class="link small" id="timing-more">Show all ${timing.length} firms</button>` : ''}
      </section>
      <p class="small muted">Only reviewed, finished cycles count. Every number has at least ${kAnon()} people behind it, and no one person makes up more than half of it.</p>`;
  }
  function wireDashboard() {
    const more = $('#timing-more');
    if (more) more.onclick = () => { document.querySelectorAll('#timing-table tr.more').forEach((tr) => { tr.hidden = false; }); more.remove(); };
    const of = $('#outreach-firm');
    if (of) of.onchange = () => { $('#outreach-box').innerHTML = replyList(S.dash.outreach.filter((r) => (of.value ? r.firm_id === +of.value : r.firm_id == null))); };
  }

  // ------------------------------------------------------------------ my odds
  async function viewOdds() {
    if (!S.status?.has_submission) return `<h1>My odds</h1><div class="notice">Start your pipeline first so we know who to compare you with.</div><p><a class="btn primary" href="#/pipeline">Start my pipeline</a></p>`;
    const [rows, outreach, mine] = await Promise.all([B.myOdds(), B.outreach(), B.myPipeline()]);
    if (!rows.length) return `<h1>My odds</h1><div class="notice">Not enough finished cycles yet to compute odds.</div>`;
    const st = S.status, live = st.status === 'in_progress';
    const inPipe = new Set(mine.map((r) => r.firm_id));
    const avg = rows[0].avg_rate, his = rows.filter((r) => r.is_high);
    const bestReply = (firmId) => {
      const b = outreach.filter((o) => o.firm_id === firmId && o.dimension === 'connection').sort((a, c) => c.pct_replied - a.pct_replied)[0];
      return b ? `Best replies: ${esc(CONN[b.value].toLowerCase())}, ${fmtPct(b.pct_replied)}` : '';
    };
    return `
      <div class="page-h"><h1>My odds</h1><span class="muted">${esc(st.gpa_band)} · ${st.prior_finance_internship ? 'prior internship' : 'no prior internship'} · usual first-round rate ${fmtPct(avg)}</span></div>
      ${his.length ? `<p>Firms where students like you reached first rounds at <strong>twice the usual rate</strong> or more:</p>
      <div class="odds">${his.map((h) => `<div class="card odd">
        <div><strong>${esc(h.label)}</strong><div class="small muted">${bestReply(h.firm_id)}</div></div>
        <div class="big">${fmtPct(h.rate)}</div>
        <div>${inPipe.has(h.firm_id) ? '<span class="pill approved">in pipeline</span>' : live ? `<button class="small" data-add-firm="${h.firm_id}">+ Add</button>` : ''}</div></div>`).join('')}</div>`
        : '<div class="notice">No firm stands out for your profile yet; rates are close to the usual one everywhere.</div>'}
      <details class="settings"><summary>All firms</summary>
        <table class="lean"><thead><tr><th>Firm</th><th class="num">First-round rate</th><th>Based on</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}${inPipe.has(r.firm_id) ? ' <span class="pill">in pipeline</span>' : ''}</td><td class="num">${fmtPct(r.rate)}</td><td class="small muted">${esc(r.basis)}</td></tr>`).join('')}</tbody></table>
      </details>`;
  }

  // ------------------------------------------------------------------ admin
  async function viewAdmin() {
    if (!S.status?.is_admin) {
      return `
        <h1>Admin</h1>
        <form id="unlock-form" class="card narrow">
          <label class="field">Admin password <input type="password" name="pw" required autocomplete="current-password"></label>
          <div class="row" style="margin-top:12px"><button class="primary" type="submit">Unlock admin</button><span id="unlock-msg" class="small muted"></span></div>
        </form>`;
    }
    let m, list, sources; try { [m, list, sources] = await Promise.all([B.adminMetrics(), B.adminList(), B.adminSources()]); } catch (e) { return `<div class="notice bad">${esc(e.message)}</div>`; }
    const auto = (S.settings?.auto_approve || 'false') === 'true';
    const flagLabel = { fewer_than_3_applications: '<3 applications', no_rejections: 'no rejections', offer_rate_above_60pct: 'offer rate >60%', stage_without_previous_stage: 'stage order', stage_dates_out_of_order: 'dates out of order', implausible_coffee_chats: 'chats implausible' };
    return `
      <div class="page-h"><h1>Review queue</h1><span class="muted">${m.n_pending} pending · ${m.n_approved} approved · ${m.n_active} people logging now</span></div>
      <details class="card"><summary><strong>Where sign-ups come from</strong></summary>
      <p class="small muted">By the <code>?src=</code> tag on the first link each person used. "ref:" means an untagged link from that site; "untagged" means no tag or a typed address.</p>
      <div class="table-scroll">
        <table class="lean"><thead><tr><th>Source</th><th class="num">Signed up</th><th class="num">Started a pipeline</th><th class="num">Logging now</th><th class="num">Finished</th><th class="num">Approved</th></tr></thead>
        <tbody>${sources.map((s) => `<tr><td>${esc(s.source)}</td><td class="num">${s.n_signed_up}</td><td class="num">${s.n_started}</td><td class="num">${s.n_active}</td><td class="num">${s.n_finished}</td><td class="num">${s.n_approved}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No sign-ups yet.</td></tr>'}</tbody></table>
      </div>
      <div class="toolbar">
        <label class="field">Tag for a new link <input id="src-tag" placeholder="sidechat" value="sidechat"></label>
        <label class="field" style="flex:1;min-width:240px">Link to post <input id="src-link" readonly></label>
        <button type="button" id="src-copy" style="align-self:end">Copy link</button>
      </div>
      <p class="small muted">Use a different tag for every place you post (sidechat, hfac_groupchat, peer_yourname…). Lowercase letters, digits, - and _ only.</p>
      </details>
      <div class="toolbar">
        <button id="approve-clean">Approve all unflagged</button>
        <label class="check"><input type="checkbox" id="auto-approve" ${auto ? 'checked' : ''}> Auto-approve unflagged cycles</label>
        <span id="admin-msg" class="small muted"></span>
      </div>
      <div class="card table-scroll">
        <table><thead><tr><th>Email</th><th>Profile</th><th class="num">Firms</th><th class="num">Applied</th><th class="num">Offers</th><th>Flags</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((r) => `
          <tr>
            <td>${esc(r.email)}<br><span class="small muted">${r.created_at ? new Date(r.created_at).toLocaleDateString() : ''} · ${esc(r.cycle)}</span></td>
            <td class="small">${esc(r.gpa_band)} · ${r.prior_finance_internship ? 'intern' : 'no intern'}<br><span class="muted">${esc(r.outcome)}</span></td>
            <td class="num">${r.n_firms}</td><td class="num">${r.n_applied}</td><td class="num">${r.n_offer}</td>
            <td>${(r.flags || []).map((f) => `<span class="pill flag">${esc(flagLabel[f] || f)}</span>`).join('') || '<span class="muted small">none</span>'}</td>
            <td><span class="pill ${r.status}">${r.status}</span></td>
            <td style="white-space:nowrap">
              ${r.status !== 'approved' ? `<button data-act="approved" data-id="${r.id}">Approve</button>` : ''}
              ${r.status !== 'rejected' ? `<button class="danger" data-act="rejected" data-id="${r.id}">Reject</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">Nothing finished yet.</td></tr>'}</tbody></table>
      </div>
      <p class="small muted">Live pipelines stay private until their owner finishes them. Outreach details and notes are never shown here.</p>

      ${B.isDemo ? '<p class="small"><button class="link" id="leave-admin">Leave admin mode</button></p>' : ''}`;
  }
  function wireAdmin() {
    const uf = $('#unlock-form');
    if (uf) {
      uf.onsubmit = async (e) => {
        e.preventDefault();
        try { if (await B.unlockAdmin(new FormData(uf).get('pw'))) await render(); else $('#unlock-msg').textContent = 'Wrong password.'; }
        catch (err) { $('#unlock-msg').textContent = err.message; }
      };
      return;
    }
    const leave = $('#leave-admin'); if (leave) leave.onclick = () => { B.leaveAdmin(); location.hash = '#/'; };
    const tag = $('#src-tag'), link = $('#src-link');
    const build = () => { const t = cleanSrc(tag.value.trim().replace(/\s+/g, '_')).replace(/[.:]/g, ''); link.value = location.origin + location.pathname + (t ? '?src=' + t : ''); };
    tag.oninput = build; build();
    $('#src-copy').onclick = () => { navigator.clipboard?.writeText(link.value).then(() => { $('#src-copy').textContent = 'Copied'; }, () => link.select()) ?? link.select(); };
    $('#app').onclick = async (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      b.disabled = true;
      try { await B.adminSetStatus(b.dataset.id, b.dataset.act); await render(); } catch (err) { $('#admin-msg').textContent = err.message; b.disabled = false; }
    };
    const ac = $('#approve-clean'); if (ac) ac.onclick = async () => {
      ac.disabled = true;
      const list = await B.adminList();
      for (const r of list.filter((x) => x.status === 'pending' && !(x.flags || []).length)) await B.adminSetStatus(r.id, 'approved');
      await render();
    };
    const aa = $('#auto-approve'); if (aa) aa.onchange = async () => {
      try { await B.adminSetSetting('auto_approve', aa.checked ? 'true' : 'false'); S.settings.auto_approve = aa.checked ? 'true' : 'false'; $('#admin-msg').textContent = 'Saved.'; }
      catch (err) { $('#admin-msg').textContent = err.message; }
    };
  }

  // ------------------------------------------------------------------ router
  async function render() {
    await refresh();
    let route = location.hash || '#/';
    if (route === '#/status' || route === '#/track') route = '#/pipeline';
    const app = $('#app');
    app.onclick = null; app.onchange = null;
    const needAuth = ['#/pipeline', '#/submit', '#/admin'];
    if (needAuth.includes(route) && !S.session) { S.next = route; route = '#/login'; }
    if (route === '#/login' && S.session) route = '#/pipeline';
    if (route === '#/submit' && S.status?.has_submission) route = '#/pipeline';
    const locked = (route === '#/dashboard' || route === '#/odds') && !S.status?.has_access;
    renderNav(locked ? '#/dashboard' : route);
    if (locked) app.innerHTML = viewLocked();
    else if (route === '#/login') { app.innerHTML = viewLogin(); wireLogin(); }
    else if (route === '#/submit') {
      if (!S.firms) S.firms = await B.getFirms();
      app.innerHTML = viewSubmit(); wireSubmit();
    } else if (route === '#/pipeline') {
      if (!S.firms) S.firms = await B.getFirms();
      app.innerHTML = await viewPipeline(); wirePipeline();
    } else if (route === '#/odds') {
      app.innerHTML = await viewOdds();
      app.onclick = async (e) => {
        const b = e.target.closest('[data-add-firm]'); if (!b) return;
        b.disabled = true;
        try { await B.saveFirm({ firm_id: +b.dataset.addFirm, firm_name_other: null }); await render(); } catch (err) { b.textContent = err.message; }
      };
    }
    else if (route === '#/dashboard') { app.innerHTML = await viewDashboard(); wireDashboard(); }
    else if (route === '#/admin') { app.innerHTML = await viewAdmin(); wireAdmin(); }
    else {
      app.innerHTML = viewLanding();

    }
  }

  window.addEventListener('hashchange', () => render().then(() => window.scrollTo(0, 0)));
  B.onAuthChange(() => render());
  render().catch((e) => { $('#app').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
})();
