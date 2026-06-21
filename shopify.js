/* shopify.js — Shopify Admin API via Client Credentials Grant (CCG). Pure node, headless-reliable.
   Mints a short-lived access token from the app's clientId/secret (which DON'T expire), so the
   cron runs never need interactive auth again. Reads creds from ~/.config/fulfilment-sync/credentials.json.
   Module:  const {graphql} = require('./shopify'); await graphql("query{ ... }")
   CLI:     node shopify.js 'query{ shop{ name } }' */
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const c = require('./creds');                 // local file OR FS_* env vars (cloud)
const SHOP        = c.shopifyDomain;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';

let _tok = null, _exp = 0;

function postJson(reqPath, bodyObj, headers) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: SHOP, path: reqPath, method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        headers || {}),
    }, res => {
      let d = ''; res.on('data', x => (d += x));
      res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch (e) { return reject(new Error('Shopify parse ' + res.statusCode + ': ' + d.slice(0, 200))); }
        if (res.statusCode >= 400) return reject(new Error('Shopify HTTP ' + res.statusCode + ': ' + d.slice(0, 300)));
        resolve(j);
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function token() {
  if (_tok && Date.now() < _exp - 60000) return _tok;          // cache within the run
  const r = await postJson('/admin/oauth/access_token', {
    client_id: c.shopifyClientId, client_secret: c.shopifyClientSecret, grant_type: 'client_credentials',
  });
  _tok = r.access_token; _exp = Date.now() + (r.expires_in || 300) * 1000;
  return _tok;
}

async function graphql(query, variables) {
  const t = await token();
  const r = await postJson('/admin/api/' + API_VERSION + '/graphql.json',
    { query, variables: variables || {} }, { 'X-Shopify-Access-Token': t });
  if (r.errors) throw new Error('Shopify GraphQL: ' + JSON.stringify(r.errors).slice(0, 400));
  return r.data;
}

module.exports = { graphql, token };

if (require.main === module) {
  graphql(process.argv[2] || 'query{ shop{ name myshopifyDomain } }')
    .then(d => console.log(JSON.stringify(d, null, 2)))
    .catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
