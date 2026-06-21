/* creds.js — load fulfilment-sync credentials from the local file (laptop/dev) OR from
   environment variables (cloud / GitHub Actions). The local chmod-600 file wins when present;
   if it's absent (e.g. a CI runner), the FS_* env vars are used instead. No secrets live here. */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

function fromEnv() {
  const e = process.env;
  return {
    account:             e.FS_ACCOUNT,
    consumerKey:         e.FS_CONSUMER_KEY,
    consumerSecret:      e.FS_CONSUMER_SECRET,
    tokenId:             e.FS_TOKEN_ID,
    tokenSecret:         e.FS_TOKEN_SECRET,
    shopifyDomain:       e.FS_SHOPIFY_DOMAIN,
    shopifyClientId:     e.FS_SHOPIFY_CLIENT_ID,
    shopifyClientSecret: e.FS_SHOPIFY_CLIENT_SECRET,
  };
}

function load() {
  const p = process.env.FS_CRED || process.env.NS_CRED ||
    path.join(os.homedir(), '.config', 'fulfilment-sync', 'credentials.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* fall through to env */ }
  return fromEnv();
}

module.exports = load();
