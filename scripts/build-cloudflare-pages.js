'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyVisitorPlanPatch } = require('../src/api/visitor-plan-patch');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const sourceHtml = path.join(root, 'src', 'site.html');
const sourceEnv = path.join(root, 'src', 'js', 'env.js');
const sourceAssets = path.join(root, 'assets');

function fail(message) {
  console.error('[Cloudflare Pages build] ' + message);
  process.exit(1);
}

for (const file of [sourceHtml, sourceEnv, sourceAssets]) {
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
if (!/<script\s+src=["']js\/env\.js["']/.test(html)) {
  fail('The visitor page no longer references js/env.js as expected.');
}

html = applyVisitorPlanPatch(html);
if (!html.includes('zc-visitor-plan-flow-v2')) {
  fail('The visitor plan behaviour patch was not applied.');
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'js'), { recursive: true });
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });

fs.writeFileSync(path.join(output, 'index.html'), html, 'utf8');
fs.copyFileSync(sourceEnv, path.join(output, 'js', 'env.js'));
fs.cpSync(sourceAssets, path.join(output, 'assets'), { recursive: true });

const copiedAssets = fs.readdirSync(path.join(output, 'assets'), { recursive: true });
if (!copiedAssets.some((entry) => String(entry).startsWith('plans'))) {
  fail('The plan artwork directory was not copied into the build output.');
}

console.log('[Cloudflare Pages build] Created dist/index.html');
console.log('[Cloudflare Pages build] Copied production Supabase config to dist/js/env.js');
console.log('[Cloudflare Pages build] Copied ' + copiedAssets.length + ' asset entries');
console.log('[Cloudflare Pages build] Visitor plan behaviour patch is included.');
console.log('[Cloudflare Pages build] No Vercel or Supabase production settings were changed.');
