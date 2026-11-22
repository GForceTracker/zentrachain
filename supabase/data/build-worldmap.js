// Builds supabase/data/worldmap.json: dot-grid landmask + region markers.
// Sources: world-atlas countries-110m.json (TopoJSON) + showcase-names.json.
const fs = require('fs');
const path = require('path');
const topojson = require(require('path').join(process.env.TEMP || '/tmp', 'opencode/worldmap/node_modules/topojson-client'));

const W = 720, H = 360, COLS = 120, ROWS = 60;
const topo = JSON.parse(fs.readFileSync(path.join(process.env.TEMP || '/tmp', 'opencode/worldmap/countries-110m.json'), 'utf8'));
const fc = topojson.feature(topo, topo.objects.countries);

function ringsOf(geom) {
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
const polys = [];
for (const f of fc.features) {
  for (const poly of ringsOf(f.geometry)) {
    for (const ring of poly) {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const [x, y] of ring) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      polys.push({ ring, x0, x1, y0, y1 });
    }
  }
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const dots = [];
const land = new Set();
for (let r = 0; r < ROWS; r++) {
  const lat = 90 - ((r + 0.5) / ROWS) * 180;
  for (let c = 0; c < COLS; c++) {
    const lng = ((c + 0.5) / COLS) * 360 - 180;
    for (const p of polys) {
      if (lng < p.x0 || lng > p.x1 || lat < p.y0 || lat > p.y1) continue;
      if (inRing(lng, lat, p.ring)) { land.add(c + ',' + r); break; }
    }
  }
}
// Dilate by one cell so coastlines and small islands read clearly as dot art.
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    let hit = land.has(c + ',' + r);
    if (!hit) {
      for (let dr = -1; dr <= 1 && !hit; dr++) {
        for (let dc = -1; dc <= 1 && !hit; dc++) {
          if (land.has((c + dc) + ',' + (r + dr))) hit = true;
        }
      }
    }
    if (hit) dots.push([c, r]);
  }
}

const REGIONS = [
  ['Nigeria', 9.1, 8.7], ['Ghana', 7.9, -1.2], ['Kenya', 0.5, 37.9],
  ['South Africa', -29, 25], ['Senegal', 14.5, -14.5], ['Ethiopia', 9.1, 40.5],
  ['Egypt', 26.8, 30.8], ['United States', 39.8, -98.6], ['United Kingdom', 54, -2],
  ['Germany', 51.2, 10.4], ['Canada', 56.1, -106.3], ['Australia', -25.3, 133.8],
  ['France', 46.6, 2.4], ['India', 21.1, 78.7], ['Pakistan', 30.4, 69.3],
  ['Philippines', 12.9, 121.8], ['China', 35.9, 104.2], ['Japan', 36.2, 138.3],
  ['South Korea', 36.4, 127.9], ['UAE', 24.2, 54.3], ['Turkey', 39, 35.2],
  ['Brazil', -10.8, -52.9], ['Mexico', 23.6, -102.5], ['Indonesia', -2.5, 118],
  ['Malaysia', 4.2, 102.2], ['Singapore', 1.35, 103.8], ['Sweden', 62, 15],
  ['Netherlands', 52.2, 5.3], ['Italy', 42.8, 12.8], ['Spain', 40.3, -3.7],
  ['Ukraine', 48.4, 31.2], ['Kazakhstan', 48, 66.9], ['Colombia', 4.6, -73]
];
const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'showcase-names.json'), 'utf8'));
const counts = {};
for (const e of names) counts[e.region] = (counts[e.region] || 0) + 1;
const markers = REGIONS.map(([region, lat, lng]) => ({
  region,
  x: +(((lng + 180) / 360) * W).toFixed(1),
  y: +(((90 - lat) / 180) * H).toFixed(1),
  members: counts[region] || 0
}));

const out = { w: W, h: H, cols: COLS, rows: ROWS, dots, markers };
fs.writeFileSync(path.join(__dirname, 'worldmap.json'), JSON.stringify(out));
console.log(`dots: ${dots.length}, markers: ${markers.length}, bytes: ${JSON.stringify(out).length}`);
