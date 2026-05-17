#!/usr/bin/env node
/**
 * Push Codex CLI token to 27c.site
 * Usage: node push-token.js [server_url]
 */
const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');

const SERVER = process.argv[2] || 'https://27c.site';
const AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

try {
  const raw = fs.readFileSync(AUTH_FILE, 'utf8');
  const auth = JSON.parse(raw);
  const t = auth.tokens || {};

  if (!t.access_token || !t.account_id) {
    console.error('Error: access_token or account_id not found in auth.json');
    process.exit(1);
  }

  const body = JSON.stringify({
    access_token: t.access_token,
    account_id: t.account_id,
    refresh_token: t.refresh_token || '',
    name: auth.email || undefined
  });

  const url = new URL(`${SERVER}/api/accounts/add`);
  const req = https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('✅ Token pushed to ' + SERVER);
        console.log('   Account: ' + t.account_id.slice(0, 8) + '...');
      } else {
        console.error('❌ Server returned ' + res.statusCode + ': ' + data);
      }
    });
  });
  req.on('error', e => console.error('❌ Connection failed: ' + e.message));
  req.write(body);
  req.end();
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error('Error: ' + AUTH_FILE + ' not found');
    console.error('Run "codex login" first');
  } else {
    console.error('Error: ' + e.message);
  }
  process.exit(1);
}
