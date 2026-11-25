// ZentraChain backend switch.
// Local development stays isolated in the sandbox. Any deployed hostname
// (including the Vercel production domain) uses the production Supabase project.
// Never place service-role keys, wallet seeds, or other private secrets here.
(function () {
  var host = (window.location && window.location.hostname || '').toLowerCase();
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  window.ZC_CONFIG = {
    MODE: isLocal ? 'sandbox' : 'cloud',
    sandbox: {
      SUPABASE_URL: 'https://mdpdcpxvohbcdlhirtdp.supabase.co',
      SUPABASE_KEY: 'sb_publishable_hySEI1W9BQV0AKny0THJsg_mOp8YsDF'
    },
    cloud: {
      SUPABASE_URL: 'https://ltowdrhwebaitbrrupks.supabase.co',
      SUPABASE_KEY: 'sb_publishable_mLgEtnFl6FnOzbykh6tWPw_14T_c8nS'
    }
  };
  var active = window.ZC_CONFIG[window.ZC_CONFIG.MODE];
  window.ZC_ENV = {
    SUPABASE_URL: active.SUPABASE_URL,
    SUPABASE_KEY: active.SUPABASE_KEY
  };
})();
