// ---------------------------------------------------------------------------
// Baserate configuration
// 1. Create a Supabase project, run supabase/schema.sql then supabase/seed_firms.sql.
// 2. Paste your Project URL and anon public key below (Project Settings → API).
// 3. Set DEMO to false. (While DEMO is true the app runs entirely in the browser
//    with synthetic data and no login, so you can preview every screen.)
// ---------------------------------------------------------------------------
window.BASERATE_CONFIG = {
  SUPABASE_URL: "",            // e.g. "https://abcdefghijklmnop.supabase.co"
  SUPABASE_ANON_KEY: "",       // the long "anon public" key — safe to ship in the browser
  DEMO: true,
  ALLOWED_DOMAIN_HINT: "college.harvard.edu",
};
