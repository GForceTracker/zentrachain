// ZentraChain backend switch.
// MODE: 'cloud' = live production Supabase. This deployed copy must ALWAYS use
// 'cloud'. The local testing copy is js/env.js (root) which uses 'sandbox'.
window.ZC_CONFIG = {
  MODE: 'cloud',
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
