/**
 * Baserate event logger — Google Apps Script bound to a Google Sheet.
 * Setup steps are in README.md ("Pilot event log"). Paste this whole file into Extensions → Apps Script.
 */

const EVENTS_SHEET = "Events";
const REPORT_SHEET = "Report";
const HEADERS = ["received_at","client_ts","event","view","src","first_src","visitor","session","visit_num",
                 "new_visitor","device","referrer","email","detail","version","tz"];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const row = JSON.parse(e.postData.contents);
    const sh = eventsSheet_();
    sh.appendRow([
      new Date(), row.ts || "", row.event || "", row.view || "", row.src || "", row.first_src || "",
      row.visitor || "", row.session || "", row.visit_num || "", row.new_visitor === true, row.device || "",
      row.referrer || "", row.email || "", JSON.stringify(row.detail || {}), row.version || "", row.tz || ""
    ]);
    return ContentService.createTextOutput("ok");
  } catch (err) {
    return ContentService.createTextOutput("error: " + err);
  } finally {
    lock.releaseLock();
  }
}

// Lets you open the web-app URL in a browser to confirm it's live.
function doGet() { return ContentService.createTextOutput("Baserate logger is running."); }

function eventsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(EVENTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(EVENTS_SHEET);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Baserate")
    .addItem("Refresh report", "buildReport")
    .addToUi();
}

/** Builds the per-GTM-source summary you report back for the assignment. */
function buildReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = eventsSheet_().getDataRange().getValues();
  const h = data.shift();
  const col = name => h.indexOf(name);
  const tz = ss.getSpreadsheetTimeZone();

  const bySrc = {};   // src -> stats
  const byDay = {};   // yyyy-mm-dd -> {visitors:Set, sessions:Set, events}
  const visitorSessions = {}; // visitor -> Set(sessions)
  const firmOpens = {};

  data.forEach(r => {
    const ev = r[col("event")], src = r[col("src")] || "direct", v = r[col("visitor")], s = r[col("session")];
    const day = Utilities.formatDate(new Date(r[col("received_at")]), tz, "yyyy-MM-dd");
    const st = bySrc[src] || (bySrc[src] = {visitors:new Set(), sessions:new Set(), events:0, signup_start:new Set(),
      signups:new Set(), contribs:0, tracker:0, firm_opens:0, seconds:0, ended:0});
    st.visitors.add(v); st.sessions.add(s); st.events++;
    if (ev === "signup_start") st.signup_start.add(v);
    if (ev === "signup_complete") st.signups.add(v);
    if (ev === "contribute") st.contribs++;
    if (ev === "tracker_add" || ev === "tracker_status") st.tracker++;
    if (ev === "firm_open") {
      st.firm_opens++;
      const f = safeJson_(r[col("detail")]).firm; if (f) firmOpens[f] = (firmOpens[f] || 0) + 1;
    }
    if (ev === "session_end") { st.seconds += Number(safeJson_(r[col("detail")]).seconds || 0); st.ended++; }
    const d = byDay[day] || (byDay[day] = {visitors:new Set(), sessions:new Set(), events:0});
    d.visitors.add(v); d.sessions.add(s); d.events++;
    (visitorSessions[v] || (visitorSessions[v] = new Set())).add(s);
  });

  let rep = ss.getSheetByName(REPORT_SHEET);
  if (!rep) rep = ss.insertSheet(REPORT_SHEET); else rep.clear();

  const out = [];
  out.push(["Baserate GTM report", "Refreshed " + Utilities.formatDate(new Date(), tz, "MMM d, yyyy h:mm a")]);
  out.push([""]);
  out.push(["BY GTM SOURCE","Unique visitors","Sessions (visits)","Visits per visitor","Started signup","Completed signup (gave data)",
            "Signup conversion","Outcomes logged","Tracker actions","Firm cards opened","Avg minutes per visit","Total events"]);
  Object.keys(bySrc).sort((a,b)=>bySrc[b].visitors.size-bySrc[a].visitors.size).forEach(src => {
    const s = bySrc[src], u = s.visitors.size;
    out.push([src, u, s.sessions.size, round_(s.sessions.size/u), s.signup_start.size, s.signups.size,
      u ? round_(s.signups.size/u*100) + "%" : "", s.contribs, s.tracker, s.firm_opens,
      s.ended ? round_(s.seconds/s.ended/60) : "", s.events]);
  });
  out.push([""]);
  out.push(["BY DAY","Unique visitors","Sessions","Events"]);
  Object.keys(byDay).sort().forEach(d => out.push([d, byDay[d].visitors.size, byDay[d].sessions.size, byDay[d].events]));
  out.push([""]);
  const repeat = Object.values(visitorSessions).filter(x => x.size > 1).length;
  out.push(["RETENTION","Visitors","Came back 2+ times","Repeat rate"]);
  const tv = Object.keys(visitorSessions).length;
  out.push(["All sources", tv, repeat, tv ? round_(repeat/tv*100) + "%" : ""]);
  out.push([""]);
  out.push(["MOST-OPENED FIRMS","Opens"]);
  Object.keys(firmOpens).sort((a,b)=>firmOpens[b]-firmOpens[a]).forEach(f => out.push([f, firmOpens[f]]));

  const width = Math.max(...out.map(r => r.length));
  rep.getRange(1,1,out.length,width).setValues(out.map(r => r.concat(Array(width - r.length).fill(""))));
  rep.getRange(1,1).setFontWeight("bold").setFontSize(14);
  out.forEach((r,i) => { if (/^[A-Z \-]+$/.test(String(r[0])) && r[0]) rep.getRange(i+1,1,1,width).setFontWeight("bold").setBackground("#EDF0F3"); });
  rep.autoResizeColumns(1, width);
}

function safeJson_(s) { try { return JSON.parse(s); } catch (e) { return {}; } }
function round_(x) { return Math.round(x * 10) / 10; }
