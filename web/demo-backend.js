// Demo backend: runs entirely in the browser with synthetic data.
// Lets you preview and demo every screen before the Supabase project exists.
// The aggregate logic mirrors the SQL functions in supabase/schema.sql
// (approved-only, k-anonymity suppression, tier roll-ups).
(function () {
  const K = 5;
  const FIRMS = [
    ['Goldman Sachs','Bulge Bracket'],['Morgan Stanley','Bulge Bracket'],['J.P. Morgan','Bulge Bracket'],['Bank of America','Bulge Bracket'],
    ['Citi','Bulge Bracket'],['Barclays','Bulge Bracket'],['Deutsche Bank','Bulge Bracket'],['UBS','Bulge Bracket'],['Wells Fargo','Bulge Bracket'],
    ['RBC Capital Markets','Bulge Bracket'],['Jefferies','Bulge Bracket'],
    ['Evercore','Elite Boutique'],['Centerview Partners','Elite Boutique'],['Lazard','Elite Boutique'],['PJT Partners','Elite Boutique'],
    ['Moelis & Company','Elite Boutique'],['Perella Weinberg Partners','Elite Boutique'],['Guggenheim Securities','Elite Boutique'],
    ['Qatalyst Partners','Elite Boutique'],['Rothschild & Co','Elite Boutique'],['LionTree','Elite Boutique'],['Allen & Company','Elite Boutique'],['Ducera Partners','Elite Boutique'],
    ['Houlihan Lokey','Middle Market'],['William Blair','Middle Market'],['Piper Sandler','Middle Market'],['Baird','Middle Market'],
    ['Lincoln International','Middle Market'],['Raymond James','Middle Market'],['Stifel','Middle Market'],['TD Cowen','Middle Market'],
    ['Harris Williams','Middle Market'],['Solomon Partners','Middle Market'],['Truist Securities','Middle Market'],['KeyBanc Capital Markets','Middle Market'],
    ['BMO Capital Markets','Middle Market'],['Nomura','Middle Market'],['Mizuho','Middle Market'],['BNP Paribas','Middle Market'],['HSBC','Middle Market'],
    ['Macquarie','Middle Market'],['Scotiabank','Middle Market'],['Union Square Advisors','Middle Market'],
  ].map((f, i) => ({ id: i + 1, name: f[0], tier: f[1], sort_order: i }));

  // Deterministic PRNG so the demo looks the same every load
  let seed = 20261004;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const GPA = ['3.9+','3.7-3.89','3.7-3.89','3.5-3.69','3.5-3.69','3.3-3.49','<3.3'];
  const gpaScore = { '3.9+': 1.0, '3.7-3.89': .8, '3.5-3.69': .55, '3.3-3.49': .35, '<3.3': .2, 'Prefer not to say': .5 };
  const tierDifficulty = { 'Bulge Bracket': .55, 'Elite Boutique': .4, 'Middle Market': .8, 'Other': .8 };

  // hidden per-firm affinities so some firms are much better for some profiles (gives the odds sheet signal)
  const affinity = FIRMS.map(() => ({ hiGpa: 0.6 + rnd() * 0.9, loGpa: 0.4 + rnd() * 1.3, intern: 0.6 + rnd() * 1.0, noIntern: 0.4 + rnd() * 1.2 }));
  function synthSubmission(i) {
    const gpa = pick(GPA), intern = rnd() < .35, club = rnd() < .6;
    const nFirms = 6 + Math.floor(rnd() * 14);
    const chosen = [...FIRMS].sort(() => rnd() - .5).slice(0, nFirms);
    const strength = gpaScore[gpa] * (intern ? 1.3 : 1) * (club ? 1.1 : 1);
    const rows = chosen.map((f) => {
      const chats = rnd() < .35 ? 0 : rnd() < .6 ? 1 + Math.floor(rnd() * 2) : 3 + Math.floor(rnd() * 4);
      const referral = chats >= 2 && rnd() < .3;
      const applied = rnd() < .92;
      const af = affinity[f.id - 1];
      const prof = (gpaScore[gpa] >= .8 ? af.hiGpa : af.loGpa) * (intern ? af.intern : af.noIntern);
      const p = Math.min(.95, .18 * strength * prof * tierDifficulty[f.tier] * (1 + .25 * Math.min(chats, 4)) * (referral ? 1.5 : 1));
      const first = applied && rnd() < p * 2.2;
      const sup = first && rnd() < .55;
      const offer = sup && rnd() < .45;
      return { firm_id: f.id, firm_name_other: null, coffee_chats: chats, referral, applied, first_round: first, superday: sup, offer, accepted: false };
    });
    const anyOffer = rows.some((r) => r.offer);
    if (anyOffer) { const o = rows.filter((r) => r.offer); pick(o).accepted = true; }
    return {
      id: 'demo-' + i, email: 'student' + i + '@college.harvard.edu', cycle: 'SA 2026', class_year: 2027 - (i % 2),
      gpa_band: gpa, prior_finance_internship: intern, finance_club_member: club, diversity_program: rnd() < .15,
      outcome: anyOffer ? (rnd() < .85 ? 'Accepted an IB offer' : 'Had IB offers, chose something else') : (rnd() < .6 ? 'No IB offer, took another role' : 'No IB offer, still searching'),
      status: 'approved', flags: [], admin_notes: null, created_at: new Date(Date.now() - i * 36e5 * 7).toISOString(), rows,
    };
  }

  const DB = { submissions: [], settings: { k_anonymity: String(K), current_cycle: 'SA 2027', auto_approve: 'false' } };
  for (let i = 1; i <= 90; i++) DB.submissions.push(synthSubmission(i));
  // a few pending / flagged ones so the admin queue has something to review
  DB.submissions[0].status = 'pending';
  DB.submissions[1].status = 'pending';
  const fake = synthSubmission(99); fake.email = 'suspicious@college.harvard.edu'; fake.status = 'pending';
  fake.rows.forEach((r) => { r.applied = r.first_round = r.superday = r.offer = true; r.coffee_chats = 20; });
  fake.flags = ['no_rejections', 'offer_rate_above_60pct', 'implausible_coffee_chats'];
  DB.submissions.push(fake);

  const LS = 'baserate_demo_me';
  const me = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
  const setMe = (v) => { try { v ? localStorage.setItem(LS, JSON.stringify(v)) : localStorage.removeItem(LS); } catch {} };

  const approved = () => DB.submissions.filter((s) => s.status === 'approved');
  const firmById = (id) => FIRMS.find((f) => f.id === id);
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function computeFlags(rows) {
    const f = [];
    const applied = rows.filter((r) => r.applied);
    const offers = applied.filter((r) => r.offer).length;
    const rejected = applied.filter((r) => !r.offer).length;
    if (applied.length < 3) f.push('fewer_than_3_applications');
    if (applied.length >= 5 && rejected === 0) f.push('no_rejections');
    if (applied.length >= 5 && offers / applied.length > 0.6) f.push('offer_rate_above_60pct');
    if (rows.some((r) => (r.offer && !r.superday) || (r.superday && !r.first_round) || (r.first_round && !r.applied))) f.push('stage_without_previous_stage');
    const chats = rows.map((r) => r.coffee_chats);
    if (Math.max(0, ...chats) > 15 || chats.reduce((a, b) => a + b, 0) > 60) f.push('implausible_coffee_chats');
    return f;
  }

  // ---- coffee-chat tracking (mirrors section 12 of schema.sql) ----
  const todayStr = (off = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - off); return d.toISOString().slice(0, 10); };
  function oddsFor(gpa, intern) {
    const rows = approved().flatMap((s) => s.rows.filter((r) => r.applied && r.firm_id).map((r) => ({ ...r, mine: s.gpa_band === gpa && s.prior_finance_internship === intern })));
    const rate = (rs) => (rs.length ? Math.round((1000 * rs.filter((r) => r.first_round).length) / rs.length) / 10 : null);
    const mine = rows.filter((r) => r.mine);
    const avg_rate = mine.length >= K ? rate(mine) : rate(rows), avg_basis = mine.length >= K ? 'your profile' : 'all profiles';
    const tierRows = {}; FIRMS.forEach((f) => { tierRows[f.tier] = rows.filter((r) => firmById(r.firm_id)?.tier === f.tier); });
    return FIRMS.map((f) => {
      const all = rows.filter((r) => r.firm_id === f.id), m = all.filter((r) => r.mine), t = tierRows[f.tier], tm = t.filter((r) => r.mine);
      let r, basis;
      if (m.length >= K) { r = rate(m); basis = 'your profile'; } else if (all.length >= K) { r = rate(all); basis = 'all profiles'; } else { r = tm.length >= K ? rate(tm) : rate(t); basis = 'tier average (too few at this firm)'; }
      const is_high = all.length >= K && (r || 0) > 0 && avg_rate != null && r >= 2 * avg_rate;
      return { firm_id: f.id, label: f.name, tier: f.tier, rate: r, n: all.length, basis, is_high, avg_rate, avg_basis };
    }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.n - a.n);
  }
  // demo participants (other people) so the admin study table has rows
  DB.trackers = [
    { user_id: 'u-p01', email: 'p01@college.harvard.edu', gpa_band: '3.7-3.89', prior_finance_internship: false, study_group: 'treatment', sheet_shown_on: todayStr(21) },
    { user_id: 'u-p02', email: 'p02@college.harvard.edu', gpa_band: '3.5-3.69', prior_finance_internship: true, study_group: 'treatment', sheet_shown_on: todayStr(21) },
    { user_id: 'u-c01', email: 'c01@college.harvard.edu', gpa_band: '3.7-3.89', prior_finance_internship: false, study_group: 'comparison', sheet_shown_on: todayStr(21) },
  ];
  DB.chat_logs = [];
  (function seedLogs() {
    const plan = { 'u-p01': [1, 3, 2], 'u-p02': [2, 2, 3], 'u-c01': [1, 1, 3] }; // [baseline/wk at high firms, after/wk at high firms, other/wk]
    let id = 1;
    DB.trackers.forEach((t) => {
      let hi = oddsFor(t.gpa_band, t.prior_finance_internship).filter((o) => o.is_high).map((o) => o.firm_id);
      if (!hi.length) hi = FIRMS.filter((f) => f.tier === 'Middle Market').slice(0, 2).map((f) => f.id);
      const others = FIRMS.filter((f) => !hi.includes(f.id)).slice(0, 10);
      const [b, a, o] = plan[t.user_id];
      for (let wk = 0; wk < 5; wk++) {
        const nHi = wk >= 2 ? a : b;
        for (let j = 0; j < nHi; j++) DB.chat_logs.push({ id: id++, user_id: t.user_id, firm_id: hi[j % hi.length], logged_on: todayStr(35 - wk * 7 - Math.floor(rnd() * 6)), requests: 1, replies: rnd() < .35 ? 1 : 0 });
        for (let j = 0; j < o; j++) DB.chat_logs.push({ id: id++, user_id: t.user_id, firm_id: pick(others).id, logged_on: todayStr(35 - wk * 7 - Math.floor(rnd() * 6)), requests: 1, replies: rnd() < .15 ? 1 : 0 });
      }
    });
  })();
  const weeksBetween = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 6048e5));
  function readoutFor(t, logs) {
    let hi = oddsFor(t.gpa_band, t.prior_finance_internship).filter((o) => o.is_high);
    const hiIds = hi.map((o) => o.firm_id);
    const mine = logs.filter((l) => l.user_id === t.user_id);
    const dates = mine.map((l) => l.logged_on).sort();
    const sd = t.sheet_shown_on;
    const before = sd ? mine.filter((l) => hiIds.includes(l.firm_id) && l.logged_on < sd).reduce((s, l) => s + l.requests, 0) : 0;
    const after = sd ? mine.filter((l) => hiIds.includes(l.firm_id) && l.logged_on >= sd).reduce((s, l) => s + l.requests, 0) : 0;
    const bpw = sd && dates.length ? Math.round((100 * before) / weeksBetween(dates[0], sd)) / 100 : 0;
    const apw = sd && dates.length ? Math.round((100 * after) / weeksBetween(sd, dates[dates.length - 1])) / 100 : 0;
    const ratio = bpw > 0 ? Math.round((100 * apw) / bpw) / 100 : null;
    return { user_id: t.user_id, email: t.email, study_group: t.study_group, sheet_shown_on: sd, gpa_band: t.gpa_band, prior_finance_internship: t.prior_finance_internship, high_firms: hi.map((o) => o.label).join(', '), n_logs: mine.length, baseline_per_week: bpw, after_per_week: apw, ratio, passes: sd ? (bpw > 0 ? apw / bpw >= 1.25 : apw >= 2) : false };
  }
  const myTrackerRow = () => { const m = me(); if (!m) return null; return m.tracker ? { user_id: 'me', email: m.email, ...m.tracker } : null; };
  const myLogs = () => { const m = me(); return (m && m.logs) || []; };
  const canSeeOdds = () => { const m = me(); if (!m) return false; const s = DB.submissions.find((x) => x.email === m.email); if (m.admin || (s && s.status === 'approved')) return true; const t = m.tracker; return !!(t && t.study_group === 'treatment' && t.sheet_shown_on && t.sheet_shown_on <= todayStr()); };

  function dash() {
    const subs = approved();
    const rows = subs.flatMap((s) => s.rows.map((r) => ({ ...r, sid: s.id })));
    const app = rows.filter((r) => r.applied);
    const perPerson = subs.map((s) => ({ apps: s.rows.filter((r) => r.applied).length, any: s.rows.some((r) => r.offer) }));
    const summary = subs.length < K ? null : {
      n_people: subs.length, n_firm_rows: rows.length, n_applications: app.length,
      median_applications: median(perPerson.map((p) => p.apps)),
      pct_first_round: pct(app.filter((r) => r.first_round).length, app.length),
      pct_superday: pct(app.filter((r) => r.superday).length, app.length),
      pct_offer: pct(app.filter((r) => r.offer).length, app.length),
      pct_people_with_offer: pct(perPerson.filter((p) => p.any).length, perPerson.length),
    };
    // firms
    const byFirm = new Map();
    app.forEach((r) => {
      const f = firmById(r.firm_id) || { name: 'Other', tier: 'Other' };
      const k = f.name; if (!byFirm.has(k)) byFirm.set(k, { label: f.name, tier: f.tier, is_tier_rollup: false, n_applied: 0, n_first_round: 0, n_superday: 0, n_offer: 0, co: [], cn: [] });
      const b = byFirm.get(k); b.n_applied++; if (r.first_round) b.n_first_round++; if (r.superday) b.n_superday++; if (r.offer) { b.n_offer++; b.co.push(r.coffee_chats); } else b.cn.push(r.coffee_chats);
    });
    const avg = (a) => (a.length ? Math.round((10 * a.reduce((x, y) => x + y, 0)) / a.length) / 10 : null);
    const shown = [], rolled = new Map();
    byFirm.forEach((b) => {
      if (b.n_applied >= K) shown.push({ ...b, avg_chats_offer: avg(b.co), avg_chats_no_offer: avg(b.cn) });
      else { const t = rolled.get(b.tier) || { label: 'Other ' + b.tier + ' firms (small cells pooled)', tier: b.tier, is_tier_rollup: true, n_applied: 0, n_first_round: 0, n_superday: 0, n_offer: 0, avg_chats_offer: null, avg_chats_no_offer: null }; t.n_applied += b.n_applied; t.n_first_round += b.n_first_round; t.n_superday += b.n_superday; t.n_offer += b.n_offer; rolled.set(b.tier, t); }
    });
    const firms = [...shown.sort((a, b) => a.tier.localeCompare(b.tier) || b.n_applied - a.n_applied), ...[...rolled.values()].filter((t) => t.n_applied >= K)];
    // networking
    const buckets = [['0 chats', (c) => c === 0], ['1–2 chats', (c) => c >= 1 && c <= 2], ['3+ chats', (c) => c >= 3]];
    const networking = buckets.map(([bucket, fn], i) => { const rs = app.filter((r) => fn(r.coffee_chats)); const people = new Set(rs.map((r) => r.sid)).size; return { bucket, bucket_order: i, n_applied: rs.length, pct_first_round: pct(rs.filter((r) => r.first_round).length, rs.length), pct_superday: pct(rs.filter((r) => r.superday).length, rs.length), pct_offer: pct(rs.filter((r) => r.offer).length, rs.length), n_people: people }; }).filter((b) => b.n_people >= K);
    const referral = [false, true].map((v) => { const rs = app.filter((r) => !!r.referral === v); return { label: v ? 'With referral' : 'No referral', n_applied: rs.length, pct_first_round: pct(rs.filter((r) => r.first_round).length, rs.length), pct_offer: pct(rs.filter((r) => r.offer).length, rs.length), n_people: new Set(rs.map((r) => r.sid)).size }; }).filter((b) => b.n_people >= K);
    // profile
    const pp = subs.map((s) => ({ gpa: s.gpa_band, intern: s.prior_finance_internship, fr: s.rows.some((r) => r.first_round), of: s.rows.some((r) => r.offer), apps: s.rows.filter((r) => r.applied).length }));
    const order = { '3.9+': 1, '3.7-3.89': 2, '3.5-3.69': 3, '3.3-3.49': 4, '<3.3': 5 };
    const group = (dim, keyFn, labelFn, orderFn) => { const m = new Map(); pp.forEach((p) => { const k = keyFn(p); (m.get(k) || m.set(k, []).get(k)).push(p); }); return [...m.entries()].map(([k, ps]) => ({ dimension: dim, label: labelFn(k), label_order: orderFn(k), n_people: ps.length, pct_people_first_round: pct(ps.filter((p) => p.fr).length, ps.length), pct_people_offer: pct(ps.filter((p) => p.of).length, ps.length), avg_applications: avg(ps.map((p) => p.apps)) })).filter((g) => g.n_people >= K).sort((a, b) => a.label_order - b.label_order); };
    const profile = [...group('GPA band', (p) => p.gpa, (k) => k, (k) => order[k] || 9), ...group('Prior finance internship', (p) => p.intern, (k) => (k ? 'Yes' : 'No'), (k) => (k ? 1 : 2))];
    return { summary, firms, networking, referral, profile };
  }

  window.DemoBackend = {
    isDemo: true,
    async getSession() { const m = me(); return m ? { user: { email: m.email } } : null; },
    onAuthChange(cb) { this._cb = cb; },
    async signIn(email) { setMe({ email }); this._cb && this._cb(); return { demo: true }; },
    async signOut() { setMe(null); this._cb && this._cb(); },
    async getFirms() { return FIRMS; },
    async getSettings() { return { ...DB.settings }; },
    async myStatus() {
      const m = me(); const s = m && DB.submissions.find((x) => x.email === m.email);
      return { has_submission: !!s, status: s ? s.status : null, has_access: !!(s && s.status === 'approved') || !!(m && m.admin), is_admin: !!(m && m.admin), submitted_at: s ? s.created_at : null };
    },
    async submit(sub, rows) {
      const m = me(); if (!m) throw new Error('Not signed in');
      if (DB.submissions.some((x) => x.email === m.email)) throw new Error('You already submitted a funnel.');
      if (!rows.length) throw new Error('Add at least one firm before submitting.');
      const flags = computeFlags(rows);
      const auto = DB.settings.auto_approve === 'true';
      const status = auto && !flags.length ? 'approved' : 'pending';
      DB.submissions.unshift({ id: 'demo-me', email: m.email, ...sub, status, flags, admin_notes: null, created_at: new Date().toISOString(), rows });
      return { status, flags };
    },
    async dash() { return dash(); },
    async adminList() { return DB.submissions.map((s) => ({ id: s.id, email: s.email, cycle: s.cycle, class_year: s.class_year, gpa_band: s.gpa_band, prior_finance_internship: s.prior_finance_internship, finance_club_member: s.finance_club_member, outcome: s.outcome, status: s.status, flags: s.flags, admin_notes: s.admin_notes, created_at: s.created_at, n_firms: s.rows.length, n_applied: s.rows.filter((r) => r.applied).length, n_first_round: s.rows.filter((r) => r.first_round).length, n_superday: s.rows.filter((r) => r.superday).length, n_offer: s.rows.filter((r) => r.offer).length, total_chats: s.rows.reduce((a, r) => a + r.coffee_chats, 0) })).sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.created_at.localeCompare(a.created_at)); },
    async adminSetStatus(id, status, notes) { const s = DB.submissions.find((x) => x.id === id); if (s) { s.status = status; if (notes != null) s.admin_notes = notes; } },
    async adminMetrics() { const all = DB.submissions; const per = all.map((s) => ({ st: s.status, nf: s.rows.length, na: s.rows.filter((r) => r.applied).length, rej: s.rows.some((r) => r.applied && !r.offer), recent: Date.now() - Date.parse(s.created_at) < 7 * 864e5 })); return { n_submitted: all.length, n_approved: per.filter((p) => p.st === 'approved').length, n_pending: per.filter((p) => p.st === 'pending').length, n_rejected: per.filter((p) => p.st === 'rejected').length, pct_with_rejection: pct(per.filter((p) => p.rej).length, per.length), median_firms: median(per.map((p) => p.nf)), median_applied: median(per.map((p) => p.na)), n_last_7_days: per.filter((p) => p.recent).length }; },
    async adminSetSetting(key, value) { DB.settings[key] = value; },
    // ---- tracking ----
    async myTracker() { const t = myTrackerRow(); return { has_tracker: !!t, gpa_band: t?.gpa_band ?? null, prior_finance_internship: t?.prior_finance_internship ?? null, study_group: t?.study_group ?? null, sheet_shown_on: t?.sheet_shown_on ?? null, can_see_odds: canSeeOdds() }; },
    async upsertMyTracker(gpa, intern) { const m = me(); if (!m) throw new Error('Not signed in'); m.tracker = { ...(m.tracker || { study_group: 'treatment', sheet_shown_on: null }), gpa_band: gpa, prior_finance_internship: intern }; setMe(m); },
    async myOdds() { const t = myTrackerRow(); if (!t || !canSeeOdds()) return []; return oddsFor(t.gpa_band, t.prior_finance_internship); },
    async myChatSeries() {
      const t = myTrackerRow(); if (!t) return [];
      const hi = oddsFor(t.gpa_band, t.prior_finance_internship).filter((o) => o.is_high).map((o) => o.firm_id);
      const weeks = new Map();
      myLogs().forEach((l) => {
        const d = new Date(l.logged_on + 'T00:00:00'); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); const wk = d.toISOString().slice(0, 10);
        const period = t.study_group === 'comparison' ? 'comparison' : t.sheet_shown_on && l.logged_on >= t.sheet_shown_on ? 'after' : 'baseline';
        const key = wk + '|' + period; const w = weeks.get(key) || { week_start: wk, requests: 0, requests_high: 0, replies: 0, period };
        w.requests += l.requests; if (hi.includes(l.firm_id)) w.requests_high += l.requests; w.replies += l.replies; weeks.set(key, w);
      });
      return [...weeks.values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
    },
    async myChatLogs() {
      const t = myTrackerRow(); const hi = t ? oddsFor(t.gpa_band, t.prior_finance_internship).filter((o) => o.is_high).map((o) => o.firm_id) : [];
      return [...myLogs()].sort((a, b) => b.logged_on.localeCompare(a.logged_on) || b.id - a.id).map((l) => ({ id: l.id, logged_on: l.logged_on, firm: firmById(l.firm_id)?.name || l.firm_name_other, requests: l.requests, replies: l.replies, is_high: hi.includes(l.firm_id) && canSeeOdds() }));
    },
    async addChatLog(log) { const m = me(); if (!m) throw new Error('Not signed in'); m.logs = m.logs || []; m.logs.push({ id: Date.now(), ...log }); setMe(m); },
    async deleteChatLog(id) { const m = me(); if (!m) return; m.logs = (m.logs || []).filter((l) => l.id !== id); setMe(m); },
    async adminStudyReadout() {
      const rows = DB.trackers.map((t) => readoutFor(t, DB.chat_logs));
      const mine = myTrackerRow(); if (mine) rows.push(readoutFor(mine, myLogs().map((l) => ({ ...l, user_id: 'me' }))));
      return rows.sort((a, b) => a.study_group.localeCompare(b.study_group) || a.email.localeCompare(b.email));
    },
    async adminSetTracker(uid, group, date) {
      if (uid === 'me') { const m = me(); if (m && m.tracker) { m.tracker.study_group = group; m.tracker.sheet_shown_on = date; setMe(m); } return; }
      const t = DB.trackers.find((x) => x.user_id === uid); if (t) { t.study_group = group; t.sheet_shown_on = date; }
    },
    // demo-only: toggle admin for the current demo user
    toggleAdmin() { const m = me(); if (m) { m.admin = !m.admin; setMe(m); } },
  };
})();
