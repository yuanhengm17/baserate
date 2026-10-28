/* Baserate — single-page app. Hash routes: #/  #/login  #/submit  #/status  #/dashboard  #/admin */
(function () {
  const CFG = window.BASERATE_CONFIG || {};
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtPct = (v) => (v == null ? '—' : v.toFixed(1) + '%');
  const fmtNum = (v) => (v == null ? '—' : String(v));

  // ------------------------------------------------------------------ backend
  function SupabaseBackend() {
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(error.message); return data; };
    const one = (d) => (Array.isArray(d) ? d[0] || null : d);
    return {
      isDemo: false,
      async getSession() { const { data } = await sb.auth.getSession(); return data.session; },
      onAuthChange(cb) { sb.auth.onAuthStateChange(() => cb()); },
      async signIn(email) {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw new Error(error.message);
        return { sent: true };
      },
      async signOut() { await sb.auth.signOut(); },
      async getFirms() { const { data, error } = await sb.from('firms').select('id,name,tier,sort_order').eq('active', true).order('sort_order'); if (error) throw new Error(error.message); return data; },
      async getSettings() { const { data, error } = await sb.from('app_settings').select('key,value'); if (error) throw new Error(error.message); return Object.fromEntries(data.map((r) => [r.key, r.value])); },
      async myStatus() { return one(await rpc('my_status')); },
      async submit(sub, rows) {
        const { data: sess } = await sb.auth.getSession();
        const uid = sess?.session?.user?.id; if (!uid) throw new Error('Not signed in.');
        const { data: s, error: e1 } = await sb.from('submissions').insert({ ...sub, user_id: uid }).select('id').single();
        if (e1) throw new Error(e1.message.includes('duplicate') ? 'You already submitted a funnel.' : e1.message);
        const { error: e2 } = await sb.from('submission_firms').insert(rows.map((r) => ({ ...r, submission_id: s.id })));
        if (e2) throw new Error(e2.message);
        return one(await rpc('finalize_submission', { p_submission_id: s.id }));
      },
      async dash() {
        const [summary, firms, networking, referral, profile] = await Promise.all([
          rpc('dash_summary'), rpc('dash_firms'), rpc('dash_networking'), rpc('dash_referral'), rpc('dash_profile')]);
        return { summary: one(summary), firms, networking, referral, profile };
      },
      async adminList() { return rpc('admin_submissions'); },
      async adminSetStatus(id, status, notes) { return rpc('admin_set_status', { p_submission_id: id, p_status: status, p_notes: notes ?? null }); },
      async adminMetrics() { return one(await rpc('admin_metrics')); },
      async adminSetSetting(key, value) { const { error } = await sb.from('app_settings').update({ value }).eq('key', key); if (error) throw new Error(error.message); },
      // ---- tracking ----
      async myTracker() { return one(await rpc('my_tracker')); },
      async upsertMyTracker(gpa, intern) { return rpc('upsert_my_tracker', { p_gpa: gpa, p_intern: intern }); },
      async myOdds() { return rpc('my_odds'); },
      async myChatSeries() { return rpc('my_chat_series'); },
      async myChatLogs() { return rpc('my_chat_logs'); },
      async addChatLog(log) {
        const { data: sess } = await sb.auth.getSession(); const uid = sess?.session?.user?.id; if (!uid) throw new Error('Not signed in.');
        const { error } = await sb.from('chat_logs').insert({ ...log, user_id: uid }); if (error) throw new Error(error.message);
      },
      async deleteChatLog(id) { const { error } = await sb.from('chat_logs').delete().eq('id', id); if (error) throw new Error(error.message); },
      async adminStudyReadout() { return rpc('admin_study_readout'); },
      async adminSetTracker(uid, group, date) { return rpc('admin_set_tracker', { p_user_id: uid, p_group: group, p_sheet_date: date || null }); },
    };
  }

  const useDemo = CFG.DEMO || !CFG.SUPABASE_URL;
  const B = useDemo ? window.DemoBackend : SupabaseBackend();
  $('#mode-badge').textContent = useDemo ? 'Demo mode — synthetic data, no login required' : '';

  // ------------------------------------------------------------------ state
  const S = { session: null, status: null, tracker: null, firms: null, settings: null };
  async function refresh() {
    S.session = await B.getSession();
    S.status = S.session ? await B.myStatus() : null;
    S.tracker = S.session ? await B.myTracker().catch(() => null) : null;
    if (!S.settings) S.settings = await B.getSettings().catch(() => ({}));
    $('#k-foot').textContent = S.settings?.k_anonymity || '5';
  }

  // ------------------------------------------------------------------ nav
  function renderNav(route) {
    const links = [];
    const a = (href, label) => `<a href="${href}" class="${route === href ? 'active' : ''}">${label}</a>`;
    if (S.session) {
      links.push(a('#/track', 'Track chats'));
      if (S.tracker?.can_see_odds && S.tracker?.has_tracker) links.push(a('#/odds', 'My odds'));
      if (S.status?.has_access) links.push(a('#/dashboard', 'Dashboard'));
      else if (S.status?.has_submission) links.push(a('#/status', 'Status'));
      else links.push(a('#/submit', 'Contribute'));
      if (S.status?.is_admin) links.push(a('#/admin', 'Admin'));
      links.push(`<button id="signout" class="link">Sign out</button>`);
    } else {
      links.push(a('#/login', 'Sign in'));
    }
    $('#nav').innerHTML = links.join('');
    const so = $('#signout'); if (so) so.onclick = async () => { await B.signOut(); location.hash = '#/'; };
  }

  // ------------------------------------------------------------------ views
  function viewLanding() {
    const cta = !S.session ? `<a class="btn primary" href="#/login">Sign in with your school email</a>`
      : S.status?.has_access ? `<a class="btn primary" href="#/dashboard">Open the dashboard</a>`
      : S.status?.has_submission ? `<a class="btn primary" href="#/status">Check your status</a>`
      : `<a class="btn primary" href="#/submit">Contribute your funnel</a>`;
    return `
      <h1>Recruit with base rates, not rumors.</h1>
      <p class="lead">Baserate pools anonymized investment-banking recruiting funnels from students who have finished the process, so you can see what actually converts: by firm, by coffee chats, by profile.</p>
      <div class="row">${cta}</div>
      <div class="steps">
        <div><strong>Contribute your funnel.</strong><br><span class="muted">Ten minutes. For every firm you touched: networked, applied, first round, superday, offer. Rejections included — that is the whole point.</span></div>
        <div><strong>We check it, you get in.</strong><br><span class="muted">Submissions are reviewed for internal consistency before unlocking. No names, GPA in bands only, small cells hidden.</span></div>
        <div><strong>See the real conversion rates.</strong><br><span class="muted">What two coffee chats do to your odds at Evercore. Whether referrals matter at bulge brackets. How many firms people like you actually applied to.</span></div>
      </div>
      <p class="small muted">Give-to-get: the dashboard is only visible to people who have contributed. Your individual rows are never shown to anyone, including firms.</p>`;
  }

  function viewLogin() {
    return `
      <h1>Sign in</h1>
      <p class="lead">Use your school email. We send a one-time link; there is no password.</p>
      <form id="login" class="card" style="max-width:460px">
        <label class="field">School email
          <input type="email" name="email" required placeholder="you@${esc(CFG.ALLOWED_DOMAIN_HINT || 'college.harvard.edu')}" autocomplete="email">
        </label>
        <div class="row" style="margin-top:12px"><button class="primary" type="submit">Send sign-in link</button></div>
        <div id="login-msg"></div>
      </form>`;
  }

  function viewStatus() {
    const st = S.status || {};
    if (!st.has_submission) return `<h1>No submission yet</h1><p><a class="btn primary" href="#/submit">Contribute your funnel</a></p>`;
    const map = {
      pending: ['warn', 'Under review', 'Thanks — your funnel is in. Submissions are checked for internal consistency (usually within a day) and then the dashboard unlocks. You will not need to do anything else.'],
      approved: ['good', 'Approved', 'Your funnel is counted in the aggregates and the dashboard is unlocked.'],
      rejected: ['bad', 'Not accepted', 'This submission could not be verified as internally consistent, so it has not been counted. If you think that is a mistake, reply to the email you received.'],
    };
    const [cls, title, body] = map[st.status] || map.pending;
    return `
      <h1>Your submission</h1>
      <div class="notice ${cls}"><strong>${title}</strong><br>${body}</div>
      ${st.status === 'approved' ? `<p><a class="btn primary" href="#/dashboard">Open the dashboard</a></p>` : ''}
      <p class="small muted">Submitted ${st.submitted_at ? new Date(st.submitted_at).toLocaleString() : ''}.</p>`;
  }

  // ---- Submit form
  function viewSubmit() {
    const cycle = S.settings?.current_cycle || 'SA 2027';
    const yrs = []; const y0 = new Date().getFullYear(); for (let y = y0 - 1; y <= y0 + 4; y++) yrs.push(y);
    return `
      <h1>Contribute your funnel</h1>
      <p class="lead">Everything is aggregated. No names are stored with the data, GPA is a band, and any cell with fewer than ${esc(S.settings?.k_anonymity || 5)} people is hidden.</p>
      <form id="submit-form">
        <div class="card">
          <h3>About you</h3>
          <div class="grid">
            <label class="field">Recruiting cycle
              <select name="cycle"><option>${esc(cycle)}</option><option>SA 2026</option><option>SA 2025</option><option>Full-time 2026</option><option>Full-time 2025</option></select></label>
            <label class="field">Class year
              <select name="class_year">${yrs.map((y) => `<option ${y === y0 + 1 ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
            <label class="field">GPA at the time you recruited
              <select name="gpa_band"><option>3.9+</option><option>3.7-3.89</option><option>3.5-3.69</option><option>3.3-3.49</option><option>&lt;3.3</option><option>Prefer not to say</option></select></label>
            <label class="field">Prior finance internship before recruiting?
              <select name="prior_finance_internship"><option value="false">No</option><option value="true">Yes</option></select></label>
            <label class="field">Member of a finance club?
              <select name="finance_club_member"><option value="false">No</option><option value="true">Yes</option></select></label>
            <label class="field">Went through an early-insight / diversity program?
              <select name="diversity_program"><option value="false">No</option><option value="true">Yes</option></select></label>
            <label class="field">How did the cycle end?
              <select name="outcome"><option>Accepted an IB offer</option><option>Had IB offers, chose something else</option><option>No IB offer, took another role</option><option>No IB offer, still searching</option><option>Prefer not to say</option></select></label>
          </div>
        </div>

        <div class="card">
          <h3>Your firms</h3>
          <p class="small muted">One row per firm you touched, even if you only networked and never applied. Tick every stage you reached. Checking a later stage fills in the earlier ones.</p>
          <div class="table-scroll">
          <table id="firm-table">
            <thead><tr>
              <th>Firm</th><th class="num">Coffee chats</th><th class="c">Referral</th>
              <th class="c">Applied</th><th class="c">1st round</th><th class="c">Superday</th><th class="c">Offer</th><th class="c">Accepted</th><th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
          </div>
          <div class="row" style="margin-top:10px">
            <button type="button" id="add-row">+ Add a firm</button>
            <button type="button" id="add-bb">+ Add all bulge brackets</button>
            <button type="button" id="add-eb">+ Add all elite boutiques</button>
          </div>
        </div>

        <div class="notice small">Please include the firms that rejected you. A dataset of only offers is a brag sheet, not a base rate, and submissions with no rejections are flagged for review.</div>
        <div class="row">
          <button class="primary" type="submit" id="submit-btn">Submit my funnel</button>
          <span id="submit-msg" class="small muted"></span>
        </div>
      </form>`;
  }

  function firmOptions(selected) {
    const tiers = ['Bulge Bracket', 'Elite Boutique', 'Middle Market', 'Other'];
    return tiers.map((t) => {
      const fs = S.firms.filter((f) => f.tier === t); if (!fs.length) return '';
      return `<optgroup label="${t}">${fs.map((f) => `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</optgroup>`;
    }).join('') + `<optgroup label="Not listed"><option value="other">Other (type name)</option></optgroup>`;
  }

  function addFirmRow(firmId) {
    const tb = $('#firm-table tbody');
    const tr = document.createElement('tr'); tr.className = 'firmrow';
    tr.innerHTML = `
      <td><select name="firm">${firmOptions(firmId)}</select> <input type="text" name="other" placeholder="Firm name" style="display:none"></td>
      <td class="num"><input type="number" name="chats" min="0" max="50" value="0"></td>
      <td class="c"><input type="checkbox" name="referral"></td>
      <td class="c"><input type="checkbox" name="applied" data-stage="1"></td>
      <td class="c"><input type="checkbox" name="first_round" data-stage="2"></td>
      <td class="c"><input type="checkbox" name="superday" data-stage="3"></td>
      <td class="c"><input type="checkbox" name="offer" data-stage="4"></td>
      <td class="c"><input type="checkbox" name="accepted" data-stage="5"></td>
      <td><button type="button" class="link rm" aria-label="Remove row">✕</button></td>`;
    tb.appendChild(tr);
    const sel = $('select[name=firm]', tr), other = $('input[name=other]', tr);
    sel.onchange = () => { other.style.display = sel.value === 'other' ? '' : 'none'; };
    $('.rm', tr).onclick = () => tr.remove();
    // stage cascade: checking stage n checks 1..n-1; unchecking stage n unchecks n+1..5
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

  function readForm(form) {
    const fd = new FormData(form);
    const sub = {
      cycle: fd.get('cycle'), class_year: +fd.get('class_year'), gpa_band: fd.get('gpa_band'),
      prior_finance_internship: fd.get('prior_finance_internship') === 'true',
      finance_club_member: fd.get('finance_club_member') === 'true',
      diversity_program: fd.get('diversity_program') === 'true',
      outcome: fd.get('outcome'),
    };
    const rows = [...form.querySelectorAll('tr.firmrow')].map((tr) => {
      const v = (n) => $(`[name=${n}]`, tr);
      const firm = v('firm').value;
      return {
        firm_id: firm === 'other' ? null : +firm,
        firm_name_other: firm === 'other' ? v('other').value.trim() : null,
        coffee_chats: Math.max(0, Math.min(50, +v('chats').value || 0)),
        referral: v('referral').checked, applied: v('applied').checked, first_round: v('first_round').checked,
        superday: v('superday').checked, offer: v('offer').checked, accepted: v('accepted').checked,
      };
    });
    return { sub, rows };
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
      const { sub, rows } = readForm(form);
      const bad = rows.find((r) => r.firm_id == null && !r.firm_name_other);
      if (bad) { msg.textContent = 'One of your "Other" rows has no firm name.'; return; }
      const dupes = rows.map((r) => r.firm_id).filter((x, i, a) => x != null && a.indexOf(x) !== i);
      if (dupes.length) { msg.textContent = 'You listed the same firm twice.'; return; }
      if (!rows.length) { msg.textContent = 'Add at least one firm.'; return; }
      btn.disabled = true; msg.textContent = 'Submitting…';
      try {
        const res = await B.submit(sub, rows);
        await refresh();
        location.hash = res.status === 'approved' ? '#/dashboard' : '#/status';
      } catch (err) { msg.textContent = err.message; btn.disabled = false; }
    };
  }

  // ---- Dashboard
  function funnel(r) {
    const base = r.n_applied || 1;
    const bar = (cls, label, n) => `<div class="fbar ${cls}"><span>${label}</span><div class="track"><div class="fill" style="width:${(100 * n) / base}%"></div></div><span class="n">${n} <span class="muted">(${Math.round((100 * n) / base)}%)</span></span></div>`;
    return `<div class="funnel">${bar('s1', 'Applied', r.n_applied)}${bar('s2', '1st round', r.n_first_round)}${bar('s3', 'Superday', r.n_superday)}${bar('s4', 'Offer', r.n_offer)}</div>`;
  }
  function barChart(rows, labelKey, series) {
    // series: [{key, label, cls}] — rendered as grouped horizontal bars, values are percentages
    const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] || 0)));
    return `
      <div class="legend">${series.map((s) => `<span style="--sw: var(${s.cls === 'alt' ? '--s4' : '--accent'})">${s.label}</span>`).join('')}</div>
      <div class="bars">${rows.map((r) => series.map((s, i) => `
        <div class="bar"><span>${i === 0 ? esc(r[labelKey]) : ''}<span class="small muted">${i === 0 && r.n_people != null ? ` n=${r.n_people}` : ''}</span></span>
          <div class="track"><div class="fill ${s.cls}" style="width:${(100 * (r[s.key] || 0)) / max}%"></div></div>
          <span class="v">${fmtPct(r[s.key])}</span></div>`).join('')).join('')}</div>`;
  }

  async function viewDashboard() {
    let d; try { d = await B.dash(); } catch (e) { return `<div class="notice bad">${esc(e.message)}</div>`; }
    if (!d.summary) return `<h1>Dashboard</h1><div class="notice">Not enough approved submissions yet to show aggregates (minimum ${esc(S.settings?.k_anonymity || 5)}). Check back soon.</div>`;
    const s = d.summary;
    const tiers = ['All', ...new Set(d.firms.map((f) => f.tier))];
    return `
      <h1>What actually converts</h1>
      <p class="muted small">Approved submissions only. Each cell needs at least ${esc(S.settings?.k_anonymity || 5)} people; firms below that are pooled by tier.</p>
      <div class="tiles">
        <div class="tile"><div class="v">${s.n_people}</div><div class="l">people contributed</div></div>
        <div class="tile"><div class="v">${s.n_applications}</div><div class="l">applications logged</div></div>
        <div class="tile"><div class="v">${fmtNum(s.median_applications)}</div><div class="l">median firms applied per person</div></div>
        <div class="tile"><div class="v">${fmtPct(s.pct_first_round)}</div><div class="l">applications → first round</div></div>
        <div class="tile"><div class="v">${fmtPct(s.pct_offer)}</div><div class="l">applications → offer</div></div>
        <div class="tile"><div class="v">${fmtPct(s.pct_people_with_offer)}</div><div class="l">people with at least one offer</div></div>
      </div>

      <h2>Does networking move the odds?</h2>
      <div class="card">
        <p class="small muted">Per application, by number of coffee chats at that firm before applying.</p>
        ${d.networking.length ? barChart(d.networking, 'bucket', [{ key: 'pct_first_round', label: 'Reached first round', cls: '' }, { key: 'pct_offer', label: 'Got offer', cls: 'alt' }]) : '<p class="muted">Not enough data yet.</p>'}
      </div>
      <div class="card">
        <p class="small muted">Per application, with vs without a referral.</p>
        ${d.referral.length ? barChart(d.referral, 'label', [{ key: 'pct_first_round', label: 'Reached first round', cls: '' }, { key: 'pct_offer', label: 'Got offer', cls: 'alt' }]) : '<p class="muted">Not enough data yet.</p>'}
      </div>

      <h2>By firm</h2>
      <div class="tabs" id="tier-tabs">${tiers.map((t, i) => `<button class="${i === 0 ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <div class="card table-scroll">
        <table id="firm-stats"><thead><tr><th>Firm</th><th>Funnel (share of applicants reaching each stage)</th><th class="num">Avg chats, got offer</th><th class="num">Avg chats, no offer</th></tr></thead>
        <tbody>${d.firms.map((f) => `<tr data-tier="${esc(f.tier)}"><td><strong>${esc(f.label)}</strong><br><span class="small muted">${esc(f.tier)}</span></td><td>${funnel(f)}</td><td class="num">${fmtNum(f.avg_chats_offer)}</td><td class="num">${fmtNum(f.avg_chats_no_offer)}</td></tr>`).join('')}</tbody></table>
      </div>

      <h2>By profile</h2>
      <div class="card">
        <p class="small muted">Per person: share who reached at least one first round, and share who got at least one offer.</p>
        ${['GPA band', 'Prior finance internship'].map((dim) => {
          const rows = d.profile.filter((p) => p.dimension === dim);
          return `<h3>${dim}</h3>${rows.length ? barChart(rows, 'label', [{ key: 'pct_people_first_round', label: '≥1 first round', cls: '' }, { key: 'pct_people_offer', label: '≥1 offer', cls: 'alt' }]) : '<p class="muted small">Not enough people in each group yet.</p>'}`;
        }).join('')}
      </div>
      <p class="small muted">Self-reported, one school, one cycle at a time. Treat differences of a few points as noise; treat differences of 2× as signal worth acting on.</p>`;
  }
  function wireDashboard() {
    const tabs = $('#tier-tabs'); if (!tabs) return;
    tabs.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('#firm-stats tbody tr').forEach((tr) => { tr.style.display = b.dataset.t === 'All' || tr.dataset.tier === b.dataset.t ? '' : 'none'; });
    };
  }

  // ---- Track coffee chats (the measured behavior)
  const GPA_OPTS = ['3.9+', '3.7-3.89', '3.5-3.69', '3.3-3.49', '<3.3'];
  const todayISO = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10); };
  async function viewTrack() {
    const t = S.tracker || {};
    if (!t.has_tracker) {
      return `
        <h1>Track your coffee chats</h1>
        <p class="lead">Two minutes a week. Log every coffee-chat request you send, whether or not it gets a reply. Your profile is only used to compute your odds; it is never shown with your name.</p>
        <form id="tracker-form" class="card" style="max-width:520px">
          <div class="grid">
            <label class="field">GPA band <select name="gpa">${GPA_OPTS.map((g) => `<option ${g === '3.7-3.89' ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
            <label class="field">Finance internship before recruiting? <select name="intern"><option value="false">No</option><option value="true">Yes</option></select></label>
          </div>
          <div class="row" style="margin-top:12px"><button class="primary" type="submit">Start tracking</button><span id="tracker-msg" class="small muted"></span></div>
        </form>`;
    }
    const [series, logs] = await Promise.all([B.myChatSeries(), B.myChatLogs()]);
    if (!S.firms) S.firms = await B.getFirms();
    const total = logs.reduce((a, l) => a + l.requests, 0), replies = logs.reduce((a, l) => a + l.replies, 0);
    const weeks = series.length;
    const showHigh = t.can_see_odds && t.study_group !== 'comparison';
    const max = Math.max(1, ...series.map((w) => w.requests));
    const chart = series.length ? `
      <div class="legend"><span style="--sw: var(--accent)">All requests</span>${showHigh ? '<span style="--sw: var(--s4)">At your high-odds firms</span>' : ''}</div>
      <div class="bars">${series.map((w) => `
        <div class="bar"><span>Wk of ${esc(new Date(w.week_start + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}<br><span class="small muted">${esc(w.period)}</span></span>
          <div style="display:grid;gap:3px">
            <div class="track"><div class="fill" style="width:${(100 * w.requests) / max}%"></div></div>
            ${showHigh ? `<div class="track"><div class="fill alt" style="width:${(100 * w.requests_high) / max}%"></div></div>` : ''}
          </div>
          <span class="v">${w.requests}${showHigh ? ` <span class="muted">/ ${w.requests_high}</span>` : ''}</span></div>`).join('')}</div>` : '<p class="muted">No requests logged yet. Add your first one below.</p>';
    return `
      <h1>Your coffee-chat requests over time</h1>
      <p class="lead">${t.study_group === 'comparison' ? 'You are in the comparison group: keep logging as usual.' : t.sheet_shown_on ? `Your odds sheet was shown on ${esc(t.sheet_shown_on)}; weeks before that are your baseline.` : 'You are in the baseline period. Keep logging; your odds sheet unlocks when the study moves to the next phase.'}</p>
      <div class="tiles">
        <div class="tile"><div class="v">${total}</div><div class="l">requests logged</div></div>
        <div class="tile"><div class="v">${weeks ? (total / weeks).toFixed(1) : '—'}</div><div class="l">per week</div></div>
        <div class="tile"><div class="v">${total ? Math.round((100 * replies) / total) + '%' : '—'}</div><div class="l">got a reply</div></div>
        <div class="tile"><div class="v">${new Set(logs.map((l) => l.firm)).size}</div><div class="l">firms contacted</div></div>
      </div>
      <h2>Log a request</h2>
      <form id="log-form" class="card row" style="align-items:end">
        <label class="field">Date <input type="date" name="date" value="${todayISO()}" max="${todayISO()}" required></label>
        <label class="field">Firm <select name="firm">${firmOptions()}</select> <input type="text" name="other" placeholder="Firm name" style="display:none;margin-top:4px"></label>
        <label class="field">Requests sent <input type="number" name="requests" min="1" max="20" value="1"></label>
        <label class="field">Replies so far <input type="number" name="replies" min="0" max="20" value="0"></label>
        <button class="primary" type="submit">Log it</button>
        <span id="log-msg" class="small muted"></span>
      </form>
      <h2>By week</h2>
      <div class="card">${chart}</div>
      <h2>Recent requests</h2>
      <div class="card table-scroll"><table><thead><tr><th>Date</th><th>Firm</th><th class="num">Requests</th><th class="num">Replies</th><th></th></tr></thead>
        <tbody>${logs.slice(0, 40).map((l) => `<tr><td class="small">${esc(l.logged_on)}</td><td>${esc(l.firm)}${l.is_high ? ' <span class="pill approved">high odds</span>' : ''}</td><td class="num">${l.requests}</td><td class="num">${l.replies}</td><td><button class="link" data-del-log="${l.id}">remove</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing logged yet.</td></tr>'}</tbody></table></div>
      <details class="small muted" style="margin-top:10px"><summary>Update my profile</summary>
        <form id="tracker-form" class="row" style="margin-top:8px">
          <label class="field">GPA band <select name="gpa">${GPA_OPTS.map((g) => `<option ${g === t.gpa_band ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
          <label class="field">Prior internship <select name="intern"><option value="false" ${!t.prior_finance_internship ? 'selected' : ''}>No</option><option value="true" ${t.prior_finance_internship ? 'selected' : ''}>Yes</option></select></label>
          <button type="submit" style="align-self:end">Save</button><span id="tracker-msg"></span>
        </form></details>`;
  }
  function wireTrack() {
    const tf = $('#tracker-form'); if (tf) tf.onsubmit = async (e) => {
      e.preventDefault(); const fd = new FormData(tf);
      try { await B.upsertMyTracker(fd.get('gpa'), fd.get('intern') === 'true'); await render(); } catch (err) { $('#tracker-msg').textContent = err.message; }
    };
    const lf = $('#log-form'); if (lf) {
      const sel = $('select[name=firm]', lf), other = $('input[name=other]', lf);
      sel.onchange = () => { other.style.display = sel.value === 'other' ? '' : 'none'; };
      lf.onsubmit = async (e) => {
        e.preventDefault(); const fd = new FormData(lf); const msg = $('#log-msg');
        const firm = fd.get('firm');
        if (firm === 'other' && !fd.get('other').trim()) { msg.textContent = 'Type the firm name.'; return; }
        try {
          await B.addChatLog({ logged_on: fd.get('date'), firm_id: firm === 'other' ? null : +firm, firm_name_other: firm === 'other' ? fd.get('other').trim() : null, requests: Math.max(1, Math.min(20, +fd.get('requests') || 1)), replies: Math.max(0, Math.min(20, +fd.get('replies') || 0)) });
          await render();
        } catch (err) { msg.textContent = err.message; }
      };
    }
    $('#app').onclick = async (e) => {
      const b = e.target.closest('[data-del-log]'); if (!b) return;
      b.disabled = true; try { await B.deleteChatLog(isNaN(+b.dataset.delLog) ? b.dataset.delLog : +b.dataset.delLog); await render(); } catch (err) { b.disabled = false; }
    };
  }

  // ---- My odds sheet (the intervention)
  async function viewOdds() {
    const t = S.tracker || {};
    if (!t.has_tracker) return `<h1>Your odds sheet</h1><div class="notice">Set up your tracker first.</div><p><a class="btn primary" href="#/track">Go to tracking</a></p>`;
    if (!t.can_see_odds) return `<h1>Your odds sheet</h1><div class="notice">Not unlocked yet for your account.</div>`;
    const rows = await B.myOdds();
    if (!rows.length) return `<h1>Your odds sheet</h1><div class="notice">Not enough approved funnels yet to compute odds.</div>`;
    const avg = rows[0].avg_rate, avgBasis = rows[0].avg_basis, his = rows.filter((r) => r.is_high);
    const max = Math.max(1, ...rows.map((r) => r.rate || 0));
    return `
      <h1>Where people like you get first rounds</h1>
      <p class="lead">For each firm, the share of applicants with your profile (${esc(t.gpa_band)}, ${t.prior_finance_internship ? 'prior internship' : 'no prior internship'}) who reached a first round. Firms at twice your average or more are marked high odds.</p>
      <div class="tiles">
        <div class="tile"><div class="v">${avg == null ? '—' : avg.toFixed(0) + '%'}</div><div class="l">your average first-round rate (${esc(avgBasis)})</div></div>
        <div class="tile"><div class="v">${his.length}</div><div class="l">high-odds firms</div></div>
      </div>
      ${his.length ? `<div class="notice good"><strong>High odds for you:</strong> ${his.map((h) => esc(h.label)).join(', ')}</div>` : ''}
      <div class="card table-scroll"><table><thead><tr><th>Firm</th><th>First-round rate</th><th class="num">Rate</th><th class="num">n</th><th>Basis</th></tr></thead>
        <tbody>${rows.map((r) => `<tr style="${r.is_high ? 'background:color-mix(in srgb, var(--good) 10%, transparent)' : ''}"><td><strong>${esc(r.label)}</strong><br><span class="small muted">${esc(r.tier)}</span></td>
          <td><div class="bar" style="grid-template-columns:1fr"><div class="track"><div class="fill ${r.is_high ? '' : 'alt'}" style="width:${r.rate == null ? 0 : (100 * r.rate) / max}%"></div></div></div></td>
          <td class="num">${r.rate == null ? '—' : r.rate.toFixed(0) + '%'}</td><td class="num">${r.n}</td><td class="small ${r.basis.startsWith('tier') ? 'muted' : ''}">${esc(r.basis)}${r.is_high ? ' <span class="pill approved">high odds</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">Rates are first rounds per application from approved funnels. A firm only counts as high odds when its rate rests on at least ${esc(S.settings?.k_anonymity || 5)} applications.</p>`;
  }

  // ---- Admin
  async function viewAdmin() {
    if (!S.status?.is_admin) return `<div class="notice bad">Admins only.</div>`;
    let m, list, study; try { [m, list, study] = await Promise.all([B.adminMetrics(), B.adminList(), B.adminStudyReadout()]); } catch (e) { return `<div class="notice bad">${esc(e.message)}</div>`; }
    const tr = study.filter((r) => r.study_group === 'treatment'), cmp = study.filter((r) => r.study_group === 'comparison');
    const passes = tr.filter((r) => r.passes).length;
    const meanRatio = (rs) => { const v = rs.filter((r) => r.ratio != null).map((r) => +r.ratio); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) + '×' : '—'; };
    const studyHtml = `
      <h2>Study readout — does information move effort?</h2>
      <div class="tiles">
        <div class="tile"><div class="v">${passes} / ${tr.length}</div><div class="l">treatment at ≥1.25× (need 6 of 10)</div></div>
        <div class="tile"><div class="v">${meanRatio(tr)}</div><div class="l">mean ratio, treatment</div></div>
        <div class="tile"><div class="v">${meanRatio(cmp)}</div><div class="l">mean ratio, comparison</div></div>
        <div class="tile"><div class="v">${study.reduce((a, r) => a + r.n_logs, 0)}</div><div class="l">requests logged</div></div>
      </div>
      <p class="small muted">Baseline = weekly requests at the participant's high-odds firms before the sheet date; After = the same after it. Set each participant's group and sheet date here; treatment participants see their odds sheet from that date, comparison participants never do.</p>
      <div class="card table-scroll"><table><thead><tr><th>Participant</th><th>Group</th><th>Sheet date</th><th>High-odds firms</th><th class="num">Logs</th><th class="num">Baseline/wk</th><th class="num">After/wk</th><th class="num">Ratio</th><th>Result</th><th></th></tr></thead>
        <tbody>${study.map((r) => `<tr>
          <td>${esc(r.email)}<br><span class="small muted">${esc(r.gpa_band)} · ${r.prior_finance_internship ? 'intern' : 'no intern'}</span></td>
          <td><select data-grp="${esc(r.user_id)}"><option value="treatment" ${r.study_group === 'treatment' ? 'selected' : ''}>Treatment</option><option value="comparison" ${r.study_group === 'comparison' ? 'selected' : ''}>Comparison</option></select></td>
          <td><input type="date" data-date="${esc(r.user_id)}" value="${esc(r.sheet_shown_on || '')}"></td>
          <td class="small">${esc(r.high_firms || '—')}</td>
          <td class="num">${r.n_logs}</td><td class="num">${r.baseline_per_week}</td><td class="num">${r.after_per_week}</td>
          <td class="num">${r.ratio == null ? (r.baseline_per_week == 0 && r.sheet_shown_on ? 'from 0' : '—') : (+r.ratio).toFixed(2) + '×'}</td>
          <td>${!r.sheet_shown_on ? '<span class="pill">baseline</span>' : r.study_group === 'comparison' ? `<span class="pill">${r.ratio != null && r.ratio >= 1.25 ? 'rose without data' : 'flat'}</span>` : r.passes ? '<span class="pill approved">Pass</span>' : '<span class="pill rejected">No change</span>'}</td>
          <td><button data-save-tracker="${esc(r.user_id)}">Save</button></td></tr>`).join('') || '<tr><td colspan="10" class="muted">No participants have started tracking yet.</td></tr>'}</tbody></table></div>`;
    const auto = (S.settings?.auto_approve || 'false') === 'true';
    const flagLabel = { fewer_than_3_applications: '<3 applications', no_rejections: 'no rejections', offer_rate_above_60pct: 'offer rate >60%', stage_without_previous_stage: 'stage order', implausible_coffee_chats: 'chats implausible' };
    return `
      <h1>Review queue</h1>
      <div class="tiles">
        <div class="tile"><div class="v">${m.n_submitted}</div><div class="l">funnels submitted</div></div>
        <div class="tile"><div class="v">${m.n_last_7_days}</div><div class="l">in the last 7 days</div></div>
        <div class="tile"><div class="v">${m.n_pending}</div><div class="l">pending review</div></div>
        <div class="tile"><div class="v">${fmtPct(m.pct_with_rejection)}</div><div class="l">include ≥1 rejection</div></div>
        <div class="tile"><div class="v">${fmtNum(m.median_firms)}</div><div class="l">median firms per funnel</div></div>
        <div class="tile"><div class="v">${fmtNum(m.median_applied)}</div><div class="l">median applications per funnel</div></div>
      </div>
      <p class="small muted">Research-question thresholds: ≥40 of 100 invited within a week · ≥80% include a rejection · median ≥10 firms.</p>
      <div class="row card">
        <button id="approve-clean">Approve all unflagged pending</button>
        <label class="check"><input type="checkbox" id="auto-approve" ${auto ? 'checked' : ''}> Auto-approve unflagged submissions on arrival</label>
        <span id="admin-msg" class="small muted"></span>
      </div>
      <div class="card table-scroll">
        <table><thead><tr><th>Email</th><th>Profile</th><th class="num">Firms</th><th class="num">Applied</th><th class="num">1st</th><th class="num">SD</th><th class="num">Offers</th><th class="num">Chats</th><th>Flags</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((r) => `
          <tr>
            <td>${esc(r.email)}<br><span class="small muted">${new Date(r.created_at).toLocaleDateString()} · ${esc(r.cycle)}</span></td>
            <td class="small">${esc(r.gpa_band)} · ${r.prior_finance_internship ? 'intern' : 'no intern'} · ${r.finance_club_member ? 'club' : 'no club'}<br><span class="muted">${esc(r.outcome)}</span></td>
            <td class="num">${r.n_firms}</td><td class="num">${r.n_applied}</td><td class="num">${r.n_first_round}</td><td class="num">${r.n_superday}</td><td class="num">${r.n_offer}</td><td class="num">${r.total_chats}</td>
            <td>${(r.flags || []).map((f) => `<span class="pill flag">${esc(flagLabel[f] || f)}</span>`).join('') || '<span class="muted small">none</span>'}</td>
            <td><span class="pill ${r.status}">${r.status}</span></td>
            <td style="white-space:nowrap">
              ${r.status !== 'approved' ? `<button data-act="approved" data-id="${r.id}">Approve</button>` : ''}
              ${r.status !== 'rejected' ? `<button class="danger" data-act="rejected" data-id="${r.id}">Reject</button>` : ''}
            </td>
          </tr>`).join('')}</tbody></table>
      </div>
      ${studyHtml}`;
  }
  function wireAdmin() {
    const root = $('#app');
    root.onclick = async (e) => {
      const st = e.target.closest('button[data-save-tracker]');
      if (st) {
        const uid = st.dataset.saveTracker; st.disabled = true;
        try { await B.adminSetTracker(uid, $(`select[data-grp="${uid}"]`).value, $(`input[data-date="${uid}"]`).value || null); await render(); } catch (err) { $('#admin-msg').textContent = err.message; st.disabled = false; }
        return;
      }
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
    const app = $('#app');
    const needAuth = ['#/submit', '#/status', '#/dashboard', '#/admin', '#/track', '#/odds'];
    if (needAuth.includes(route) && !S.session) route = '#/login';
    if (route === '#/dashboard' && !S.status?.has_access) route = S.status?.has_submission ? '#/status' : '#/submit';
    if (route === '#/submit' && S.status?.has_submission) route = '#/status';
    renderNav(route);
    if (route === '#/login') {
      app.innerHTML = viewLogin();
      $('#login').onsubmit = async (e) => {
        e.preventDefault();
        const email = new FormData(e.target).get('email').trim().toLowerCase();
        const msg = $('#login-msg');
        try {
          const r = await B.signIn(email);
          if (r.demo) { location.hash = '#/'; return; }
          msg.innerHTML = `<div class="notice good">Check your inbox for a sign-in link. (Only school addresses are accepted; other domains are rejected before an account is created.)</div>`;
        } catch (err) { msg.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`; }
      };
    } else if (route === '#/submit') {
      if (!S.firms) S.firms = await B.getFirms();
      app.innerHTML = viewSubmit(); wireSubmit();
    } else if (route === '#/track') { if (!S.firms) S.firms = await B.getFirms(); app.innerHTML = await viewTrack(); wireTrack(); }
    else if (route === '#/odds') { app.innerHTML = '<p class="muted">Loading…</p>'; app.innerHTML = await viewOdds(); }
    else if (route === '#/status') app.innerHTML = viewStatus();
    else if (route === '#/dashboard') { app.innerHTML = '<p class="muted">Loading…</p>'; app.innerHTML = await viewDashboard(); wireDashboard(); }
    else if (route === '#/admin') { app.innerHTML = '<p class="muted">Loading…</p>'; app.innerHTML = await viewAdmin(); wireAdmin(); }
    else {
      app.innerHTML = viewLanding();
      if (B.isDemo && S.session) {
        const p = document.createElement('p'); p.className = 'small muted';
        p.innerHTML = `Demo: <button class="link" id="toggle-admin">${S.status?.is_admin ? 'Leave' : 'Enter'} admin mode</button>`;
        app.appendChild(p); $('#toggle-admin').onclick = () => { B.toggleAdmin(); render(); };
      }
    }
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  B.onAuthChange(() => render());
  render().catch((e) => { $('#app').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
})();
