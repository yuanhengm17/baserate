// ---------------------------------------------------------------------------
// Baserate configuration
// 1. Create a Supabase project, run supabase/schema.sql then supabase/seed_firms.sql.
// 2. Paste your Project URL and anon public key below (Project Settings → API).
// 3. Put {{ .Token }} in the Magic Link and Confirm signup email templates and set up
//    custom SMTP (README, "Deploy for real"), or sign-in codes won't arrive.
// 4. Set DEMO to false. (While DEMO is true the app runs entirely in the browser
//    with synthetic data and any 6-digit code, so you can preview every screen.)
// ---------------------------------------------------------------------------
window.BASERATE_CONFIG = {
  SUPABASE_URL: "",            // e.g. "https://abcdefghijklmnop.supabase.co"
  SUPABASE_ANON_KEY: "",       // the long "anon public" key — safe to ship in the browser
  DEMO: true,
  ALLOWED_DOMAIN_HINT: "college.harvard.edu",
  // TEMPORARY (MVP pilot): the team's Google Apps Script web-app URL (tracking/Code.gs).
  // Every visit and action, with the signed-in email, is logged to that Sheet. "" turns it off.
  EVENTS_URL: "https://script.google.com/macros/s/AKfycbzPYtlUizNEm_B6boAOhgHXgf4VpXiFbJdIrP87GLIAaeawcT4eKpH5LQH7HqT5XzL5/exec",
};
