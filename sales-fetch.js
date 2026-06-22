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
const CFG = { WEEKDAY_TARGET: 10000, WEEKEND_TARGET: 15000, WEEK_TARGET: 80000, UPT_TARGET: 2.0, ATV_TARGET: 200 };
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
    const k = (paceMode === 'daily' || paceMode === 'monthly') ? melDayKey(o.createdAt) : melHour(o.createdAt);
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
  if (paceMode === 'monthly') {
    const keys = Object.keys(buckets).sort();
    labels = keys.map(k => String(parseInt(k.slice(-2), 10))); values = keys.map(k => Math.round(buckets[k]));
    if (keys.length) peak = parseInt(keys.reduce((a, b) => buckets[b] > buckets[a] ? b : a, keys[0]).slice(-2), 10) + '';
  } else if (paceMode === 'daily') {
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

/* ---------- loyalty (Okendo CourtPass) — native Shopify, no DB ----------
   Enrolled = customer segment metafields.app--1576377--loyalty.status='Enrolled'.
   Signup-date proxy = customer_added_date (Melbourne, shop tz). Employee = staff on the POS
   order within 15 min of signup; web/no-order/CourtSide-Default → Online/unattributed. */
async function loyalty(k) {
  const SEG = "metafields.app--1576377--loyalty.status = 'Enrolled'";
  const cnt = async clause => {
    const q = clause ? `${SEG} AND ${clause}` : SEG;
    const d = await gql(`query($q:String!){ customerSegmentMembers(first:1, query:$q){ totalCount } }`, { q });
    return d.customerSegmentMembers.totalCount;
  };
  const total           = await cnt(null);
  const today           = await cnt(`customer_added_date >= ${k.todayKey}`);
  const thisWeek        = await cnt(`customer_added_date >= ${k.monKey}`);
  const thisMonth       = await cnt(`customer_added_date >= ${k.monthStartKey}`);
  const lastMonthToDate = await cnt(`customer_added_date >= ${k.lastMonthStartKey} AND customer_added_date < ${k.lastMonthCutoffKey}`);

  // this-month members → resolve each to first order for attribution + daily trend
  let after = null, more = true; const ids = [];
  while (more) {
    const d = await gql(`query($q:String!,$a:String){ customerSegmentMembers(first:250, after:$a, query:$q){ edges{ node{ id } } pageInfo{ hasNextPage endCursor } } }`,
      { q: `${SEG} AND customer_added_date >= ${k.monthStartKey}`, a: after });
    ids.push(...d.customerSegmentMembers.edges.map(e => e.node.id.replace('CustomerSegmentMember', 'Customer')));
    more = d.customerSegmentMembers.pageInfo.hasNextPage; after = d.customerSegmentMembers.pageInfo.endCursor;
  }
  const staff = {}, buckets = {}; let online = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql(`query($ids:[ID!]!){ nodes(ids:$ids){ ... on Customer { createdAt orders(first:1, sortKey:CREATED_AT){ nodes{ createdAt sourceName events(first:6){ edges{ node{ message } } } } } } } }`,
      { ids: ids.slice(i, i + 50) });
    for (const nd of (d.nodes || [])) {
      if (!nd) continue;
      const created = new Date(nd.createdAt).getTime();
      const o = (nd.orders?.nodes || [])[0];
      let emp = null;
      if (o && o.sourceName === 'pos') {
        const within = Math.abs(new Date(o.createdAt).getTime() - created) <= 900000;   // 15 min
        const pm = (o.events?.edges || []).map(e => e.node.message).find(m => POSrx.test(m));
        if (within && pm) { const nm = pm.replace(/ processed this order.*/, '').trim(); if (nm && nm !== 'CourtSide Default') emp = nm; }
      }
      if (emp) staff[emp] = (staff[emp] || 0) + 1; else online++;
      const dk = melDayKey(nd.createdAt); buckets[dk] = (buckets[dk] || 0) + 1;
    }
  }
  const leaderboard = Object.entries(staff).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const inStore = leaderboard.reduce((a, b) => a + b.count, 0);
  const dkeys = Object.keys(buckets).sort();
  const trend = {
    labels: dkeys.map(d => String(parseInt(d.slice(-2), 10))),
    values: dkeys.map(d => buckets[d]),
    peak: dkeys.length ? parseInt(dkeys.reduce((a, b) => buckets[b] > buckets[a] ? b : a, dkeys[0]).slice(-2), 10) + ' ' + k.monthAbbr : '',
  };
  return { total, today, thisWeek, thisMonth, lastMonthToDate, inStore, online, leaderboard, trend };
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
  // month keys for loyalty (this month-to-date vs same period last month)
  const monthStartKey = `${p.year}-${p.month}-01`;
  const lmLast = addDays(new Date(Date.UTC(+p.year, +p.month - 1, 1, 12)), -1);   // last day of previous month
  const lmYear = lmLast.getUTCFullYear(), lmMonth = String(lmLast.getUTCMonth() + 1).padStart(2, '0');
  const lastMonthStartKey = `${lmYear}-${lmMonth}-01`;
  const daysInLm = new Date(Date.UTC(lmYear, lmLast.getUTCMonth() + 1, 0)).getUTCDate();
  const lastMonthCutoffKey = `${lmYear}-${lmMonth}-${String(Math.min(+p.day + 1, daysInLm + 1)).padStart(2, '0')}`;
  const monthAbbr = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'short' }).format(now);

  // ---- previous seed: reuse the heavy MONTH + LOYALTY blocks between hourly refreshes ----
  let prevSeed = {};
  try { const sp = require('path').resolve(SEED_PATH); delete require.cache[sp]; global.window = {}; require(sp); prevSeed = global.window.SALES_SEED || {}; } catch (e) { /* first run / no seed */ }
  // DAY + WEEK refresh EVERY run; the heavy MONTH + LOYALTY pulls refresh ~once/hour (minute 00–11)
  // to spare the shared Shopify API. Always refresh if a block is missing (e.g. first run).
  const doHeavy = process.env.FORCE_HEAVY === '1' || (+p.minute < 12) || !prevSeed.month || !prevSeed.loyalty;

  // monthly $ target = sum of each day's target across the WHOLE month (weekday $10k, weekend $15k)
  const dim = new Date(Date.UTC(+p.year, +p.month, 0)).getUTCDate();
  let monthlyTarget = 0;
  for (let d = 1; d <= dim; d++) { const wdi = new Date(Date.UTC(+p.year, +p.month - 1, d, 12)).getUTCDay(); monthlyTarget += (wdi === 0 || wdi === 6) ? CFG.WEEKEND_TARGET : CFG.WEEKDAY_TARGET; }
  const monthName = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'long' }).format(now);

  // MAIN PULL (full detail) — spans the whole month on heavy runs (covers month+week+day), else just this week
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
  const periodStartKey = doHeavy ? (monthStartKey < monKey ? monthStartKey : monKey) : monKey;
  const periodAll = await pageOrders(
    `created_at:>='${periodStartKey}T00:00:00${off}' created_at:<'${tomorrowKey}T00:00:00${off}'`, SEL_FULL, mapFull);
  const periodPos = periodAll.filter(o => o.src === 'pos');
  const todayPos = periodPos.filter(o => melDayKey(o.createdAt) === todayKey);
  const weekPos  = periodPos.filter(o => melDayKey(o.createdAt) >= monKey);

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

  // MONTH (heavy) — refreshed hourly, reused from the previous seed otherwise
  let month;
  if (doHeavy) {
    const monthPos = periodPos.filter(o => melDayKey(o.createdAt) >= monthStartKey);
    const lmAll = await pageOrders(
      `created_at:>='${lastMonthStartKey}T00:00:00${off}' created_at:<'${lastMonthCutoffKey}T00:00:00${off}'`,
      SEL_LITE, n => ({ src: n.sourceName, sales: num(n.currentTotalPriceSet?.shopMoney?.amount) }));
    const lmPos = lmAll.filter(o => o.src === 'pos');
    month = aggregate(monthPos, {
      paceMode: 'monthly', scope: `${monthName} ${p.year}`, sub: `this month · 1–${+p.day} ${monthAbbr}`,
      deltaLbl: 'vs last month', salesTarget: monthlyTarget,
      prevSales: sum(lmPos), prevOrders: lmPos.length });
  } else { month = prevSeed.month; }

  // stamp asOf in Melbourne local time (DST-safe), then write the seed
  const fo = {}; for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(now)) fo[x.type] = x.value;
  const asOf = `${fo.year}-${fo.month}-${fo.day}T${fo.hour}:${fo.minute}:${fo.second}${off}`;

  // LOYALTY (heavy, hourly) — needs read_customers scope; non-fatal. Reuse prev block on light runs / failure.
  let loy = prevSeed.loyalty || null;
  if (doHeavy) {
    try { loy = await loyalty({ todayKey, monKey, monthStartKey, lastMonthStartKey, lastMonthCutoffKey, monthAbbr }); }
    catch (e) { console.error('loyalty skipped (' + e.message.slice(0, 120) + ')'); loy = prevSeed.loyalty || null; }
  }

  const seed = { asOf, day, week, month: month || null, loyalty: loy };
  const header = '/* sales-seed.js — DATA ONLY. Refreshed by GitHub Actions (cloud sync). Real Shopify POS data. */\n';
  fs.writeFileSync(SEED_PATH, header + 'window.SALES_SEED = ' + JSON.stringify(seed) + ';\n');
  console.log(`sales-fetch OK ${doHeavy ? '[heavy]' : '[light]'}  today ${day.scope}: $${day.totalSales}/${day.posOrders}o  week $${week.totalSales}/${week.posOrders}o  month ${month ? '$' + month.totalSales + '/' + month.posOrders + 'o' : '—'}  loyalty ${loy ? loy.total + 'm/' + loy.thisMonth + 'mo' : '—'}  asOf ${asOf}`);
}
main().catch(e => { console.error('sales-fetch FAILED: ' + e.message); process.exit(1); });
