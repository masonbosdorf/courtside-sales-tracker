/* sales-fetch.js — Courtside retail SALES tracker data engine. Pure node, Shopify-only,
   headless-reliable (CCG token via shopify.js). No NetSuite, no Claude.

   Pulls POS sales for THIS WEEK (Mon→now) with order timeline events (staff attribution) and
   line-item vendors (brand split), derives TODAY as the same-day subset, and pulls LAST WEEK
   (same elapsed) lightly for the vs-last-week deltas. Writes window.SALES_SEED to sales-seed.js.

   Usage: node sales-fetch.js [sales-seed.js path]
   POS order = sourceName === 'pos'. Staff = the "<name> processed this order[ for ...] on
   Shopify POS" timeline event. Sales = currentTotalPrice (net of refunds). Brand = product vendor. */
const { graphql } = require('./shopify');
const fs = require('fs');

const SEED_PATH = process.argv[2] || 'sales-seed.js';
const TZ = 'Australia/Melbourne';

/* ---- targets (only the $ day target is business-set; the rest are sensible KPI benchmarks) ---- */
const CFG = { WEEKDAY_TARGET: 10000, WEEKEND_TARGET: 15000, WEEK_TARGET: 80000, UPT_TARGET: 2.0, ATV_TARGET: 140 };
// Daily $ target by Melbourne weekday: Mon–Fri = $10k, Sat & Sun = $15k (week total Mon–Sun = $80k).

/* ---------- Melbourne date helpers (Intl only → portable on the Ubuntu runner) ---------- */
const melParts = d => { const o = {}; for (const p of new Intl.DateTimeFormat('en-CA',
  { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' })
  .formatToParts(d)) o[p.type] = p.value; return o; };
const melOffset = d => (new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName:'longOffset' })
  .formatToParts(d).find(x => x.type === 'timeZoneName').value.replace('GMT','') || '+10:00');
const melWeekdayIdx = d => ({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6})[
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday:'short' }).format(d)];
const keyOfAnchor = a => `${a.getUTCFullYear()}-${String(a.getUTCMonth()+1).padStart(2,'0')}-${String(a.getUTCDate()).padStart(2,'0')}`;
const melDayKey = iso => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(iso));
const melHour   = iso => parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour:'2-digit', hourCycle:'h23' }).format(new Date(iso)), 10);
const melWdShort= iso => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday:'short' }).format(new Date(iso));
const labelDay  = key => new Intl.DateTimeFormat('en-AU', { timeZone:'UTC', weekday:'short', day:'numeric', month:'short' }).format(new Date(key+'T00:00:00Z'));
const hourLabel = h => h===0 ? '12am' : h===12 ? '12pm' : h<12 ? h+'am' : (h-12)+'pm';

/* ---------- brand display prettify ---------- */
const BRANDMAP = {NIKE:'Nike',JORDAN:'Jordan',ADIDAS:'adidas','WAY OF WADE':'Way of Wade','NEW ERA':'New Era',
  'RYOKO RAIN':'Ryoko Rain',VOUSETI:'Vouseti','NEW BALANCE':'New Balance','UNDER ARMOUR':'Under Armour',
  'MITCHELL & NESS':'Mitchell & Ness',ASICS:'ASICS',PUMA:'Puma','LI-NING':'Li-Ning','ON RUNNING':'On Running',
  CROCS:'Crocs',UGG:'UGG','FRANK GREEN':'Frank Green',STANCE:'Stance',BUCKETSQUAD:'BucketSquad',OTHER:'Other'};
const pretty = v => { if (!v) return 'Other'; const u = v.trim().toUpperCase();
  return BRANDMAP[u] || v.trim().split(/\s+/).map(w => w[0].toUpperCase()+w.slice(1).toLowerCase()).join(' '); };

/* ---------- Shopify paginated fetch with throttle backoff ---------- */
async function gql(q, vars) {
  for (let i = 0; i < 6; i++) {
    try { return await graphql(q, vars); }
    catch (e) { if (/THROTTLED|Throttled|exceeded/i.test(e.message) && i < 5) { await new Promise(r => setTimeout(r, 2000*(i+1))); continue; } throw e; }
  }
}
async function pageOrders(q, selection, mapFn) {
  let after = null, out = [], more = true;
  while (more) {
    const d = await gql(`query($q:String!,$a:String){ orders(first:50, after:$a, query:$q, sortKey:CREATED_AT){ nodes{ ${selection} } pageInfo{ hasNextPage endCursor } } }`, { q, a: after });
    out.push(...d.orders.nodes.map(mapFn));
    more = d.orders.pageInfo.hasNextPage; after = d.orders.pageInfo.endCursor;
  }
  return out;
}

const POSrx = /processed this order( for .*)? on Shopify POS/;
const num = x => parseFloat(x) || 0;

/* turn a list of POS order objects into a full metrics block */
function aggregate(posOrders, { paceMode, scope, sub, deltaLbl, salesTarget, prevSales, prevOrders }) {
  const staff = {}, brands = {}, buckets = {};
  let totalSales = 0, units = 0;
  for (const o of posOrders) {
    totalSales += o.sales; units += o.units;
    const nm = o.staff || 'Unattributed';
    (staff[nm] = staff[nm] || { name: nm, sales: 0, units: 0, orders: 0 });
    staff[nm].sales += o.sales; staff[nm].units += o.units; staff[nm].orders++;
    for (const li of o.lines) { const b = pretty(li.vendor); brands[b] = (brands[b] || 0) + num(li.amount); }
    const k = paceMode === 'daily' ? melDayKey(o.createdAt) : melHour(o.createdAt);
    buckets[k] = (buckets[k] || 0) + o.sales;
  }
  const orders = posOrders.length;
  const staffArr = Object.values(staff).sort((a, b) => b.sales - a.sales)
    .map(s => ({ name: s.name, sales: +s.sales.toFixed(2), units: s.units, orders: s.orders }));
  let brandArr = Object.entries(brands).map(([name, sales]) => ({ name, sales: +sales.toFixed(2) })).sort((a, b) => b.sales - a.sales);
  if (brandArr.length > 8) { const top = brandArr.slice(0, 8), rest = brandArr.slice(8).reduce((a, b) => a + b.sales, 0);
    let o = top.find(b => b.name === 'Other'); if (o) o.sales = +(o.sales + rest).toFixed(2); else top.push({ name:'Other', sales:+rest.toFixed(2) });
    brandArr = top.sort((a, b) => b.sales - a.sales); }
  let labels = [], values = [], peak = '';
  if (paceMode === 'daily') {
    const keys = Object.keys(buckets).sort();
    labels = keys.map(k => melWdShort(k+'T12:00:00Z')); values = keys.map(k => Math.round(buckets[k]));
    if (keys.length) peak = melWdShort(keys.reduce((a, b) => buckets[b] > buckets[a] ? b : a, keys[0])+'T12:00:00Z');
  } else {
    const hrs = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    labels = hrs.map(hourLabel); values = hrs.map(h => Math.round(buckets[h]));
    if (hrs.length) { const ph = hrs.reduce((a, b) => buckets[b] > buckets[a] ? b : a, hrs[0]); peak = hourLabel(ph)+'–'+hourLabel((ph+1)%24); }
  }
  return {
    scope, sub, deltaLbl,
    totalSales: +totalSales.toFixed(2), posOrders: orders, units,
    salesTarget, salesDelta: +(totalSales - prevSales).toFixed(2), ordersDelta: orders - prevOrders,
    upt: orders ? +(units / orders).toFixed(2) : 0, uptTarget: CFG.UPT_TARGET,
    atv: orders ? +(totalSales / orders).toFixed(2) : 0, atvTarget: CFG.ATV_TARGET,
    atvDelta: (orders && prevOrders) ? +((totalSales/orders) - (prevSales/prevOrders)).toFixed(2) : 0,
    staff: staffArr, brands: brandArr, pace: { labels, values, peak },
  };
}

async function main() {
  const now = new Date();
  const p = melParts(now), off = melOffset(now), nowHM = `${p.hour}:${p.minute}`;
  const anchor = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, 12)); // UTC-noon on today's Mel date
  const addDays = (a, n) => { const d = new Date(a); d.setUTCDate(d.getUTCDate() + n); return d; };
  const back = melWeekdayIdx(now) === 0 ? 6 : melWeekdayIdx(now) - 1;   // days since Monday
  const todayKey = keyOfAnchor(anchor), tomorrowKey = keyOfAnchor(addDays(anchor, 1));
  const monKey   = keyOfAnchor(addDays(anchor, -back));
  const lwTodayKey = keyOfAnchor(addDays(anchor, -7)), lwMonKey = keyOfAnchor(addDays(anchor, -7 - back));

  // THIS WEEK (Mon 00:00 → end of today): full detail for staff + brands + pace
  const SEL_FULL = `name createdAt sourceName currentSubtotalLineItemsQuantity
    currentTotalPriceSet{ shopMoney{ amount } }
    events(first:6){ edges{ node{ message } } }
    lineItems(first:20){ edges{ node{ vendor quantity discountedTotalSet{ shopMoney{ amount } } } } }`;
  const mapFull = n => {
    const msgs = (n.events?.edges || []).map(e => e.node.message);
    const pm = msgs.find(m => POSrx.test(m));
    return {
      name: n.name, createdAt: n.createdAt, src: n.sourceName,
      sales: num(n.currentTotalPriceSet?.shopMoney?.amount), units: n.currentSubtotalLineItemsQuantity || 0,
      staff: pm ? pm.replace(/ processed this order.*/, '').trim() : null,
      lines: (n.lineItems?.edges || []).map(e => ({ vendor: e.node.vendor, amount: e.node.discountedTotalSet?.shopMoney?.amount })),
    };
  };
  const weekAll = await pageOrders(
    `created_at:>='${monKey}T00:00:00${off}' created_at:<'${tomorrowKey}T00:00:00${off}'`, SEL_FULL, mapFull);
  const weekPos = weekAll.filter(o => o.src === 'pos');
  const todayPos = weekPos.filter(o => melDayKey(o.createdAt) === todayKey);

  // LAST WEEK (same elapsed: Mon-7 00:00 → today-7 at now-time): light, POS totals only for deltas
  const SEL_LITE = `sourceName createdAt currentTotalPriceSet{ shopMoney{ amount } }`;
  const lwAll = await pageOrders(
    `created_at:>='${lwMonKey}T00:00:00${off}' created_at:<'${lwTodayKey}T${nowHM}:00${off}'`,
    SEL_LITE, n => ({ src: n.sourceName, createdAt: n.createdAt, sales: num(n.currentTotalPriceSet?.shopMoney?.amount) }));
  const lwPos = lwAll.filter(o => o.src === 'pos');
  const lwSameDayPos = lwPos.filter(o => melDayKey(o.createdAt) === lwTodayKey);
  const sum = arr => arr.reduce((a, b) => a + b.sales, 0);

  const wdName = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long' }).format(now);
  const wd = melWeekdayIdx(now);                                              // 0=Sun … 6=Sat (Melbourne)
  const dayTarget = (wd === 0 || wd === 6) ? CFG.WEEKEND_TARGET : CFG.WEEKDAY_TARGET;  // weekend $15k, weekday $10k
  const day = aggregate(todayPos, {
    paceMode: 'hourly', scope: labelDay(todayKey), sub: 'today · trading',
    deltaLbl: 'vs last ' + wdName, salesTarget: dayTarget,
    prevSales: sum(lwSameDayPos), prevOrders: lwSameDayPos.length });
  const week = aggregate(weekPos, {
    paceMode: 'daily', scope: `${labelDay(monKey).replace(/ \w+$/, '')} – ${labelDay(todayKey)}`, sub: 'this week · Mon–Sun',
    deltaLbl: 'vs last week', salesTarget: CFG.WEEK_TARGET,
    prevSales: sum(lwPos), prevOrders: lwPos.length });

  // stamp asOf in Melbourne local time (DST-safe), then write the seed
  const fo = {}; for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(now)) fo[x.type] = x.value;
  const asOf = `${fo.year}-${fo.month}-${fo.day}T${fo.hour}:${fo.minute}:${fo.second}${off}`;

  const seed = { asOf, day, week };
  const header = '/* sales-seed.js — DATA ONLY. Refreshed by GitHub Actions (cloud sync). Real Shopify POS data. */\n';
  fs.writeFileSync(SEED_PATH, header + 'window.SALES_SEED = ' + JSON.stringify(seed) + ';\n');
  console.log(`sales-fetch OK  today ${day.scope}: $${day.totalSales} / ${day.posOrders} orders / ${day.units}u  (week $${week.totalSales} / ${week.posOrders})  asOf ${asOf}`);
}
main().catch(e => { console.error('sales-fetch FAILED: ' + e.message); process.exit(1); });
