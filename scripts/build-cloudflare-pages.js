'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyVisitorPlanPatch } = require('../src/api/visitor-plan-patch');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');

// IMPORTANT: index.html is the complete visitor + account portal source.
// src/site.html is only the older Vercel runtime copy and is not the full app.
const sourceHtml = path.join(root, 'index.html');
const sourceEnv = path.join(root, 'src', 'js', 'env.js');
const sourceAssets = path.join(root, 'assets');
const sourceJs = path.join(root, 'js');

function fail(message) {
  console.error('[Cloudflare Worker build] ' + message);
  process.exit(1);
}

for (const file of [sourceHtml, sourceEnv, sourceAssets, sourceJs]) {
  if (!fs.existsSync(file)) fail('Required source is missing: ' + path.relative(root, file));
}

const env = fs.readFileSync(sourceEnv, 'utf8');
if (!/MODE\s*:\s*['"]cloud['"]/.test(env)) {
  fail('The deployed environment must remain in cloud mode.');
}
if (!env.includes('https://ltowdrhwebaitbrrupks.supabase.co')) {
  fail('The deployed environment is not pointing to the expected production Supabase project.');
}

let html = fs.readFileSync(sourceHtml, 'utf8');
if (html.length < 900000) {
  fail('index.html is unexpectedly small. Refusing to deploy a partial visitor-only site.');
}
if (!/<script\s+src=["']js\/env\.js["']/.test(html)) {
  fail('The full site no longer references js/env.js as expected.');
}
if (html.includes('js/tap-earn.js') && !fs.existsSync(path.join(sourceJs, 'tap-earn.js'))) {
  fail('The Tap To Earn frontend script is referenced but missing from the root js directory.');
}
if (!/dashboard/i.test(html) || !/studio/i.test(html) || !/create account/i.test(html)) {
  fail('The full dashboard, Studio, or account portal content is missing from index.html.');
}

html = applyVisitorPlanPatch(html);
if (!html.includes('zc-visitor-plan-flow-v2')) {
  fail('The visitor plan behaviour patch was not applied.');
}

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(sourceJs, path.join(output, 'js'), { recursive: true });
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });

fs.writeFileSync(path.join(output, 'index.html'), html, 'utf8');
fs.copyFileSync(sourceEnv, path.join(output, 'js', 'env.js'));
fs.cpSync(sourceAssets, path.join(output, 'assets'), { recursive: true });

const copiedAssets = fs.readdirSync(path.join(output, 'assets'), { recursive: true });
if (!copiedAssets.some((entry) => String(entry).startsWith('plans'))) {
  fail('The plan artwork directory was not copied into the build output.');
}

console.log('[Cloudflare Worker build] Created full dist/index.html (' + html.length + ' characters)');
console.log('[Cloudflare Worker build] Full dashboard, Studio, and account portal checks passed.');
console.log('[Cloudflare Worker build] Copied root JavaScript assets, including Tap To Earn when present.');
console.log('[Cloudflare Worker build] Replaced dist/js/env.js with the production Supabase config.');
console.log('[Cloudflare Worker build] Copied ' + copiedAssets.length + ' asset entries');
console.log('[Cloudflare Worker build] Visitor plan behaviour patch is included.');
console.log('[Cloudflare Worker build] No Vercel or Supabase production settings were changed.');
