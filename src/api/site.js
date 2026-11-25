const fs = require('node:fs');
const path = require('node:path');

// Visitor plan rail behaviour (see visitor-plan-patch.js). If the patch file is
// ever missing, the page still serves unchanged instead of failing.
let applyVisitorPlanPatch = html => html;
try {
  applyVisitorPlanPatch = require('./visitor-plan-patch').applyVisitorPlanPatch;
} catch (error) {
  console.error('ZentraChain visitor plan patch could not be loaded:', error);
}

function loadSiteHtml() {
  const candidates = [
    path.join(__dirname, '..', 'site.html'),
    path.join(process.cwd(), 'site.html'),
    path.join(process.cwd(), 'src', 'site.html')
  ];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf8');
    } catch (_) {
      // Try the next deployment-root candidate.
    }
  }
  throw new Error('The deployed visitor page file could not be found.');
}

function applyBrandMetadata(html, req) {
  const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host || 'zentrachain.vercel.app';
  const requestedHost = String(forwardedHost).split(',')[0].trim().toLowerCase();
  const host = /^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(requestedHost)
    ? requestedHost
    : 'zentrachain.vercel.app';
  const origin = 'https://' + host;
  const iconTags = [
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">',
    '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">',
    '<link rel="shortcut icon" href="/favicon.ico">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">'
  ].join('\n');
  const socialTags = [
    '<link rel="canonical" href="' + origin + '/">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="ZentraChain">',
    '<meta property="og:url" content="' + origin + '/">',
    '<meta property="og:title" content="ZentraChain | Digital Asset Platform">',
    '<meta property="og:description" content="ZentraChain digital asset account portal, market information and transaction management.">',
    '<meta property="og:image" content="' + origin + '/og-image.jpg">',
    '<meta property="og:image:secure_url" content="' + origin + '/og-image.jpg">',
    '<meta property="og:image:type" content="image/jpeg">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="ZentraChain — Digital Asset Platform">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="ZentraChain | Digital Asset Platform">',
    '<meta name="twitter:description" content="ZentraChain digital asset account portal, market information and transaction management.">',
    '<meta name="twitter:image" content="' + origin + '/og-image.jpg">'
  ].join('\n');
  let result = String(html);
  result = result.replace(/<link\s+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*>/gi, '');
  result = result.replace(/<link\s+rel=["']canonical["'][^>]*>/gi, '');
  result = result.replace(/<meta\s+(?:property|name)=["'](?:og:[^"']+|twitter:[^"']+)["'][^>]*>/gi, '');
  return result.replace(/<\/head>/i, iconTags + '\n' + socialTags + '\n</head>');
}

module.exports = (req, res) => {
  try {
    const html = applyBrandMetadata(applyVisitorPlanPatch(loadSiteHtml()), req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.statusCode = 200;
    res.end(html);
  } catch (error) {
    console.error('ZentraChain visitor page failed to load:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('The ZentraChain visitor page is temporarily unavailable.');
  }
};
