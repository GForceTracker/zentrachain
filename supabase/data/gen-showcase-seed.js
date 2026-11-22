// Generates supabase/data/showcase-seed.sql from showcase-names.json.
// Deterministic (seeded RNG) so sandbox and production seeds are identical.
const fs = require('fs');
const path = require('path');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const PAIRS = [
  ['USDT', 'TRC20'], ['USDT', 'TRC20'], ['USDT', 'TRC20'],
  ['USDT', 'ERC20'], ['USDT', 'ERC20'],
  ['USDT', 'BEP20'], ['USDT', 'BEP20'],
  ['BTC', 'BITCOIN'], ['BTC', 'BITCOIN'],
  ['ETH', 'ETHEREUM'], ['ETH', 'ETHEREUM'],
  ['TRX', 'TRON'], ['TRX', 'TRON'],
  ['DOGE', 'DOGECOIN'],
  ['SOL', 'SOLANA']
];
const AMOUNTS = {
  USDT: [50, 15000, 2], BTC: [0.002, 0.5, 6], ETH: [0.05, 8, 4],
  TRX: [300, 60000, 0], DOGE: [500, 90000, 0], SOL: [1, 120, 2]
};
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
const HEX = '0123456789abcdef';
const str = (n, chars) => Array.from({ length: n }, () => chars[Math.floor(rand() * chars.length)]).join('');

function walletPreview(network) {
  switch (network) {
    case 'TRC20': return 'T' + str(3, ALNUM) + '…' + str(4, ALNUM);
    case 'ERC20':
    case 'BEP20':
    case 'ETHEREUM': return '0x' + str(2, HEX) + '…' + str(4, HEX);
    case 'BITCOIN': return 'bc1q' + '…' + str(4, ALNUM.toLowerCase());
    case 'TRON': return 'T' + str(3, ALNUM) + '…' + str(4, ALNUM);
    case 'DOGECOIN': return 'D' + str(3, ALNUM) + '…' + str(4, ALNUM);
    case 'SOLANA': return str(3, ALNUM) + '…' + str(3, ALNUM);
    default: return '…' + str(6, ALNUM);
  }
}
const esc = (s) => s.replace(/'/g, "''");

const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'showcase-names.json'), 'utf8'));
const now = Date.now();
const rows = names.map((entry, i) => {
  const [asset, network] = pick(PAIRS);
  const [lo, hi, dec] = AMOUNTS[asset];
  const amount = (lo + rand() * (hi - lo)).toFixed(dec);
  const direction = i % 2 === 0 ? 'deposit' : 'withdrawal';
  const occurred = new Date(now - Math.floor(rand() * 45 * 24 * 3600 * 1000)).toISOString();
  return `('${esc(entry.name)}','${direction}','${asset}','${network}',${amount},'${walletPreview(network)}','${occurred}')`;
});

const sql = `-- Community showcase seed: ${rows.length} entries.\n` +
  `-- Generated from supabase/data/showcase-names.json (deterministic).\n` +
  `insert into public.activity_showcase (display_name, direction, asset, network, amount, wallet_preview, occurred_at)\nvalues\n` +
  rows.join(',\n') + `\non conflict do nothing;\n`;
fs.writeFileSync(path.join(__dirname, 'showcase-seed.sql'), sql);
console.log(`showcase-seed.sql written: ${rows.length} rows`);
