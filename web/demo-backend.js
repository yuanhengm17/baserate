// Demo backend: runs entirely in the browser with synthetic data.
// Lets you preview and demo every screen before the Supabase project exists.
// The access rules and aggregate logic mirror supabase/schema.sql (approved-only,
// k people per cell, no person over max_cell_share of a cell, tier roll-ups,
// outreach details only from people who opted in).
(function () {
  const K = 5, MAX_SHARE = 0.5;
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
  const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  // ---- dates (local calendar days as 'YYYY-MM-DD')
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const daysBetween = (a, b) => { const [x, y] = [parse(a), parse(b)]; return Math.round((Date.UTC(y.getFullYear(), y.getMonth(), y.getDate()) - Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())) / 864e5); };
  const today = () => iso(new Date());
  const monthOf = (s) => +s.slice(5, 7);

  const GPA = ['3.9+','3.7-3.89','3.7-3.89','3.5-3.69','3.5-3.69','3.3-3.49','<3.3'];
  const gpaScore = { '3.9+': 1.0, '3.7-3.89': .8, '3.5-3.69': .55, '3.3-3.49': .35, '<3.3': .2, 'Prefer not to say': .5 };
  const tierDifficulty = { 'Bulge Bracket': .55, 'Elite Boutique': .4, 'Middle Market': .8, 'Other': .8 };
  // when each tier recruits (SA 2026 cycle) and how fast each firm answers
  const tierWindow = { 'Bulge Bracket': ['2025-01-06', 40], 'Elite Boutique': ['2024-12-02', 60], 'Middle Market': ['2025-02-03', 75] };
  const firmSpeed = FIRMS.map(() => 10 + Math.floor(rnd() * 30));
  const replyBase = { school_alum: .5, club_alum: .62, friend_family: .8, none: .1 };
  const levelMult = { analyst: 1.15, associate: 1, vp_plus: .55, recruiter: .7 };

  // hidden per-firm affinities so some firms are much better for some profiles (gives the odds sheet signal)
  const affinity = FIRMS.map(() => ({ hiGpa: 0.6 + rnd() * 0.9, loGpa: 0.4 + rnd() * 1.3, intern: 0.6 + rnd() * 1.0, noIntern: 0.4 + rnd() * 1.2 }));
  let nextId = 1;
  function synthOutreach(dated, appliedOn) {
    const connection = pick(['school_alum', 'school_alum', 'club_alum', 'friend_family', 'none', 'none', 'none']);
    const contact_level = pick(['analyst', 'analyst', 'associate', 'vp_plus', 'recruiter']);
    const found_via = connection === 'club_alum' ? 'club' : connection === 'friend_family' ? 'intro' : pick(['alumni_directory', 'alumni_directory', 'manual_search', 'info_session', 'intro']);
    const replied = rnd() < Math.min(.95, replyBase[connection] * levelMult[contact_level] * (found_via === 'intro' ? 1.3 : 1));
    const led_to_chat = replied && rnd() < .75;
    const led_to_referral = led_to_chat && rnd() < (connection === 'none' ? .08 : .22);
    return { id: nextId++, kind: 'outreach', occurred_on: dated ? addDays(appliedOn, -between(15, 70)) : null, contact_level, connection, found_via, replied, led_to_chat, led_to_referral };
  }
  function synthSubmission(i) {
    const gpa = pick(GPA), intern = rnd() < .35, club = rnd() < .6;
    const dated = rnd() < .6;   // tracked live (has dates) vs filled in afterwards
    const nFirms = 6 + Math.floor(rnd() * 14);
    const chosen = [...FIRMS].sort(() => rnd() - .5).slice(0, nFirms);
    const strength = gpaScore[gpa] * (intern ? 1.3 : 1) * (club ? 1.1 : 1);
    const rows = chosen.map((f) => {
      const [w0, wn] = tierWindow[f.tier];
      const appliedOn = addDays(w0, between(0, wn));
      const touches = [];
      const chats = rnd() < .35 ? 0 : rnd() < .6 ? 1 + Math.floor(rnd() * 2) : 3 + Math.floor(rnd() * 4);
      for (let c = 0; c < chats; c++) touches.push({ id: nextId++, kind: 'coffee_chat', occurred_on: dated ? addDays(appliedOn, -between(5, 60)) : null });
      const nOut = rnd() < .3 ? 0 : between(1, 4);
      for (let o = 0; o < nOut; o++) touches.push(synthOutreach(dated, appliedOn));
      const info = rnd() < .4, event = rnd() < .2, clubEv = club && rnd() < .35;
      if (info) touches.push({ id: nextId++, kind: 'info_session', occurred_on: dated ? addDays(appliedOn, -between(10, 50)) : null });
      if (event) touches.push({ id: nextId++, kind: 'recruiting_event', occurred_on: dated ? addDays(appliedOn, -between(10, 50)) : null });
      if (clubEv) touches.push({ id: nextId++, kind: 'club_event', occurred_on: dated ? addDays(appliedOn, -between(10, 80)) : null });
      const referral = touches.some((t) => t.led_to_referral) || (chats >= 2 && rnd() < .3);
      const applied = rnd() < .92;
      const af = affinity[f.id - 1];
      const prof = (gpaScore[gpa] >= .8 ? af.hiGpa : af.loGpa) * (intern ? af.intern : af.noIntern);
      const p = Math.min(.95, .18 * strength * prof * tierDifficulty[f.tier] * (1 + .25 * Math.min(chats, 4)) * (referral ? 1.5 : 1) * (event ? 1.25 : 1) * (clubEv ? 1.1 : 1) * (info ? 1.03 : 1));
      const first = applied && rnd() < p * 2.2;
      const sup = first && rnd() < .55;
      const offer = sup && rnd() < .45;
      const r = { id: nextId++, firm_id: f.id, firm_name_other: null, referral, applied, first_round: first, superday: sup, offer, accepted: false,
        closed: applied && !offer ? (rnd() < .93 ? 'rejected' : 'withdrew') : null,
        applied_on: null, first_round_on: null, superday_on: null, offer_on: null, closed_on: null, next_on: null, next_kind: null, touches };
      if (dated && applied) {
        r.applied_on = appliedOn;
        if (first) r.first_round_on = addDays(appliedOn, Math.max(3, firmSpeed[f.id - 1] + between(-6, 8)));
        if (sup) r.superday_on = addDays(r.first_round_on, between(6, 20));
        if (offer) r.offer_on = addDays(r.superday_on, between(1, 6));
        if (r.closed) r.closed_on = addDays(r.superday_on || r.first_round_on || appliedOn, r.superday_on ? between(2, 8) : r.first_round_on ? between(5, 15) : between(20, 60));
      }
      if (!applied) touches.forEach((t) => { if (t.occurred_on == null && dated) t.occurred_on = addDays(appliedOn, -between(5, 40)); });
      return r;
    });
    const anyOffer = rows.some((r) => r.offer);
    if (anyOffer) { const o = rows.filter((r) => r.offer); pick(o).accepted = true; }
    return {
      id: 'demo-' + i, email: 'student' + i + '@college.harvard.edu', cycle: 'SA 2026', class_year: 2027 - (i % 2),
      gpa_band: gpa, prior_finance_internship: intern, finance_club_member: club, diversity_program: rnd() < .15,
      outcome: anyOffer ? (rnd() < .85 ? 'Accepted an IB offer' : 'Had IB offers, chose something else') : (rnd() < .6 ? 'No IB offer, took another role' : 'No IB offer, still searching'),
      share_outreach: rnd() < .8, status: 'approved', flags: [], admin_notes: null,
      finalized_at: new Date(Date.now() - i * 36e5 * 7).toISOString(), rows,
    };
  }

  const DB = { submissions: [], settings: { k_anonymity: String(K), max_cell_share: String(MAX_SHARE), current_cycle: 'SA 2027', auto_approve: 'false', active_window_days: '30', active_min_days: '1' } };
  for (let i = 1; i <= 90; i++) DB.submissions.push(synthSubmission(i));
  // a few pending / flagged ones so the admin queue has something to review
  DB.submissions[0].status = 'pending';
  DB.submissions[1].status = 'pending';
  const fake = synthSubmission(99); fake.email = 'suspicious@college.harvard.edu'; fake.status = 'pending';
  fake.rows.forEach((r) => { r.applied = r.first_round = r.superday = r.offer = true; r.closed = null; for (let c = 0; c < 18; c++) r.touches.push({ id: nextId++, kind: 'coffee_chat', occurred_on: null }); });
  fake.flags = ['no_rejections', 'offer_rate_above_60pct', 'implausible_coffee_chats'];
  DB.submissions.push(fake);
  // other people's live pipelines: only counted on the admin page, never shown
  DB.live = Array.from({ length: 14 }, (_, i) => ({ lastActive: addDays(today(), -(i < 10 ? between(0, 20) : between(35, 80))) }));

  const LS = 'baserate_demo_me_v2';
  const me = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
  const setMe = (v) => { try { v ? localStorage.setItem(LS, JSON.stringify(v)) : localStorage.removeItem(LS); } catch {} };
  const save = (m) => { m.activity = [...new Set([...(m.activity || []), today()])]; setMe(m); };
  const setting = (k, d) => { const v = parseInt(DB.settings[k], 10); return isNaN(v) ? d : v; };
  const k = () => setting('k_anonymity', K);
  const maxShare = () => { const v = parseFloat(DB.settings.max_cell_share); return isNaN(v) ? MAX_SHARE : v; };

  // my pipeline as a submission object shaped like the synthetic ones
  function mySub() {
    const m = me(); if (!m || !m.sub) return null;
    return { ...m.sub, id: 'demo-me', email: m.email, rows: (m.firms || []).map((f) => ({ ...f, touches: (m.touches || []).filter((t) => t.submission_firm_id === f.id) })) };
  }
  const allSubs = () => { const s = mySub(); return s ? [s, ...DB.submissions] : DB.submissions; };
  const approved = () => allSubs().filter((s) => s.status === 'approved');
  const firmById = (id) => FIRMS.find((f) => f.id === id);
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const avg = (a) => (a.length ? Math.round((10 * a.reduce((x, y) => x + y, 0)) / a.length) / 10 : null);
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pctDisc = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(p * s.length) - 1)]; };
  const cmpC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // byte order, like collate "C" in the SQL
  const groupBy = (xs, keyFn) => { const m = new Map(); xs.forEach((x) => { const kk = keyFn(x); (m.get(kk) || m.set(kk, []).get(kk)).push(x); }); return m; };
  // the cell rule: at least k people, and nobody over max_cell_share of the rows
  const cellOk = (rows) => {
    const per = [...groupBy(rows, (r) => r.sid).values()].map((g) => g.length);
    return per.length >= k() && Math.max(...per) <= maxShare() * rows.length;
  };

  // ---- access (mirrors is_active_logger / has_access)
  function isActiveLogger() {
    const m = me(); if (!m || !m.sub || m.sub.status !== 'in_progress') return false;
    const since = addDays(today(), -setting('active_window_days', 30));
    return (m.activity || []).filter((d) => d > since).length >= setting('active_min_days', 1);
  }
  function hasAccess() { const m = me(); if (!m) return false; return !!m.admin || m.sub?.status === 'approved' || isActiveLogger(); }

  function computeFlags(rows) {
    const f = [];
    const applied = rows.filter((r) => r.applied);
    const offers = applied.filter((r) => r.offer).length;
    const rejected = applied.filter((r) => !r.offer).length;
    if (applied.length < 3) f.push('fewer_than_3_applications');
    if (applied.length >= 5 && rejected === 0) f.push('no_rejections');
    if (applied.length >= 5 && offers / applied.length > 0.6) f.push('offer_rate_above_60pct');
    if (rows.some((r) => (r.offer && !r.superday) || (r.superday && !r.first_round) || (r.first_round && !r.applied))) f.push('stage_without_previous_stage');
    const lt = (a, b) => a && b && a < b;
    if (rows.some((r) => lt(r.first_round_on, r.applied_on) || lt(r.superday_on, r.first_round_on) || lt(r.offer_on, r.superday_on))) f.push('stage_dates_out_of_order');
    const chats = rows.map((r) => r.touches.filter((t) => t.kind === 'coffee_chat').length);
    if (Math.max(0, ...chats) > 15 || chats.reduce((a, b) => a + b, 0) > 60) f.push('implausible_coffee_chats');
    return f;
  }

  // ---- aggregates (mirror section 9 of schema.sql)
  function appRows() { return approved().flatMap((s) => s.rows.map((r) => ({ ...r, sid: s.id, share: s.share_outreach }))); }

  function dashSummary() {
    const subs = approved(); const rows = appRows(); const app = rows.filter((r) => r.applied);
    const perPerson = subs.map((s) => ({ apps: s.rows.filter((r) => r.applied).length, any: s.rows.some((r) => r.offer) }));
    const apps = perPerson.map((p) => p.apps);
    if (subs.length < k() || Math.max(...apps) > maxShare() * apps.reduce((a, b) => a + b, 0)) return null;
    return {
      n_people: subs.length, n_firm_rows: rows.length, n_applications: app.length,
      median_applications: median(apps),
      pct_first_round: pct(app.filter((r) => r.first_round).length, app.length),
      pct_superday: pct(app.filter((r) => r.superday).length, app.length),
      pct_offer: pct(app.filter((r) => r.offer).length, app.length),
      pct_people_with_offer: pct(perPerson.filter((p) => p.any).length, perPerson.length),
      n_actions: rows.reduce((a, r) => a + r.touches.length, 0),
    };
  }

  const ACTIONS = [['coffee_chat', 1], ['outreach', 2], ['info_session', 3], ['recruiting_event', 4], ['club_event', 5], ['referral', 6]];
  function dashActions() {
    const app = appRows().filter((r) => r.applied);
    const before = (r) => r.touches.filter((t) => t.occurred_on == null || r.applied_on == null || t.occurred_on <= r.applied_on);
    const cells = [];
    app.forEach((r) => {
      const b = before(r);
      ACTIONS.forEach(([action, order]) => {
        const has = (action === 'referral' && r.referral) || b.some((t) => t.kind === action);
        cells.push({ action, action_order: order, grp: has ? 'With' : 'Without', grp_order: has ? 1 : 2, sid: r.sid, first_round: r.first_round, offer: r.offer });
      });
      const n = b.filter((t) => t.kind === 'coffee_chat').length;
      cells.push({ action: 'coffee_chat_count', action_order: 0, grp: n === 0 ? '0 chats' : n <= 2 ? '1–2 chats' : '3+ chats', grp_order: n === 0 ? 1 : n <= 2 ? 2 : 3, sid: r.sid, first_round: r.first_round, offer: r.offer });
    });
    const out = [];
    groupBy(cells, (c) => c.action + '|' + c.grp).forEach((rs) => {
      if (!cellOk(rs)) return;
      out.push({ action: rs[0].action, action_order: rs[0].action_order, grp: rs[0].grp, grp_order: rs[0].grp_order, n_applied: rs.length, n_people: new Set(rs.map((r) => r.sid)).size, pct_first_round: pct(rs.filter((r) => r.first_round).length, rs.length), pct_offer: pct(rs.filter((r) => r.offer).length, rs.length) });
    });
    return out.sort((a, b) => a.action_order - b.action_order || a.grp_order - b.grp_order);
  }

  function dashTiming() {
    const a = appRows().filter((r) => r.applied && r.applied_on && r.firm_id).map((r) => ({ ...r, f: firmById(r.firm_id) }));
    const groups = [['All firms', null, true, a], ...[...groupBy(a, (r) => r.f.name).entries()].map(([name, rs]) => [name, rs[0].f.tier, false, rs])];
    const people = (rs) => new Set(rs.map((r) => r.sid)).size;
    const med = (rs, fn) => (people(rs) >= k() ? Math.round(median(rs.map(fn))) : null);
    return groups.map(([label, tier, is_overall, rs]) => {
      const fr = rs.filter((r) => r.first_round_on), rej = rs.filter((r) => r.closed === 'rejected' && r.closed_on);
      const sd = rs.filter((r) => r.superday_on && r.first_round_on), of = rs.filter((r) => r.offer_on && r.superday_on);
      const idx = fr.map((r) => (monthOf(r.first_round_on) + 4) % 12);
      const frOk = people(fr) >= k();
      return { label, tier, is_overall, n_people: people(rs),
        med_days_to_first_round: med(fr, (r) => daysBetween(r.applied_on, r.first_round_on)),
        med_days_to_rejection: med(rej, (r) => daysBetween(r.applied_on, r.closed_on)),
        med_days_first_round_to_superday: med(sd, (r) => daysBetween(r.first_round_on, r.superday_on)),
        med_days_superday_to_offer: med(of, (r) => daysBetween(r.superday_on, r.offer_on)),
        first_round_month_from: frOk ? (pctDisc(idx, 0.25) + 7) % 12 + 1 : null,
        first_round_month_to: frOk ? (pctDisc(idx, 0.75) + 7) % 12 + 1 : null };
    }).filter((g) => g.n_people >= k()).sort((x, y) => y.is_overall - x.is_overall || y.n_people - x.n_people || cmpC(x.label, y.label));
  }

  function dashOutreach() {
    const o = appRows().filter((r) => r.share).flatMap((r) => r.touches.filter((t) => t.kind === 'outreach').map((t) => ({ ...t, sid: r.sid, firm_id: r.firm_id, firm_name: firmById(r.firm_id)?.name })));
    const dims = o.flatMap((t) => ['contact_level', 'connection', 'found_via'].filter((d) => t[d] != null).map((d) => ({ ...t, dimension: d, value: t[d] })));
    const cells = [...dims.map((d) => ({ ...d, fkey: 0, firm_id: null, label: 'All firms' })), ...dims.filter((d) => d.firm_id != null).map((d) => ({ ...d, fkey: d.firm_id, label: d.firm_name }))];
    const out = [];
    groupBy(cells, (c) => c.fkey + '|' + c.dimension + '|' + c.value).forEach((rs) => {
      if (!cellOk(rs)) return;
      out.push({ firm_id: rs[0].firm_id, label: rs[0].label, dimension: rs[0].dimension, value: rs[0].value, n_outreach: rs.length, n_people: new Set(rs.map((r) => r.sid)).size,
        pct_replied: pct(rs.filter((r) => r.replied).length, rs.length), pct_chat: pct(rs.filter((r) => r.led_to_chat).length, rs.length), pct_referral: pct(rs.filter((r) => r.led_to_referral).length, rs.length), _fkey: rs[0].fkey });
    });
    return out.sort((a, b) => a._fkey - b._fkey || cmpC(a.dimension, b.dimension) || b.pct_replied - a.pct_replied || cmpC(a.value, b.value)).map(({ _fkey, ...r }) => r);
  }

  // ---- odds (mirrors odds_for)
  function oddsFor(gpa, intern) {
    const rows = approved().flatMap((s) => s.rows.filter((r) => r.applied && r.firm_id).map((r) => ({ ...r, sid: s.id, mine: s.gpa_band === gpa && s.prior_finance_internship === intern })));
    const rate = (rs) => (rs.length ? Math.round((1000 * rs.filter((r) => r.first_round).length) / rs.length) / 10 : null);
    const ppl = (rs) => new Set(rs.map((r) => r.sid)).size;
    const mine = rows.filter((r) => r.mine);
    const avg_rate = ppl(mine) >= k() ? rate(mine) : ppl(rows) >= k() ? rate(rows) : null;
    const avg_basis = ppl(mine) >= k() ? 'your profile' : 'all profiles';
    const tierRows = {}; FIRMS.forEach((f) => { tierRows[f.tier] = rows.filter((r) => firmById(r.firm_id)?.tier === f.tier); });
    return FIRMS.map((f) => {
      const all = rows.filter((r) => r.firm_id === f.id), m = all.filter((r) => r.mine), t = tierRows[f.tier], tm = t.filter((r) => r.mine);
      let r = null, basis = 'not enough data';
      if (ppl(m) >= k()) { r = rate(m); basis = 'your profile'; }
      else if (ppl(all) >= k()) { r = rate(all); basis = 'all profiles'; }
      else if (ppl(tm) >= k()) { r = rate(tm); basis = 'tier average (too few at this firm)'; }
      else if (ppl(t) >= k()) { r = rate(t); basis = 'tier average (too few at this firm)'; }
      const is_high = ppl(all) >= k() && (r || 0) > 0 && avg_rate != null && r >= 2 * avg_rate;
      return { firm_id: f.id, label: f.name, tier: f.tier, rate: r, n: ppl(all), basis, is_high, avg_rate, avg_basis };
    }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.n - a.n || a.firm_id - b.firm_id);
  }

  // ---- my rows
  const needMe = () => { const m = me(); if (!m) throw new Error('Not signed in.'); return m; };
  const needLive = () => { const m = needMe(); if (!m.sub) throw new Error('Start a pipeline first.'); if (m.sub.status !== 'in_progress') throw new Error('Reopen your pipeline to edit it.'); return m; };
  function myPipeline() {
    const m = me(); if (!m || !m.sub) return [];
    return (m.firms || []).map((f) => {
      const t = (m.touches || []).filter((x) => x.submission_firm_id === f.id);
      const firm = firmById(f.firm_id);
      const dates = t.map((x) => x.occurred_on).filter(Boolean).sort();
      return { ...f, label: firm ? firm.name : f.firm_name_other, tier: firm ? firm.tier : 'Other',
        n_actions: t.length, n_outreach: t.filter((x) => x.kind === 'outreach').length, n_replied: t.filter((x) => x.kind === 'outreach' && x.replied).length,
        last_action_on: dates.length ? dates[dates.length - 1] : null, application_url: f.application_url ?? null, notes: f.notes ?? null, _sort: firm ? firm.sort_order : 1000 };
    }).sort((a, b) => a._sort - b._sort || a.label.localeCompare(b.label)).map(({ _sort, ...r }) => r);
  }

  // a sample live pipeline so the board can be previewed (demo only)
  function samplePipeline(m) {
    const t0 = today(); const d = (n) => addDays(t0, -n);
    const plan = [
      [12, { applied: true, first_round: true, applied_on: d(30), first_round_on: d(9), next_on: addDays(t0, 4), next_kind: 'superday' }, [['coffee_chat', 50], ['outreach', 55, 'analyst', 'school_alum', 'alumni_directory', true, true, false], ['info_session', 45]]],
      [1, { applied: true, applied_on: d(26) }, [['outreach', 60, 'associate', 'none', 'manual_search', false, false, false], ['recruiting_event', 40]]],
      [14, { applied: true, applied_on: d(40), closed: 'rejected', closed_on: d(12) }, [['outreach', 70, 'vp_plus', 'none', 'manual_search', false, false, false]]],
      [16, { next_on: addDays(t0, 9), next_kind: 'deadline' }, [['outreach', 6, 'analyst', 'club_alum', 'club', true, true, true], ['coffee_chat', 3]]],
      [24, { applied: true, applied_on: d(8) }, [['club_event', 20]]],
      [3, {}, [['outreach', 2, 'analyst', 'school_alum', 'alumni_directory', false, false, false]]],
    ];
    m.firms = []; m.touches = [];
    plan.forEach(([firmId, st, acts]) => {
      const id = nextId++;
      m.firms.push({ id, firm_id: firmId, firm_name_other: null, referral: false, applied: false, first_round: false, superday: false, offer: false, accepted: false, closed: null, applied_on: null, first_round_on: null, superday_on: null, offer_on: null, closed_on: null, next_on: null, next_kind: null, ...st });
      acts.forEach(([kind, ago, contact_level = null, connection = null, found_via = null, replied = null, led_to_chat = null, led_to_referral = null]) =>
        m.touches.push({ id: nextId++, submission_firm_id: id, kind, occurred_on: d(ago), contact_level, connection, found_via, replied, led_to_chat, led_to_referral }));
    });
  }
  const emptyFirm = { referral: false, applied: false, first_round: false, superday: false, offer: false, accepted: false, closed: null, applied_on: null, first_round_on: null, superday_on: null, offer_on: null, closed_on: null, next_on: null, next_kind: null };

  window.DemoBackend = {
    isDemo: true,
    async getSession() { const m = me(); return m ? { user: { email: m.email } } : null; },
    onAuthChange(cb) { this._cb = cb; },
    // mirrors the real flow: request a code, then type it in (any 6–10 digits in the demo)
    async signIn(email) { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.'); return { sent: true }; },
    async verifyCode(email, code) { if (!/^\d{6,10}$/.test(code)) throw new Error('That code is wrong or has expired. Request a new one.'); setMe({ email, activity: [] }); this._cb && this._cb(); },
    async signOut() { setMe(null); this._cb && this._cb(); },
    async getFirms() { return FIRMS; },
    async getSettings() { return { ...DB.settings }; },
    async myStatus() {
      const m = me(); const s = m && m.sub;
      return { has_submission: !!s, status: s ? s.status : null, has_access: hasAccess(), is_admin: !!(m && m.admin), is_active_logger: isActiveLogger(),
        share_outreach: !!(s && s.share_outreach), submitted_at: s ? s.finalized_at : null,
        cycle: s?.cycle ?? null, class_year: s?.class_year ?? null, gpa_band: s?.gpa_band ?? null, prior_finance_internship: s?.prior_finance_internship ?? null,
        finance_club_member: s?.finance_club_member ?? null, diversity_program: s?.diversity_program ?? null };
    },
    // ---- my pipeline
    async upsertPipeline(p) {
      const m = needMe();
      if (m.sub && m.sub.status !== 'in_progress') throw new Error('Reopen your pipeline to edit it.');
      m.sub = { ...(m.sub || { status: 'in_progress', flags: [], outcome: null, finalized_at: null, admin_notes: null }), ...p };
      m.firms = m.firms || []; m.touches = m.touches || [];
      save(m);
    },
    async setShareOutreach(v) { const m = needMe(); if (m.sub) { m.sub.share_outreach = !!v; setMe(m); } },
    async myPipeline() { return myPipeline(); },
    async myTouchpoints() {
      const m = me(); if (!m || !m.sub) return [];
      return [...(m.touches || [])].sort((a, b) => (b.occurred_on || '').localeCompare(a.occurred_on || '') || b.id - a.id);
    },
    async saveFirm(row) {
      const m = needLive();
      const i = row.id ? m.firms.findIndex((f) => f.id === row.id) : -1;
      if (row.id && i < 0) throw new Error('Unknown firm.');
      const next = i >= 0 ? { ...m.firms[i], ...row } : { ...emptyFirm, ...row, id: Date.now() + Math.floor(Math.random() * 1000) };
      if (next.firm_id != null && m.firms.some((f) => f.firm_id === next.firm_id && f.id !== next.id)) throw new Error('That firm is already in your pipeline.');
      if (next.firm_id == null && !(next.firm_name_other || '').trim()) throw new Error('Type the firm name.');
      if (next.offer && next.closed === 'rejected') throw new Error('A firm cannot be both an offer and a rejection.');
      if (i >= 0) m.firms[i] = next; else m.firms.push(next);
      const id = next.id;
      save(m); return id;
    },
    // private notes and link: owner only, editable at any status (mirrors firm_notes)
    async saveNotes(firmId, { application_url, notes }) {
      const m = needMe(); const f = (m.firms || []).find((x) => x.id === firmId); if (!f) throw new Error('Unknown firm.');
      if (application_url && !/^https?:\/\//i.test(application_url)) throw new Error('Links must start with http:// or https://');
      if ((application_url || '').length > 500 || (notes || '').length > 5000) throw new Error('Too long.');
      f.application_url = application_url || null; f.notes = notes || null; setMe(m);
    },
    async deleteFirm(id) { const m = needLive(); m.firms = m.firms.filter((f) => f.id !== id); m.touches = m.touches.filter((t) => t.submission_firm_id !== id); setMe(m); },
    async addTouchpoint(t) {
      const m = needLive();
      if (!m.firms.some((f) => f.id === t.submission_firm_id)) throw new Error('Unknown firm.');
      m.touches.push({ contact_level: null, connection: null, found_via: null, replied: null, led_to_chat: null, led_to_referral: null, occurred_on: null, ...t, id: Date.now() + Math.floor(Math.random() * 1000) });
      save(m);
    },
    async updateTouchpoint(id, patch) { const m = needLive(); const t = m.touches.find((x) => x.id === id); if (t) Object.assign(t, patch); save(m); },
    async deleteTouchpoint(id) { const m = needMe(); m.touches = (m.touches || []).filter((t) => t.id !== id); setMe(m); },
    async finalize(outcome) {
      const m = needLive();
      if (!outcome) throw new Error('Say how the cycle ended.');
      const s = mySub();
      if (!s.rows.length) throw new Error('Add at least one firm before submitting.');
      const flags = computeFlags(s.rows);
      const auto = DB.settings.auto_approve === 'true' && !flags.length;
      Object.assign(m.sub, { outcome, flags, status: auto ? 'approved' : 'pending', finalized_at: new Date().toISOString() });
      setMe(m); return { status: m.sub.status, flags };
    },
    async reopen() { const m = needMe(); if (m.sub) { Object.assign(m.sub, { status: 'in_progress', flags: [], finalized_at: null }); setMe(m); } },
    async deletePipeline() { const m = needMe(); delete m.sub; m.firms = []; m.touches = []; m.activity = []; setMe(m); },
    // ---- aggregates
    async dash() {
      if (!hasAccess()) return { summary: null, actions: [], timing: [], outreach: [] };
      return { summary: dashSummary(), actions: dashActions(), timing: dashTiming(), outreach: dashOutreach() };
    },
    async outreach() { return hasAccess() ? dashOutreach() : []; },
    async timing() { return hasAccess() ? dashTiming() : []; },
    async myOdds() { const m = me(); if (!hasAccess() || !m?.sub) return []; return oddsFor(m.sub.gpa_band, m.sub.prior_finance_internship); },
    // ---- admin
    async adminList() {
      const m = me(); if (!m?.admin) return [];
      return allSubs().filter((s) => s.status !== 'in_progress').map((s) => ({ id: s.id, email: s.email, cycle: s.cycle, class_year: s.class_year, gpa_band: s.gpa_band, prior_finance_internship: s.prior_finance_internship, finance_club_member: s.finance_club_member, outcome: s.outcome, status: s.status, flags: s.flags, admin_notes: s.admin_notes, created_at: s.finalized_at, n_firms: s.rows.length, n_applied: s.rows.filter((r) => r.applied).length, n_first_round: s.rows.filter((r) => r.first_round).length, n_superday: s.rows.filter((r) => r.superday).length, n_offer: s.rows.filter((r) => r.offer).length, total_chats: s.rows.reduce((a, r) => a + r.touches.filter((t) => t.kind === 'coffee_chat').length, 0) }))
        .sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || (b.created_at || '').localeCompare(a.created_at || ''));
    },
    async adminSetStatus(id, status, notes) {
      if (!['pending', 'approved', 'rejected'].includes(status)) throw new Error('Bad status.');
      if (id === 'demo-me') { const m = me(); if (m?.sub && m.sub.status !== 'in_progress') { m.sub.status = status; if (notes != null) m.sub.admin_notes = notes; setMe(m); } return; }
      const s = DB.submissions.find((x) => x.id === id); if (s && s.status !== 'in_progress') { s.status = status; if (notes != null) s.admin_notes = notes; }
    },
    async adminMetrics() {
      const subs = allSubs(); const fin = subs.filter((s) => s.status !== 'in_progress');
      const since = addDays(today(), -setting('active_window_days', 30));
      const mine = mySub();
      const liveMine = mine && mine.status === 'in_progress' ? 1 : 0;
      return {
        n_in_progress: DB.live.length + liveMine,
        n_active: DB.live.filter((p) => p.lastActive > since).length + (liveMine && isActiveLogger() ? 1 : 0),
        n_pending: fin.filter((s) => s.status === 'pending').length,
        n_approved: fin.filter((s) => s.status === 'approved').length,
        n_rejected: fin.filter((s) => s.status === 'rejected').length,
        n_finalized_last_7_days: fin.filter((s) => s.finalized_at && Date.now() - Date.parse(s.finalized_at) < 7 * 864e5).length,
        pct_with_rejection: pct(fin.filter((s) => s.rows.some((r) => r.applied && !r.offer)).length, fin.length),
        median_firms: median(fin.map((s) => s.rows.length)),
        n_sharing_outreach: fin.filter((s) => s.share_outreach).length,
      };
    },
    async adminSetSetting(key, value) { DB.settings[key] = value; },
    // Mirrors unlock_admin(). In the demo this is cosmetic: the check runs in the browser.
    async unlockAdmin(password) {
      const m = needMe();
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password || ''));
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== '011c0e1cffbdc6b369048628888306a444bf66f2e1eb2dc1cf2523c280537f7c') return false;
      m.admin = true; setMe(m); return true;
    },
    // demo-only helpers
    leaveAdmin() { const m = me(); if (m) { m.admin = false; setMe(m); } },
    loadSample() { const m = needLive(); samplePipeline(m); save(m); },
  };
})();
