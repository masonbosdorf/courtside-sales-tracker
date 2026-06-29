/* netsuite.js — direct SuiteQL over NetSuite REST using Token-Based Auth (OAuth 1.0a,
   HMAC-SHA256). Works headless/cron — no claude.ai connector, no interactive auth.
   Reads creds from ~/.config/fulfilment-sync/credentials.json (chmod 600).
   Module:  const {suiteql} = require('./netsuite'); await suiteql("SELECT ...")
   CLI:     node netsuite.js "SELECT COUNT(*) AS n FROM transaction WHERE recordtype='itemfulfillment'" */
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const c = require('./creds');                 // local file OR FS_* env vars (cloud)

// RFC-3986 percent-encoding
const pe = s => encodeURIComponent(String(s))
  .replace(/[!*'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url) {
  const oauth = {
    oauth_consumer_key:     c.consumerKey,
    oauth_token:            c.tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_version:          '1.0',
  };
  const paramStr = Object.keys(oauth).sort()
    .map(k => pe(k) + '=' + pe(oauth[k])).join('&');
  const base = method.toUpperCase() + '&' + pe(url) + '&' + pe(paramStr);
  const signingKey = pe(c.consumerSecret) + '&' + pe(c.tokenSecret);
  const signature = crypto.createHmac('sha256', signingKey).update(base).digest('base64');
  return 'OAuth realm="' + c.account + '", ' +
    Object.keys(oauth).map(k => pe(k) + '="' + pe(oauth[k]) + '"').join(', ') +
    ', oauth_signature="' + pe(signature) + '"';
}

function suiteql(q) {
  const host = c.account.toLowerCase().replace(/_/g, '-') + '.suitetalk.api.netsuite.com';
  const reqPath = '/services/rest/query/v1/suiteql';
  const url = 'https://' + host + reqPath;
  const body = JSON.stringify({ q });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path: reqPath, method: 'POST',
      headers: {
        'Authorization':  authHeader('POST', url),
        'Content-Type':   'application/json',
        'Prefer':         'transient',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        let j; try { j = JSON.parse(data); } catch (e) { return reject(new Error('NS parse error: ' + data.slice(0, 300))); }
        if (res.statusCode >= 400) return reject(new Error('NS HTTP ' + res.statusCode + ': ' + data.slice(0, 400)));
        resolve(Array.isArray(j.items) ? j.items : []); // SuiteQL returns rows under .items
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { suiteql };

if (require.main === module) {
  const q = process.argv[2] || "SELECT COUNT(*) AS n FROM transaction WHERE recordtype='itemfulfillment'";
  suiteql(q).then(r => console.log(JSON.stringify(r, null, 2)))
            .catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
