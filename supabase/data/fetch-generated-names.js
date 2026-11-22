// Fetches fresh international names from the free randomuser.me API (no key)
// and appends non-duplicates to showcase-names.json.
// Usage: node fetch-generated-names.js --count=25
// Prints: NAMES:["..."] (added this run) for the caller to bump/push.
const fs = require('fs');
const path = require('path');

const countArg = process.argv.find((a) => a.startsWith('--count='));
const wanted = Math.min(Math.max(parseInt((countArg || '--count=25').split('=')[1], 10) || 25, 1), 200);

const NATS = {
  us: 'United States', gb: 'United Kingdom', ca: 'Canada', au: 'Australia',
  nz: 'New Zealand', ie: 'Ireland', de: 'Germany', fr: 'France', es: 'Spain',
  ch: 'Switzerland', nl: 'Netherlands', no: 'Norway', dk: 'Denmark',
  fi: 'Finland', br: 'Brazil', mx: 'Mexico', tr: 'Turkey', in: 'India',
  ua: 'Ukraine', rs: 'Serbia'
};

async function fetchBatch(n, natList) {
  const url = `https://randomuser.me/api/?results=${n}&inc=name,nat&noinfo` + (natList ? `&nat=${natList}` : '');
  const r = await fetch(url);
  if (!r.ok) throw new Error('names API HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('names API: ' + j.error);
  return j.results || [];
}

(async () => {
  const jsonPath = path.join(__dirname, 'showcase-names.json');
  const list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const have = new Set(list.map((e) => String(e.name).toLowerCase()));
  // This script only SUGGESTS candidates; the caller appends them.
  // (Single writer avoids duplicates and encoding drift.)
  const candidates = [];
  let remaining = wanted;
  let natList = Object.keys(NATS).join(',');
  let guard = 0;
  while (remaining > 0 && guard < 10) {
    guard++;
    const n = Math.min(remaining, 100);
    let results;
    try {
      results = await fetchBatch(n, natList);
    } catch (e) {
      if (natList) { natList = ''; continue; }
      throw e;
    }
    if (!results.length) break;
    for (const u of results) {
      const first = String((u.name && u.name.first) || '').trim();
      const last = String((u.name && u.name.last) || '').trim();
      if (!first || !last) continue;
      const name = `${first} ${last}`;
      if (have.has(name.toLowerCase())) continue;
      const region = NATS[String(u.nat || '').toLowerCase()] || 'International';
      candidates.push({ name, region });
      have.add(name.toLowerCase());
      remaining--;
      if (remaining <= 0) break;
    }
  }
  fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2) + '\n');
  console.log('NAMES:' + JSON.stringify(candidates.map((c) => c.name)));
  console.log('REGIONS:' + JSON.stringify(candidates.map((c) => c.region)));
})().catch((e) => { console.error('FETCH_ERROR:' + e.message); process.exit(1); });
