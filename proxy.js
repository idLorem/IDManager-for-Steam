const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// One proxy for everything the program sends to Steam: logins (steam-user), web requests (steamcommunity) and the ID search.
// Cloudflare WARP in proxy mode (warp-cli mode proxy) is a SOCKS5 proxy on 127.0.0.1:40000.
let url = '', agent = null, down = false; // down: the proxy does not answer, the search goes on without it until it is back
const SCHEME = /^(socks[45]h?|https?):\/\/[^\s/]+$/i;

// '' switches the proxy off; a bare host:port is taken as SOCKS5 (name resolved by the proxy, so a blocked local DNS does not matter)
function set(v) {
  v = String(v || '').trim();
  if (v && !v.includes('://')) v = 'socks5h://' + v;
  if (v && !SCHEME.test(v)) throw Object.assign(new Error('bad proxy'), { key: 'proxyBad' });
  if (v === url) return url;
  url = v;
  down = false;
  agent = !v ? null : /^socks/i.test(v) ? new SocksProxyAgent(v, { keepAlive: true }) : new HttpsProxyAgent(v, { keepAlive: true });
  return url;
}
const get = () => url;
// options of the two Steam libraries; empty when no proxy is set
const live = () => !!agent && !down; // true when requests really go through the proxy
const userOpts = () => (!live() ? {} : /^socks/i.test(url) ? { socksProxy: url } : { httpProxy: url });
const useOn = (community) => { if (live() && community.request) community.request = community.request.defaults({ agent }); return community; };

// A small fetch for the ID search through the proxy (Node's own fetch cannot use SOCKS). Same shape as fetch for what the search reads.
function fetchVia(u, { headers, signal } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = (/^http:/i.test(u) ? http : https).get(u, { agent: agent || undefined, headers, signal }, (res) => {
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && hops < 3) { res.resume(); return resolve(fetchVia(new URL(loc, u).href, { headers, signal }, hops + 1)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null }, text: async () => body });
      });
    });
    req.on('error', reject);
  });
}
// the search uses this: plain fetch without a proxy, the proxy version with one
const search = (u, o) => (live() ? fetchVia(u, o) : fetch(u, o));
const setDown = (v) => { down = !!v && !!agent; };
// does the proxy answer (always asked through the proxy, even while it counts as down)
const ping = () => fetchVia('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) }).then((r) => r.status === 200, () => false);

// what Cloudflare sees of the connection: the address, the country and whether WARP is on
async function test() {
  const r = await fetchVia('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(10000) });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const t = Object.fromEntries((await r.text()).split('\n').map((l) => l.split('=')).filter((p) => p.length === 2));
  return { via: url ? 'proxy' : 'direct', ip: t.ip || '?', loc: t.loc || '?', warp: t.warp || '?' };
}

module.exports = { set, get, live, setDown, ping, userOpts, useOn, search, test };
