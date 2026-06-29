/* netsuite-replen.js — "Items Sold" floor-replenishment feed for the sales kiosk.
   Pulls TODAY's Shopify POS line-items (source_name:pos), aggregates by SKU, then asks NetSuite
   for each SKU's product name, brand, and HIGHEST on-hand Loc-2 warehouse bin to pull from.
   Writes window.SALES_SEED.replen = [{sku,name,brand,units,bin,binOh,at}] (preserving all other
   seed fields). Runs AFTER sales-fetch.js in the cloud sync. Non-fatal: on any fetch error it
   exits non-zero WITHOUT writing, so a NetSuite hiccup never clobbers a good seed.
   Usage: node netsuite-replen.js [sales-seed.js path] */
const path = require('path');
const fs = require('fs');
const { graphql } = require('./shopify');
const { suiteql } = require('./netsuite');

const SEED_PATH = process.argv[2] || 'sales-seed.js';
const TZ = 'Australia/Melbourne';
const melOffset = d => (new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
  .formatToParts(d).find(x => x.type === 'timeZoneName').value.replace('GMT', '') || '+10:00');
const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function gql(q, vars) {
  for (let i = 0; i < 6; i++) {
    try { return await graphql(q, vars); }
    catch (e) { if (/THROTTLED|Throttled|exceeded/i.test(e.message) && i < 5) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; } throw e; }
  }
}
async function pagePos(q) {
  let after = null, out = [];
  for (;;) {
    const d = await gql(`query($q:String!,$a:String){ orders(first:100, after:$a, query:$q, sortKey:CREATED_AT, reverse:true){ nodes{ createdAt lineItems(first:50){ nodes{ sku quantity name } } } pageInfo{ hasNextPage endCursor } } }`, { q, a: after });
    out.push(...d.orders.nodes);
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  const off = melOffset(new Date());
  const q = `source_name:pos created_at:>='${todayKey}T00:00:00${off}'`;
  const orders = await pagePos(q);

  // aggregate today's POS sales by SKU: total units + most-recent sale time + a fallback name
  const agg = new Map();
  for (const o of orders) for (const li of (o.lineItems.nodes || [])) {
    if (!li.sku) continue;
    if (!agg.has(li.sku)) agg.set(li.sku, { sku: li.sku, units: 0, name: li.name || '', at: o.createdAt });
    const a = agg.get(li.sku);
    a.units += li.quantity || 0;
    if (new Date(o.createdAt) > new Date(a.at)) a.at = o.createdAt;
  }
  const items = [...agg.values()];

  let replen = [];
  if (items.length) {
    const inC = items.map(i => "'" + i.sku.replace(/'/g, "''") + "'").join(',');
    // name + brand
    const meta = {};
    for (const r of await suiteql(`SELECT itemid AS sku, displayname AS nm, BUILTIN.DF(cseg_ps_brand) AS brand FROM item WHERE itemid IN (${inC})`))
      meta[r.sku] = { nm: r.nm || '', brand: r.brand || '' };
    // highest on-hand Loc-2 bin per SKU
    const best = {};
    for (const r of await suiteql(`SELECT i.itemid AS sku, BUILTIN.DF(ibq.bin) AS bin, ibq.onhand AS oh FROM itembinquantity ibq JOIN item i ON i.id=ibq.item JOIN bin b ON b.id=ibq.bin WHERE i.itemid IN (${inC}) AND b.location=2 AND ibq.onhand>0`)) {
      const oh = Number(r.oh) || 0;
      if (!best[r.sku] || oh > best[r.sku].oh) best[r.sku] = { bin: r.bin, oh };
    }
    replen = items.map(it => ({
      sku: it.sku, units: it.units,
      name: (meta[it.sku] && meta[it.sku].nm) || it.name,
      brand: (meta[it.sku] && meta[it.sku].brand) || '',
      bin: (best[it.sku] && best[it.sku].bin) || null,
      binOh: (best[it.sku] && best[it.sku].oh) || 0,
      at: it.at,
    })).sort((a, b) => new Date(a.at) - new Date(b.at)); // oldest first (most urgent)
  }

  // merge into the existing seed (preserve every other field)
  global.window = global.window || {};
  require(path.resolve(SEED_PATH));
  const seed = global.window.SALES_SEED || {};
  seed.replen = replen;
  const header = '/* sales-seed.js — DATA ONLY. Refreshed by GitHub Actions (cloud sync). Real Shopify POS data. */\n';
  fs.writeFileSync(SEED_PATH, header + 'window.SALES_SEED = ' + JSON.stringify(seed) + ';\n');
  console.log(`netsuite-replen OK: ${replen.length} SKUs sold today, ${replen.filter(r => !r.bin).length} with no Loc-2 stock`);
}
main().catch(e => { console.error('netsuite-replen FAILED: ' + e.message); process.exit(1); });
