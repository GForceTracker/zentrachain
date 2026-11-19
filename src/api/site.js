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

module.exports = (req, res) => {
  try {
    const html = applyVisitorPlanPatch(loadSiteHtml());
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
