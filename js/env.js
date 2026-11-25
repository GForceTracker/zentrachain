// ZentraChain backend switch.
// MODE: 'cloud' = clone project for testing (this is for LOCAL use on the laptop)
//       'cloud'   = live production Supabase (what the deployed site must use)
// NOTE: js/env.js (this file) is for local testing; src/js/env.js is the deployed
// copy and must keep MODE: 'cloud'. Never set this MODE to 'cloud' locally by
// accident — sandbox keeps mistakes away from real data.
window.ZC_CONFIG = {
  MODE: 'sandbox',
  sandbox: {
    SUPABASE_URL: 'https://mdpdcpxvohbcdlhirtdp.supabase.co',
    SUPABASE_KEY: 'sb_publishable_hySEI1W9BQV0AKny0THJsg_mOp8YsDF'
  },
  cloud: {
    SUPABASE_URL: 'https://ltowdrhwebaitbrrupks.supabase.co',
    SUPABASE_KEY: 'sb_publishable_mLgEtnFl6FnOzbykh6tWPw_14T_c8nS'
  }
};
(function () {
  var active = window.ZC_CONFIG[window.ZC_CONFIG.MODE] || window.ZC_CONFIG.cloud;
  window.ZC_ENV = { SUPABASE_URL: active.SUPABASE_URL, SUPABASE_KEY: active.SUPABASE_KEY };
})();
