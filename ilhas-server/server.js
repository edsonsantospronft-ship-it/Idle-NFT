// Ilhas do Portal — servidor multiplayer (Node.js + WebSocket)
// Entrega o jogo, faz login (Google, X, Telegram ou convidado), salva o personagem
// e sincroniza jogadores, chat e Mercado Global.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const SAVES = path.join(DATA, 'saves');
fs.mkdirSync(SAVES, { recursive: true });

// ---------- configuração dos logins (variáveis de ambiente) ----------
const CFG = {
  google: process.env.GOOGLE_CLIENT_ID || '',
  tgBot: process.env.TELEGRAM_BOT_NAME || '',
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  xId: process.env.X_CLIENT_ID || '',
  xSecret: process.env.X_CLIENT_SECRET || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
};

// ---------- persistência simples em JSON ----------
function load(name, def) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return def; } }
const saveT = {};
function save(name, obj) { clearTimeout(saveT[name]); saveT[name] = setTimeout(() => fs.writeFile(path.join(DATA, name), JSON.stringify(obj), () => {}), 300); }
const market = load('market.json', { next: 1, list: [] });
const proceeds = load('proceeds.json', {});
const accounts = load('accounts.json', {});   // id -> {id, provider, name, nick, created, seen}
const sessions = load('sessions.json', {});   // token -> {id, t}
const FEE = 0.05;
const SESSION_DAYS = 60;

const fileOf = (id) => path.join(SAVES, crypto.createHash('sha1').update(id).digest('hex') + '.json');
function readSave(id) { try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; } }
function writeSave(id, data) { fs.writeFile(fileOf(id), JSON.stringify(data), () => {}); }

function newSession(id) {
  const tok = crypto.randomBytes(24).toString('hex');
  sessions[tok] = { id, t: Date.now() }; save('sessions.json', sessions); return tok;
}
function accountOf(tok) {
  const s = tok && sessions[tok]; if (!s) return null;
  if (Date.now() - s.t > SESSION_DAYS * 864e5) { delete sessions[tok]; save('sessions.json', sessions); return null; }
  return accounts[s.id] || null;
}
function upsert(id, provider, name) {
  const a = accounts[id] || (accounts[id] = { id, provider, name: '', nick: '', created: Date.now() });
  a.name = String(name || a.name || '').slice(0, 40); a.seen = Date.now(); save('accounts.json', accounts); return a;
}
const pubAcc = (a) => ({ provider: a.provider, name: a.name, nick: a.nick, hasSave: fs.existsSync(fileOf(a.id)) });

// ---------- utilidades HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req, max = 2 * 1024 * 1024) {
  return new Promise((ok, bad) => { let n = 0; const ch = [];
    req.on('data', (c) => { n += c.length; if (n > max) { bad(new Error('too big')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch { ok({}); } });
    req.on('error', bad); });
}
function baseUrl(req) {
  if (CFG.publicUrl) return CFG.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return proto + '://' + req.headers.host;
}
const tokenOf = (req, url) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
const cleanNick = (s) => String(s || '').trim().slice(0, 16);
const nickOk = (s) => s.length >= 3 && /^[\p{L}\p{N}_ .-]+$/u.test(s);

// ---------- login: Google ----------
async function authGoogle(credential) {
  if (!CFG.google) throw new Error('Login com Google não configurado.');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  const d = await r.json();
  if (!r.ok || d.aud !== CFG.google || !['accounts.google.com', 'https://accounts.google.com'].includes(d.iss)) throw new Error('Login do Google inválido.');
  return upsert('google:' + d.sub, 'google', d.name || d.email || 'Google');
}
// ---------- login: Telegram ----------
function authTelegram(u) {
  if (!CFG.tgToken) throw new Error('Login com Telegram não configurado.');
  const { hash, ...rest } = u || {};
  const check = Object.keys(rest).filter((k) => rest[k] != null).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(CFG.tgToken).digest();
  const h = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!hash || h !== hash) throw new Error('Login do Telegram inválido.');
  if (Date.now() / 1000 - Number(rest.auth_date) > 86400) throw new Error('Login do Telegram expirou, tente de novo.');
  return upsert('telegram:' + rest.id, 'telegram', [rest.first_name, rest.last_name].filter(Boolean).join(' ') || rest.username || 'Telegram');
}
// ---------- login: X (OAuth 2.0 com PKCE) ----------
const xStates = new Map(); // state -> {verifier, t}
const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function xStart(req, res) {
  if (!CFG.xId) { res.writeHead(302, { location: '/?login_error=' + encodeURIComponent('Login com X não configurado.') }); return res.end(); }
  const verifier = b64u(crypto.randomBytes(48)), state = b64u(crypto.randomBytes(16));
  xStates.set(state, { verifier, t: Date.now() });
  const q = new URLSearchParams({ response_type: 'code', client_id: CFG.xId, redirect_uri: baseUrl(req) + '/auth/x/callback', scope: 'users.read tweet.read', state,
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
  res.writeHead(302, { location: 'https://x.com/i/oauth2/authorize?' + q }); res.end();
}
async function xCallback(req, res, url) {
  const fail = (m) => { res.writeHead(302, { location: '/?login_error=' + encodeURIComponent(m) }); res.end(); };
  try {
    const st = xStates.get(url.searchParams.get('state')); xStates.delete(url.searchParams.get('state'));
    if (!st || !url.searchParams.get('code')) return fail('Login com X cancelado ou expirado.');
    const form = new URLSearchParams({ code: url.searchParams.get('code'), grant_type: 'authorization_code', redirect_uri: baseUrl(req) + '/auth/x/callback', code_verifier: st.verifier, client_id: CFG.xId });
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (CFG.xSecret) headers.authorization = 'Basic ' + Buffer.from(CFG.xId + ':' + CFG.xSecret).toString('base64');
    const tr = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body: form });
    const tk = await tr.json(); if (!tr.ok || !tk.access_token) return fail('O X recusou o login.');
    const ur = await fetch('https://api.x.com/2/users/me', { headers: { authorization: 'Bearer ' + tk.access_token } });
    const ud = await ur.json(); if (!ur.ok || !ud.data) return fail('Não foi possível ler sua conta do X.');
    const a = upsert('x:' + ud.data.id, 'x', ud.data.name || ud.data.username);
    res.writeHead(302, { location: '/?session=' + newSession(a.id) }); res.end();
  } catch (e) { fail('Erro no login com X.'); }
}
setInterval(() => { const now = Date.now(); for (const [k, v] of xStates) if (now - v.t > 600000) xStates.delete(k); }, 60000);

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (p === '/auth/config') return json(res, 200, { google: CFG.google || null, telegram: CFG.tgBot && CFG.tgToken ? CFG.tgBot : null, x: !!CFG.xId, guest: true });
    if (p === '/auth/x') return xStart(req, res);
    if (p === '/auth/x/callback') return xCallback(req, res, url);
    if (req.method === 'POST' && p === '/auth/google') { const b = await body(req); const a = await authGoogle(b.credential); return json(res, 200, { token: newSession(a.id), account: pubAcc(a) }); }
    if (req.method === 'POST' && p === '/auth/telegram') { const b = await body(req); const a = authTelegram(b.user); return json(res, 200, { token: newSession(a.id), account: pubAcc(a) }); }
    if (req.method === 'POST' && p === '/auth/guest') {
      const b = await body(req); const gid = String(b.device || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      if (gid.length < 10) return json(res, 400, { error: 'Dispositivo inválido.' });
      const a = upsert('guest:' + gid, 'guest', 'Convidado'); return json(res, 200, { token: newSession(a.id), account: pubAcc(a) });
    }
    if (p === '/api/me') { const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' }); return json(res, 200, { account: pubAcc(a), save: readSave(a.id) }); }
    if (req.method === 'POST' && p === '/api/nick') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' });
      const b = await body(req); const n = cleanNick(b.nick); if (!nickOk(n)) return json(res, 400, { error: 'Nick inválido.' });
      const taken = Object.values(accounts).some((o) => o.id !== a.id && o.nick && o.nick.toLowerCase() === n.toLowerCase());
      if (taken) return json(res, 409, { error: 'Esse nick já está em uso. Escolha outro.' });
      a.nick = n; save('accounts.json', accounts); return json(res, 200, { account: pubAcc(a) });
    }
    if (req.method === 'POST' && p === '/api/save') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' });
      const b = await body(req); if (!b || typeof b.save !== 'object') return json(res, 400, { error: 'Save inválido.' });
      writeSave(a.id, b.save); a.seen = Date.now(); save('accounts.json', accounts); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/logout') { const t = tokenOf(req, url); delete sessions[t]; save('sessions.json', sessions); return json(res, 200, { ok: true }); }
    // arquivos do jogo
    const rel = p === '/' ? '/index.html' : p;
    const file = path.join(PUB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('não encontrado'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(buf);
    });
  } catch (e) { json(res, 400, { error: e.message || 'Erro.' }); }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const clients = new Map();
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, n);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg, filter) { const s = JSON.stringify(msg); for (const [ws, p] of clients) if (ws.readyState === 1 && (!filter || filter(p))) ws.send(s); }
function byPid(pid) { for (const [ws, p] of clients) if (p.pid === pid) return ws; return null; }
const publicMarket = () => market.list.map(({ pid, ...l }) => Object.assign(l, { spid: crypto.createHash('sha1').update(String(pid)).digest('hex').slice(0, 12) }));

wss.on('connection', (ws) => {
  const me = { pid: null, spid: '', nick: '?', guild: null, lvl: 1, b: 1, m: 0, x: 0, y: 0, dir: 'd', mv: 0, mount: '', lastChat: 0, ready: false };
  clients.set(ws, me);
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    switch (d.t) {
      case 'hello': {
        const acc = accountOf(d.token);
        me.pid = acc ? acc.id : 'anon:' + (clean(d.pid, 40) || Math.random().toString(36).slice(2));
        me.spid = crypto.createHash('sha1').update(me.pid).digest('hex').slice(0, 12);
        me.nick = (acc && acc.nick) || clean(d.nick, 16) || 'Aventureiro';
        me.guild = d.guild ? { name: clean(d.guild.name, 20), tag: clean(d.guild.tag, 4) } : null;
        me.lvl = num(d.lvl, 1); me.ready = true;
        const pr = proceeds[me.pid]; if (pr) { delete proceeds[me.pid]; save('proceeds.json', proceeds); }
        send(ws, { t: 'welcome', pid: me.spid, market: publicMarket(), proceeds: pr || null });
        broadcast({ t: 'chat', ch: 'sys', text: `${me.nick} entrou no mundo.` }, (p) => p !== me);
        break;
      }
      case 'pos':
        me.b = Math.max(1, Math.min(4, num(d.b, 1) | 0)); me.m = num(d.m, 0) | 0;
        me.x = num(d.x); me.y = num(d.y); me.dir = clean(d.dir, 1) || 'd'; me.mv = d.mv ? 1 : 0;
        me.mount = clean(d.mount, 16); me.lvl = num(d.lvl, me.lvl);
        if (d.guild !== undefined) me.guild = d.guild ? { name: clean(d.guild.name, 20), tag: clean(d.guild.tag, 4) } : null;
        break;
      case 'chat': {
        const now = Date.now(); if (now - me.lastChat < 700) return; me.lastChat = now;
        const text = clean(d.text, 140).trim(); if (!text) return;
        const ch = d.ch === 'local' ? 'local' : 'global';
        broadcast({ t: 'chat', ch, from: me.nick, gtag: me.guild ? me.guild.tag : '', b: me.b, text }, ch === 'local' ? (p) => p.b === me.b && p.m === me.m : null);
        break;
      }
      case 'mk_list': {
        const it = d.item || {}; const price = Math.floor(num(d.price));
        if (!me.ready || price < 1 || price > 1e9) return send(ws, { t: 'mk_err', ref: d.ref, msg: 'Preço inválido.' });
        const l = { uid: market.next++, pid: me.pid, seller: me.nick, blk: me.b, price, cur: d.cur === 'ruby' ? 'ruby' : 'gold', kind: it.kind === 'eq' ? 'eq' : 'item', t: Date.now() };
        if (l.kind === 'eq') l.inst = it.inst; else { l.id = clean(it.id, 30); l.q = Math.max(1, num(it.q, 1) | 0); }
        market.list.push(l); save('market.json', market);
        send(ws, { t: 'mk_listed', ref: d.ref }); broadcast({ t: 'market', list: publicMarket() });
        break;
      }
      case 'mk_cancel': {
        const i = market.list.findIndex((l) => l.uid === d.uid && l.pid === me.pid); if (i < 0) return;
        const [l] = market.list.splice(i, 1); save('market.json', market);
        send(ws, { t: 'mk_cancelled', l }); broadcast({ t: 'market', list: publicMarket() });
        break;
      }
      case 'mk_buy': {
        const i = market.list.findIndex((l) => l.uid === d.uid);
        if (i < 0) return send(ws, { t: 'mk_err', msg: 'Este item já foi vendido ou retirado.' });
        const l = market.list[i]; if (l.pid === me.pid) return send(ws, { t: 'mk_err', msg: 'Você não pode comprar o seu próprio anúncio.' });
        market.list.splice(i, 1); save('market.json', market);
        send(ws, { t: 'mk_bought', l });
        const net = Math.max(0, Math.floor(l.price * (1 - FEE)));
        const sws = byPid(l.pid);
        if (sws) send(sws, { t: 'sold', l, net, buyer: me.nick });
        else { const pr = proceeds[l.pid] || (proceeds[l.pid] = { gold: 0, ruby: 0, sales: [] }); pr[l.cur] += net; pr.sales.push({ uid: l.uid, name: l.id || (l.inst && l.inst.id), q: l.q || 1, net, cur: l.cur, buyer: me.nick }); save('proceeds.json', proceeds); }
        broadcast({ t: 'market', list: publicMarket() });
        break;
      }
    }
  });
  ws.on('close', () => { clients.delete(ws); if (me.ready) broadcast({ t: 'chat', ch: 'sys', text: `${me.nick} saiu do mundo.` }); });
});

setInterval(() => {
  const rooms = new Map();
  for (const [, p] of clients) { if (!p.ready) continue; const k = p.b + ':' + p.m; (rooms.get(k) || rooms.set(k, []).get(k)).push(p); }
  for (const [ws, p] of clients) {
    if (!p.ready || ws.readyState !== 1) continue;
    const list = (rooms.get(p.b + ':' + p.m) || []).filter((o) => o !== p)
      .map((o) => [o.spid, o.nick, Math.round(o.x), Math.round(o.y), o.dir, o.mv, o.lvl, o.guild ? o.guild.tag : '', o.guild ? o.guild.name : '', o.mount]);
    ws.send(JSON.stringify({ t: 'ps', p: list }));
  }
}, 100);
setInterval(() => {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0 }; let total = 0;
  for (const [, p] of clients) if (p.ready) { c[p.b] = (c[p.b] || 0) + 1; total++; }
  broadcast({ t: 'blocks', c, total });
}, 2000);

server.listen(PORT, () => {
  console.log(`Ilhas do Portal rodando em http://localhost:${PORT}`);
  console.log(`Logins ativos: Google ${CFG.google ? 'sim' : 'não'} · X ${CFG.xId ? 'sim' : 'não'} · Telegram ${CFG.tgToken ? 'sim' : 'não'} · Convidado sim`);
});
