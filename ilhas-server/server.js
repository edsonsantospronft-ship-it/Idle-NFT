// Ilhas do Portal — servidor multiplayer (Node.js + WebSocket)
// Entrega o jogo, faz login (Google, X, Telegram ou convidado), salva o personagem
// e sincroniza jogadores, chat e Mercado Global.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
let QR = null; try { QR = require('qrcode'); } catch { }

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
  mpToken: process.env.MP_ACCESS_TOKEN || '',
  pixKey: (process.env.PIX_KEY || '').trim(),
  pixName: (process.env.PIX_NAME || 'EDSON BISPO SANTOS').slice(0, 25),
  pixCity: (process.env.PIX_CITY || 'SAO PAULO').slice(0, 15),
  adminKey: process.env.ADMIN_KEY || '',
  passPrice: Number(process.env.PASS_PRICE || 29.90),
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
const castle = load('castle.json', { guild: null, champ: null, champPid: null, since: 0, tre: { gold: 0, ruby: 0, cristal: 0 }, buffs: [], titles: [], chestWeek: {}, crbuy: {} });
const week = () => Math.floor((Date.now() / 864e5 + 3) / 7);
const spidOf = (pid) => crypto.createHash('sha1').update(String(pid)).digest('hex').slice(0, 12);
const CHAMPS = load('champs.json', {});
const pubChamps = () => { const o = {}; for (const k in CHAMPS) o[k] = Object.values(CHAMPS[k]).sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 3).map(({ nick, cls, gtag, n }) => ({ nick, cls, gtag, n })); return o; };
const pubCastle = () => ({ guild: castle.guild, champ: castle.champ, champSpid: castle.champPid ? spidOf(castle.champPid) : '', since: castle.since, tre: castle.tre, buffs: castle.buffs, titles: castle.titles.map(({ pid, ...t }) => t) });
const crLeft = (pid) => { const r = castle.crbuy[pid]; return 50 - (r && r.w === week() ? r.n : 0); };
const CR_PRICE = 1000, CR_WEEK = 50;
// ---------- Cerco ao Castelo (uma arena por bloco) ----------
const SG_T = 50000, SG_C = 100000, SG_SH = 300, SG_CAP = 30, SG_RESET = 5 * 60 * 1000;
const SIEGE = {}; const sgOf = (b) => SIEGE[b] || (SIEGE[b] = { t: [SG_T, SG_T, SG_T], sh: SG_SH, cr: SG_C, resetAt: 0, winner: null });
const sgCount = (b) => { let n = 0; for (const [, p] of clients) if (p.ready && p.m === 11 && p.b === b) n++; return n; };
function sgBroadcast(b) { const s = sgOf(b); broadcast({ t: 'sg', b, s: { t: s.t, sh: s.sh, cr: s.cr, resetAt: s.resetAt, winner: s.winner, n: sgCount(b) } }, (p) => p.b === b); }
setInterval(() => { for (const b in SIEGE) if (SIEGE[b].dirty) { SIEGE[b].dirty = false; sgBroadcast(+b); } }, 150);
setInterval(() => { const now = Date.now(); for (const b in SIEGE) { const s = SIEGE[b]; if (s.resetAt && now >= s.resetAt) { SIEGE[b] = { t: [SG_T, SG_T, SG_T], sh: SG_SH, cr: SG_C, resetAt: 0, winner: null }; sgBroadcast(+b); } } }, 2000);
const SESSION_DAYS = 60;
const passes = load('passes.json', { orders: {}, grants: {} }); // orders: id -> {acc, nick, mode, status, created, paid}; grants: acc -> {until, pending:[orderId]}
const PASS_DAYS = 30;
// ---------- Mercado Pix (dinheiro real entre jogadores) ----------
const rmt = load('rmt.json', { next: 1, list: [], deliver: {} }); // list: {id, acc, seller, inst, price, st:'open'|'reserved'|'paid'|'done'|'cancel', buyer, buyerNick, until, t}
const RMT_HOLD = 30 * 60 * 1000;
const pixMask = (k) => { k = String(k || ''); return k.length <= 4 ? '****' : k.slice(0, 2) + '•••' + k.slice(-2); };
function rmtTick() { const now = Date.now(); let ch = false; for (const l of rmt.list) if (l.st === 'reserved' && l.until < now) { l.st = 'open'; l.buyer = null; l.buyerNick = null; ch = true } if (ch) save('rmt.json', rmt); }
setInterval(rmtTick, 30000);
const rmtPub = (l, me) => ({ id: l.id, seller: l.seller, inst: l.inst, price: l.price, st: l.st, mine: !!me && l.acc === me.id, buying: !!me && l.buyer === me.id, buyerNick: me && l.acc === me.id ? l.buyerNick : undefined, until: l.until,
  pix: me && l.buyer === me.id && (l.st === 'reserved' || l.st === 'paid') ? { key: (accounts[l.acc] && accounts[l.acc].pix || {}).key, name: (accounts[l.acc] && accounts[l.acc].pix || {}).name } : undefined });
function grantPass(orderId) {
  const o = passes.orders[orderId]; if (!o || o.status === 'approved') return;
  if (o.kind === 'shop') { o.status = 'approved'; o.paid = Date.now(); (shop.inv[o.acc] || (shop.inv[o.acc] = [])).push({ oid: o.id, sku: o.sku }); save('passes.json', passes); save('shop.json', shop); const ws0 = byPid(o.acc); if (ws0) send(ws0, { t: 'shop_ok', sku: o.sku }); return; }
  o.status = 'approved'; o.paid = Date.now();
  const g = passes.grants[o.acc] || (passes.grants[o.acc] = { until: 0, pending: [] });
  g.until = Math.max(Date.now(), g.until || 0) + PASS_DAYS * 864e5; g.pending.push(orderId);
  save('passes.json', passes);
  const ws = byPid(o.acc); if (ws) send(ws, { t: 'pass_ok' });
}
// ---------- Loja (compras com Pix direto na loja do jogo) ----------
const shop = load('shop.json', { inv: {} }); // inv: acc -> [{oid, sku}] baús pagos ainda não recebidos pelo jogo
const SHOP_SKUS = {
  bauSkin: { n: 'Baú de Skin', price: Number(process.env.PRICE_BAUSKIN || 29.90) },
  bauHab9: { n: 'Baú de Habilidade x9', price: Number(process.env.PRICE_BAUHAB9 || 44.90) },
  apoio: { n: 'Apoio ao Crescimento', price: Number(process.env.PRICE_APOIO || 30.00) },
  bauAuto: { n: 'Baú Kit Automação', price: Number(process.env.PRICE_BAUAUTO || 30.00) },
  tkArena: { n: 'Baú Ticket da Arena', price: Number(process.env.PRICE_TKARENA || 45.00) },
  tkBloco: { n: 'Baú Ticket de Mudança de Bloco', price: Number(process.env.PRICE_TKBLOCO || 45.00) } };
const pickW = (w) => { let t = 0; for (const k in w) t += w[k]; let x = Math.random() * t; for (const k in w) { x -= w[k]; if (x < 0) return +k; } return +Object.keys(w)[0]; };
const RAR_W = { 0: 45, 1: 28, 2: 17, 3: 8, 4: 2 };          // Comum, Incomum, Raro, Épico, Lendário
const SKIN_W = { 0: 55, 1: 30, 3: 12, 4: 3 };               // raridades das skins
const GRADE_W = { 1: 40, 2: 30, 3: 18, 4: 9, 5: 3 };        // graus das habilidades
function shopRoll(sku) {
  if (sku === 'bauSkin') return { rar: pickW(SKIN_W), r: Math.random() };
  if (sku === 'bauHab9') return { spins: Array.from({ length: 9 }, () => ({ g: pickW(GRADE_W), r: Math.random() })) };
  if (sku === 'apoio') return {};
  return { rar: pickW(RAR_W) };
}
// Pix estático (BR Code) com a chave do recebedor
const emv = (id, v) => id + String(v.length).padStart(2, '0') + v;
function crc16(str) { let c = 0xFFFF; for (let i = 0; i < str.length; i++) { c ^= str.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
const noAcc = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase();
function pixPayload(txid, amount) {
  const mai = emv('00', 'br.gov.bcb.pix') + emv('01', CFG.pixKey);
  let p = emv('00', '01') + emv('26', mai) + emv('52', '0000') + emv('53', '986') + emv('54', amount.toFixed(2)) + emv('58', 'BR') + emv('59', noAcc(CFG.pixName)) + emv('60', noAcc(CFG.pixCity)) + emv('62', emv('05', txid)) + '6304';
  return p + crc16(p);
}
async function mpCreate(orderId, acc, req, amount, desc) {
  const body = { transaction_amount: amount || CFG.passPrice, description: desc || 'Passe Mensal - Ilhas do Portal', payment_method_id: 'pix', external_reference: orderId,
    payer: { email: 'jogador.' + crypto.createHash('sha1').update(acc.id).digest('hex').slice(0, 10) + '@ilhasdoportal.com' },
    notification_url: baseUrl(req) + '/api/pass/webhook' };
  const r = await fetch('https://api.mercadopago.com/v1/payments', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CFG.mpToken, 'x-idempotency-key': orderId }, body: JSON.stringify(body) });
  const d = await r.json(); if (!r.ok) throw new Error('Mercado Pago recusou: ' + (d.message || r.status));
  const td = d.point_of_interaction && d.point_of_interaction.transaction_data || {};
  return { mpId: d.id, code: td.qr_code, img: td.qr_code_base64 ? 'data:image/png;base64,' + td.qr_code_base64 : null };
}
async function mpCheck(o) {
  if (!CFG.mpToken || !o.mpId) return o.status;
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + o.mpId, { headers: { authorization: 'Bearer ' + CFG.mpToken } });
  const d = await r.json(); if (r.ok && d.status === 'approved' && d.external_reference) grantPass(d.external_reference);
  return passes.orders[o.id] ? passes.orders[o.id].status : o.status;
}

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
const pubAcc = (a) => { const g = passes.grants[a.id]; return { provider: a.provider, name: a.name, nick: a.nick, cls: a.cls || null, blk: a.blk || null, hasSave: fs.existsSync(fileOf(a.id)), pass: g ? { until: g.until, pending: g.pending.length } : null }; };

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
    if (p === '/privacidade' || p === '/termos') {
      const priv = p === '/privacidade';
      const body = priv
        ? '<h1>Política de Privacidade — Ilhas do Portal</h1><p>Ao entrar com Google, X ou Telegram, o jogo recebe apenas um identificador da sua conta e o seu nome público, usados somente para salvar o seu personagem. Não coletamos senhas, não vendemos nem compartilhamos dados com terceiros.</p><p>Os dados salvos são: nick, progresso do personagem e anúncios do Mercado Global. Para excluir sua conta e seus dados, fale com o criador do jogo.</p><p>Contato: edsonsantospronft@gmail.com</p>'
        : '<h1>Termos de Serviço — Ilhas do Portal</h1><p>Ilhas do Portal é um jogo gratuito criado por Edson Bispo Santos. Ao jogar, você concorda em não usar trapaças, não ofender outros jogadores no chat e entende que o jogo pode mudar, ter o progresso reiniciado ou sair do ar a qualquer momento.</p><p>Itens, ouro e rubis não têm valor em dinheiro real.</p><p>Contato: edsonsantospronft@gmail.com</p>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${priv ? 'Privacidade' : 'Termos'} · Ilhas do Portal</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6;color:#2a1e14;background:#f6ecd8}h1{font-size:24px}a{color:#8a4a1a}</style></head><body>${body}<p><a href="/">Voltar ao jogo</a></p></body></html>`);
    }
    if (p === '/api/shop/info') return json(res, 200, { mode: CFG.mpToken ? 'auto' : CFG.pixKey ? 'manual' : null, items: Object.entries(SHOP_SKUS).map(([sku, v]) => ({ sku, n: v.n, price: v.price })) });
    if (req.method === 'POST' && p === '/api/shop/create') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Entre com uma conta para comprar na loja.' });
      const b = await body(req); const it = SHOP_SKUS[b.sku]; if (!it) return json(res, 400, { error: 'Produto não encontrado.' });
      const id = 'S' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
      const o = { id, acc: a.id, nick: a.nick, kind: 'shop', sku: b.sku, status: 'pending', created: Date.now(), amount: it.price };
      if (CFG.mpToken) { const m = await mpCreate(id, a, req, it.price, it.n + ' - Ilhas do Portal'); Object.assign(o, { mode: 'auto', mpId: m.mpId }); passes.orders[id] = o; save('passes.json', passes); return json(res, 200, { id, mode: 'auto', code: m.code, img: m.img, amount: o.amount }); }
      if (!CFG.pixKey) return json(res, 400, { error: 'O pagamento ainda não foi configurado pelo dono do jogo.' });
      const code = pixPayload(id, o.amount); const img = QR ? await QR.toDataURL(code, { margin: 1, width: 320 }) : null;
      Object.assign(o, { mode: 'manual' }); passes.orders[id] = o; save('passes.json', passes);
      return json(res, 200, { id, mode: 'manual', code, img, amount: o.amount });
    }
    if (req.method === 'POST' && p === '/api/shop/claim') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' });
      const L = shop.inv[a.id] || []; if (!L.length) return json(res, 200, { chests: [] });
      const chests = L.map((c) => Object.assign({ oid: c.oid, sku: c.sku }, shopRoll(c.sku))); delete shop.inv[a.id]; save('shop.json', shop);
      for (const c of chests) { const o = passes.orders[c.oid]; if (o) { o.delivered = Date.now(); o.roll = c; } } save('passes.json', passes);
      return json(res, 200, { chests });
    }
    if (p === '/api/pass/info') return json(res, 200, { price: CFG.passPrice, mode: CFG.mpToken ? 'auto' : CFG.pixKey ? 'manual' : null, days: PASS_DAYS });
    if (req.method === 'POST' && p === '/api/pass/create') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Entre com uma conta para comprar o passe.' });
      const id = 'P' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
      const o = { id, acc: a.id, nick: a.nick, status: 'pending', created: Date.now(), amount: CFG.passPrice };
      if (CFG.mpToken) { const m = await mpCreate(id, a, req); Object.assign(o, { mode: 'auto', mpId: m.mpId }); passes.orders[id] = o; save('passes.json', passes); return json(res, 200, { id, mode: 'auto', code: m.code, img: m.img, amount: o.amount }); }
      if (!CFG.pixKey) return json(res, 400, { error: 'O pagamento ainda não foi configurado pelo dono do jogo.' });
      const code = pixPayload(id, o.amount); const img = QR ? await QR.toDataURL(code, { margin: 1, width: 320 }) : null;
      Object.assign(o, { mode: 'manual' }); passes.orders[id] = o; save('passes.json', passes);
      return json(res, 200, { id, mode: 'manual', code, img, amount: o.amount });
    }
    if (p === '/api/pass/status' || p === '/api/shop/status') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' });
      const o = passes.orders[url.searchParams.get('id') || '']; if (!o || o.acc !== a.id) return json(res, 404, { error: 'Pedido não encontrado.' });
      if (o.mode === 'auto' && o.status !== 'approved') await mpCheck(o).catch(() => {});
      return json(res, 200, { status: passes.orders[o.id].status });
    }
    if (req.method === 'POST' && (p === '/api/pass/paid' || p === '/api/shop/paid')) {
      const a = accountOf(tokenOf(req, url)); const b = await body(req); const o = passes.orders[b.id || ''];
      if (!a || !o || o.acc !== a.id) return json(res, 404, { error: 'Pedido não encontrado.' });
      if (o.status === 'pending') { o.status = 'review'; o.claimedPaid = Date.now(); save('passes.json', passes); }
      return json(res, 200, { status: o.status });
    }
    if (req.method === 'POST' && p === '/api/pass/claim') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' });
      const g = passes.grants[a.id]; if (!g || !g.pending.length) return json(res, 200, { n: 0, until: g ? g.until : 0 });
      const n = g.pending.length; g.pending = []; save('passes.json', passes); return json(res, 200, { n, until: g.until });
    }
    if (p === '/api/pass/webhook' || p === '/api/shop/webhook') {
      let id = url.searchParams.get('data.id') || url.searchParams.get('id'); if (req.method === 'POST') { const b = await body(req).catch(() => ({})); id = id || (b.data && b.data.id); }
      if (id && CFG.mpToken) { const o = Object.values(passes.orders).find((x) => String(x.mpId) === String(id)); if (o) await mpCheck(o).catch(() => {}); }
      res.writeHead(200); return res.end('ok');
    }
    if (req.method === 'POST' && p === '/api/blk') { const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' }); const b = await body(req); a.blk = Math.max(1, Math.min(NBLK, num(b.blk, 1) | 0)); save('accounts.json', accounts); return json(res, 200, { blk: a.blk }); }
    if (p.startsWith('/api/rmt/')) {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Entre com a sua conta.' });
      rmtTick(); const act = p.slice(9); const b = req.method === 'POST' ? await body(req) : {};
      const L = (id) => rmt.list.find((x) => x.id === +id);
      if (act === 'list') return json(res, 200, { list: rmt.list.filter((l) => l.st === 'open' || l.st === 'reserved' || ((l.st === 'paid' || l.st === 'done') && (l.acc === a.id || l.buyer === a.id))).map((l) => rmtPub(l, a)), pix: a.pix ? { key: pixMask(a.pix.key), name: a.pix.name } : null, deliver: (rmt.deliver[a.id] || []).length });
      if (act === 'pix') { const key = clean(b.key, 80).trim(), name = clean(b.name, 60).trim(); if (key.length < 5 || name.length < 3) return json(res, 400, { error: 'Informe a chave Pix e o nome do titular.' }); a.pix = { key, name }; save('accounts.json', accounts); return json(res, 200, { pix: { key: pixMask(key), name } }); }
      if (act === 'sell') { if (!a.pix) return json(res, 400, { error: 'Cadastre a sua chave Pix antes de anunciar.' }); const inst = b.inst; const price = Math.round(num(b.price) * 100) / 100;
        if (!inst || typeof inst !== 'object' || !inst.bal || !(inst.rar >= 3)) return json(res, 400, { error: 'Só itens com a balança podem ser vendidos por dinheiro.' });
        if (price < 1 || price > 5000) return json(res, 400, { error: 'O preço deve ficar entre R$ 1,00 e R$ 5.000,00.' });
        if (rmt.list.filter((l) => l.acc === a.id && (l.st === 'open' || l.st === 'reserved' || l.st === 'paid')).length >= 10) return json(res, 400, { error: 'Limite de 10 anúncios ativos.' });
        const l = { id: rmt.next++, acc: a.id, seller: a.nick || a.name, inst, price, st: 'open', t: Date.now() }; rmt.list.push(l); save('rmt.json', rmt); return json(res, 200, { ok: true, id: l.id }); }
      const l = L(b.id); if (!l) return json(res, 404, { error: 'Anúncio não encontrado.' });
      if (act === 'cancel') { if (l.acc !== a.id || l.st !== 'open') return json(res, 400, { error: 'Só dá para retirar anúncios livres.' }); l.st = 'cancel'; save('rmt.json', rmt); return json(res, 200, { inst: l.inst }); }
      if (act === 'reserve') { if (l.acc === a.id) return json(res, 400, { error: 'Esse anúncio é seu.' }); if (l.st !== 'open') return json(res, 400, { error: 'Outro jogador já está comprando este item.' });
        if (rmt.list.some((x) => x.buyer === a.id && x.st === 'reserved')) return json(res, 400, { error: 'Termine ou cancele a sua compra reservada primeiro.' });
        l.st = 'reserved'; l.buyer = a.id; l.buyerNick = a.nick || a.name; l.until = Date.now() + RMT_HOLD; save('rmt.json', rmt); return json(res, 200, { l: rmtPub(l, a) }); }
      if (act === 'unreserve') { if (l.buyer !== a.id || l.st !== 'reserved') return json(res, 400, { error: 'Nada para cancelar.' }); l.st = 'open'; l.buyer = null; l.buyerNick = null; save('rmt.json', rmt); return json(res, 200, { ok: true }); }
      if (act === 'paid') { if (l.buyer !== a.id || l.st !== 'reserved') return json(res, 400, { error: 'Reserva expirada. Reserve de novo.' }); l.st = 'paid'; l.paidAt = Date.now(); save('rmt.json', rmt);
        const ws = byPid(l.acc); if (ws) send(ws, { t: 'rmt', msg: `${l.buyerNick} disse que pagou R$ ${l.price.toFixed(2).replace('.', ',')} pelo seu item. Confira o Pix e confirme no Mercado Pix.` }); return json(res, 200, { ok: true }); }
      if (act === 'confirm') { if (l.acc !== a.id || l.st !== 'paid') return json(res, 400, { error: 'Nada para confirmar.' }); l.st = 'done'; l.doneAt = Date.now(); (rmt.deliver[l.buyer] || (rmt.deliver[l.buyer] = [])).push(l.inst); save('rmt.json', rmt);
        const ws = byPid(l.buyer); if (ws) send(ws, { t: 'rmt', msg: 'O vendedor confirmou o seu Pix! O item foi entregue.', claim: 1 }); return json(res, 200, { ok: true }); }
      if (act === 'deny') { if (l.acc !== a.id || l.st !== 'paid') return json(res, 400, { error: 'Nada para recusar.' }); l.st = 'dispute'; save('rmt.json', rmt); return json(res, 200, { ok: true, msg: 'Enviado para análise do administrador.' }); }
      return json(res, 404, { error: 'Ação desconhecida.' });
    }
    if (p === '/api/rmtclaim') { const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' }); const d = rmt.deliver[a.id] || []; delete rmt.deliver[a.id]; save('rmt.json', rmt); return json(res, 200, { items: d }); }
    if (p === '/admin') {
      if (!CFG.adminKey || url.searchParams.get('key') !== CFG.adminKey) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Acesso negado. Configure ADMIN_KEY no Render e abra /admin?key=SUA_CHAVE'); }
      const ap = url.searchParams.get('approve'); if (ap && passes.orders[ap]) grantPass(ap);
      const rj = url.searchParams.get('reject'); if (rj && passes.orders[rj] && passes.orders[rj].status !== 'approved') { passes.orders[rj].status = 'rejected'; save('passes.json', passes); }
      const rc = url.searchParams.get('rmtok'), rx = url.searchParams.get('rmtno');
      if (rc) { const l = rmt.list.find((x) => x.id === +rc); if (l && (l.st === 'paid' || l.st === 'dispute')) { l.st = 'done'; (rmt.deliver[l.buyer] || (rmt.deliver[l.buyer] = [])).push(l.inst); save('rmt.json', rmt); } }
      if (rx) { const l = rmt.list.find((x) => x.id === +rx); if (l && (l.st === 'paid' || l.st === 'dispute')) { l.st = 'open'; l.buyer = null; l.buyerNick = null; save('rmt.json', rmt); } }
      const K = encodeURIComponent(CFG.adminKey);
      const rrows = rmt.list.filter((l) => l.st === 'paid' || l.st === 'dispute').map((l) => `<tr><td>#${l.id}</td><td>${String(l.seller).replace(/[<>&]/g, '')}</td><td>${String(l.buyerNick || '').replace(/[<>&]/g, '')}</td><td>R$ ${l.price.toFixed(2)}</td><td><b>${l.st}</b></td><td><a href="?key=${K}&rmtok=${l.id}">Entregar ao comprador</a> · <a href="?key=${K}&rmtno=${l.id}">Devolver ao anúncio</a></td></tr>`).join('');
      const rows = Object.values(passes.orders).sort((x, y) => y.created - x.created).slice(0, 200).map((o) => `<tr><td>${o.id}<br><small>${o.kind === 'shop' ? (SHOP_SKUS[o.sku] || {}).n || o.sku : 'Passe Mensal'}</small></td><td>${String(o.nick || '').replace(/[<>&]/g, '')}</td><td>R$ ${Number(o.amount).toFixed(2)}</td><td>${o.mode}</td><td><b>${o.status}</b></td><td>${new Date(o.created).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td><td>${o.status !== 'approved' ? `<a href="?key=${encodeURIComponent(CFG.adminKey)}&approve=${o.id}">Aprovar</a> · <a href="?key=${encodeURIComponent(CFG.adminKey)}&reject=${o.id}">Recusar</a>` : '✔'}</td></tr>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · Passes</title><style>body{font-family:system-ui;margin:20px;background:#f6ecd8;color:#2a1e14}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #c8a070;padding:6px;text-align:left}th{background:#e8d4b0}</style><h1>Passes Mensais e Loja</h1><p>Pedidos "review" = o jogador disse que pagou. Confira no app do banco pelo código do pedido (aparece na descrição do Pix) e aprove.</p><h2>Mercado Pix — pagamentos a conferir</h2><table><tr><th>Anúncio</th><th>Vendedor</th><th>Comprador</th><th>Valor</th><th>Status</th><th>Ação</th></tr>${rrows || '<tr><td colspan=6>Nada pendente.</td></tr>'}</table><h2>Passes</h2><table><tr><th>Pedido</th><th>Jogador</th><th>Valor</th><th>Modo</th><th>Status</th><th>Criado</th><th>Ação</th></tr>${rows}</table>`);
    }
    if (p === '/auth/config') return json(res, 200, { google: CFG.google || null, telegram: CFG.tgBot && CFG.tgToken ? CFG.tgBot : null, x: !!CFG.xId, guest: process.env.ALLOW_GUEST === '1' });
    if (p === '/auth/x') return xStart(req, res);
    if (p === '/auth/x/callback') return xCallback(req, res, url);
    if (req.method === 'POST' && p === '/auth/google') { const b = await body(req); const a = await authGoogle(b.credential); return json(res, 200, { token: newSession(a.id), account: pubAcc(a) }); }
    if (req.method === 'POST' && p === '/auth/telegram') { const b = await body(req); const a = authTelegram(b.user); return json(res, 200, { token: newSession(a.id), account: pubAcc(a) }); }
    if (req.method === 'POST' && p === '/auth/guest') {
      if (process.env.ALLOW_GUEST !== '1') return json(res, 403, { error: 'Entre com a sua conta Google.' });
      const b = await body(req); const gid = String(b.device || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      if (gid.length < 10) return json(res, 400, { error: 'Dispositivo inválido.' });
      const a = upsert('guest:' + gid, 'guest', 'Convidado'); return json(res, 200, { token: newSession(a.id), account: pubAcc(a) });
    }
    if (p === '/api/me') { const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' }); return json(res, 200, { account: pubAcc(a), save: readSave(a.id) }); }
    if (p === '/api/nick/check') {
      const a = accountOf(tokenOf(req, url)); const n = cleanNick(url.searchParams.get('nick'));
      if (n.length < 3) return json(res, 200, { ok: false, msg: 'Use pelo menos 3 letras.' });
      if (!nickOk(n)) return json(res, 200, { ok: false, msg: 'Use só letras, números, espaço, ponto, traço ou _.' });
      const taken = Object.values(accounts).some((o) => (!a || o.id !== a.id) && o.nick && o.nick.toLowerCase() === n.toLowerCase());
      return json(res, 200, taken ? { ok: false, msg: 'Esse nick já está em uso.' } : { ok: true, msg: 'Nick disponível!' });
    }
    if (p === '/api/blocks') { return json(res, 200, { c: blockCounts(), cap: BLK_CAP, n: NBLK }); }
    if (req.method === 'POST' && p === '/api/rename') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' });
      const b = await body(req); const n = cleanNick(b.nick); if (!nickOk(n)) return json(res, 400, { error: 'Nick inválido: use de 3 a 16 letras, números, espaço, ponto, traço ou _.' });
      if (a.nick && a.nick.toLowerCase() === n.toLowerCase() && a.nick === n) return json(res, 400, { error: 'Esse já é o seu nome.' });
      const taken = Object.values(accounts).some((o) => o.id !== a.id && o.nick && o.nick.toLowerCase() === n.toLowerCase());
      if (taken) return json(res, 409, { error: 'Esse nick já está em uso. Escolha outro.' });
      const old = a.nick; a.nick = n; save('accounts.json', accounts);
      for (const [, c] of clients) if (c.pid === a.id) c.nick = n;
      if (RANK[a.id]) { RANK[a.id].nick = n; save('ranking.json', RANK); }
      for (const k in CHAMPS) if (CHAMPS[k][a.id]) { CHAMPS[k][a.id].nick = n; save('champs.json', CHAMPS); }
      if (castle.champPid === a.id) { castle.champ = n; save('castle.json', castle); }
      if (old) broadcast({ t: 'chat', ch: 'sys', text: `${old} agora se chama ${n}.` });
      return json(res, 200, { account: pubAcc(a) });
    }
    if (req.method === 'POST' && p === '/api/nick') {
      const a = accountOf(tokenOf(req, url)); if (!a) return json(res, 401, { error: 'Sessão expirada.' });
      const b = await body(req); const n = cleanNick(b.nick); if (!nickOk(n)) return json(res, 400, { error: 'Nick inválido.' });
      const taken = Object.values(accounts).some((o) => o.id !== a.id && o.nick && o.nick.toLowerCase() === n.toLowerCase());
      if (taken) return json(res, 409, { error: 'Esse nick já está em uso. Escolha outro.' });
      if (a.nick && a.nick !== n) return json(res, 409, { error: 'Este personagem já tem nick.' });
      a.nick = n; if (b.cls) a.cls = clean(b.cls, 16); if (b.blk) a.blk = Math.max(1, Math.min(NBLK, num(b.blk, 1) | 0));
      save('accounts.json', accounts); return json(res, 200, { account: pubAcc(a) });
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
const GBOSS = {};
const NBLK = 36, REGION_SIZE = 12, BLK_CAP = Math.max(1, parseInt(process.env.BLOCK_CAP || '100', 10) || 100);
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, n);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg, filter) { const s = JSON.stringify(msg); for (const [ws, p] of clients) if (ws.readyState === 1 && (!filter || filter(p))) ws.send(s); }
function bySpid(spid) { for (const [ws, p] of clients) if (p.spid === spid && p.ready) return ws; return null; }
const PARTIES = new Map(); let PARTY_SEQ = 0;
function blockCounts() { const c = {}; for (let k = 1; k <= NBLK; k++) c[k] = 0; for (const [, q] of clients) if (q.ready && q.hadPos) c[q.b] = (c[q.b] || 0) + 1; return c; }
const { createMatch } = require('./arena');
const ARENA_TEAM = Math.max(1, Math.min(5, parseInt(process.env.ARENA_TEAM || '5', 10) || 5));
const QUEUE = [], MATCHES = new Map(); let MATCH_SEQ = 0;
const arenaDay = load('arena_day.json', {});
// ---------- Rankings ----------
const RANK = load('ranking.json', {});
const RK_CATS = ['arK', 'arT', 'wK', 'eK', 'pw', 'sk', 'lv'];
function rkRec(p) { if (!p || !p.pid) return null; const r = RANK[p.pid] || (RANK[p.pid] = { nick: p.nick, cls: p.cls || '' }); r.nick = p.nick; if (p.cls) r.cls = p.cls; return r; }
function rkAdd(p, k, n) { const r = rkRec(p); if (!r) return; r[k] = (r[k] || 0) + n; save('ranking.json', RANK); }
function rkSet(p, k, v) { const r = rkRec(p); if (!r) return; if (r[k] !== v) { r[k] = v; save('ranking.json', RANK); } }
function rkTop(cat, me) { const list = Object.entries(RANK).filter(([, r]) => (r[cat] || 0) > 0).map(([pid, r]) => ({ pid, nick: r.nick, cls: r.cls || '', v: r[cat] || 0 })).sort((a, b) => b.v - a.v);
  const i = me ? list.findIndex((x) => x.pid === me.pid) : -1; return { top: list.slice(0, 50).map(({ nick, cls, v }) => ({ nick, cls, v })), me: i >= 0 ? { rank: i + 1, v: list[i].v } : null, total: list.length }; }
const dayKey = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const roomOf = (p) => p.room || (p.b + ':' + p.m);
function arenaDetach(p) { p.match = null; p.team = null; p.room = null; }
function startMatch(ptA, ptB) {
  const id = ++MATCH_SEQ; const teams = [ptA, ptB].map((pt) => pt.mem.map((s) => { const w = bySpid(s); return w && clients.get(w); }).filter(Boolean));
  const today = dayKey();
  const A = createMatch(id, teams, { stat: (spid, k, n) => { const w = bySpid(spid); const p = w && clients.get(w); if (p) rkAdd(p, k, n); }, send: (spid, msg) => { const w = bySpid(spid); if (w) send(w, msg); }, ended: (M) => { setTimeout(() => finishMatch(M), 50); } });
  A.parties = [ptA, ptB]; MATCHES.set(id, A);
  const roster = []; teams.forEach((tm, i) => tm.forEach((p) => roster.push({ spid: p.spid, nick: p.nick, cls: p.cls || '', lvl: p.lvl, team: i })));
  teams.forEach((tm, i) => tm.forEach((p) => { p.match = id; p.team = i; p.room = 'A' + id; arenaDay[p.pid] = today; send(bySpid(p.spid), { t: 'ar_start', id, team: i, roster }); }));
  save('arena_day.json', arenaDay);
  for (const pt of [ptA, ptB]) { pt.st = 'match'; if (pt.ready) pt.ready.clear(); partyPush(pt, null); }
}
function finishMatch(A) { if (!MATCHES.has(A.id)) return; MATCHES.delete(A.id);
  for (const pl of A.pl.values()) { const w = bySpid(pl.spid); const p = w && clients.get(w); if (p && p.match === A.id) arenaDetach(p); }
  for (const pt of A.parties) { if (!PARTIES.has(pt.id)) continue; pt.st = 'idle'; if (pt.ready) pt.ready.clear(); partyPush(pt, null); } }
setInterval(() => {
  for (let i = QUEUE.length - 1; i >= 0; i--) { const pt = PARTIES.get(QUEUE[i]); if (!pt || pt.st !== 'queue' || pt.mem.length < ARENA_TEAM || !pt.mem.every((s) => bySpid(s))) { QUEUE.splice(i, 1); if (pt) { partyUnready(pt); partyPush(pt, 'A busca por partida foi cancelada.'); } } }
  while (QUEUE.length >= 2) { const a = PARTIES.get(QUEUE.shift()), b = PARTIES.get(QUEUE.shift()); startMatch(a, b); }
}, 1000);
setInterval(() => { for (const A of MATCHES.values()) { A.tick(0.1); if (!A.over) { const st = JSON.stringify(A.state()); for (const pl of A.pl.values()) if (!pl.gone) { const w = bySpid(pl.spid); if (w && w.readyState === 1) w.send(st); } } } }, 100);
function partyState(pt) { return { t: 'pt', id: pt.id, leader: pt.leader, need: ARENA_TEAM, st: pt.st || 'idle', ready: [...(pt.ready || [])], mem: pt.mem.map((s) => { const w = bySpid(s); const p = w && clients.get(w); return p ? { spid: s, nick: p.nick, lvl: p.lvl, cls: p.cls || '', hp: p.hp == null ? 1 : p.hp, b: p.b, m: p.m, on: 1 } : { spid: s, on: 0 }; }) }; }
function partyPush(pt, msg) { const st = partyState(pt); for (const s of pt.mem) { const w = bySpid(s); if (w) { send(w, st); if (msg) send(w, { t: 'pt_msg', msg }); } } }
function partyUnready(pt) { if (!pt) return; if (pt.ready) pt.ready.clear(); if (pt.st === 'queue') pt.st = 'idle'; const i = QUEUE.indexOf(pt.id); if (i >= 0) QUEUE.splice(i, 1); }
function partyLeave(p) {
  const pt = PARTIES.get(p.party); p.party = null; if (!pt) return; partyUnready(pt);
  pt.mem = pt.mem.filter((s) => s !== p.spid); const w = bySpid(p.spid); if (w) send(w, { t: 'pt', id: null, leader: null, mem: [] });
  if (pt.mem.length <= 1) { for (const s of pt.mem) { const w2 = bySpid(s); if (w2) { clients.get(w2).party = null; send(w2, { t: 'pt', id: null, leader: null, mem: [] }); send(w2, { t: 'pt_msg', msg: 'A equipe foi desfeita.' }); } } PARTIES.delete(pt.id); return; }
  if (pt.leader === p.spid) pt.leader = pt.mem[0];
  partyPush(pt, `${p.nick} saiu da equipe.`);
}
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
        send(ws, { t: 'champs', c: pubChamps() });
        send(ws, { t: 'castle', c: pubCastle(), crLeft: crLeft(me.pid), chestOk: castle.champPid === me.pid && castle.chestWeek[me.pid] !== week() });
        broadcast({ t: 'chat', ch: 'sys', text: `${me.nick} entrou no mundo.` }, (p) => p !== me);
        break;
      }
      case 'pos':
        { const nb = Math.max(1, Math.min(NBLK, num(d.b, 1) | 0));
          if (nb !== me.b || !me.hadPos) { let n = 0; for (const [, q] of clients) if (q !== me && q.ready && q.hadPos && q.b === nb) n++;
            if (n >= BLK_CAP) { const cnt = blockCounts(); let best = null; const rg = Math.ceil(nb / REGION_SIZE); for (let k = (rg - 1) * REGION_SIZE + 1; k <= rg * REGION_SIZE; k++) if ((cnt[k] || 0) < BLK_CAP && (best === null || (cnt[k] || 0) < (cnt[best] || 0))) best = k;
              if (!best) for (let k = 1; k <= NBLK; k++) if ((cnt[k] || 0) < BLK_CAP && (best === null || (cnt[k] || 0) < (cnt[best] || 0))) best = k;
              if (me.hadPos) { send(ws, { t: 'blk_full', b: nb, cur: me.b, cap: BLK_CAP }); break; }
              if (best) { me.b = best; me.hadPos = true; send(ws, { t: 'blk_full', b: nb, to: best, cap: BLK_CAP }); break; } }
            me.b = nb; me.hadPos = true; } }
        me.m = num(d.m, 0) | 0;
        me.x = num(d.x); me.y = num(d.y); me.dir = clean(d.dir, 1) || 'd'; me.mv = d.mv ? 1 : 0;
        me.mount = clean(d.mount, 16); me.lvl = num(d.lvl, me.lvl); me.wp = clean(d.wp, 16); me.sw = d.sw ? 1 : 0; me.dn = d.dn ? 1 : 0; me.sk = clean(d.sk, 24); me.cls = clean(d.cls, 16); me.hp = Math.max(0, Math.min(1, num(d.hp, 1))); me.pd = Math.max(1, Math.min(1e6, num(d.pd, 8)));
        if (d.pw != null && (!me.rkT || Date.now() - me.rkT > 10000)) { me.rkT = Date.now(); rkSet(me, 'pw', Math.max(0, Math.min(1e9, Math.floor(num(d.pw))))); rkSet(me, 'sk', Math.max(0, Math.min(1000, Math.floor(num(d.sc))))); rkSet(me, 'lv', Math.max(1, Math.min(9999, Math.floor(me.lvl || 1)))); }
        if (d.ti !== undefined) me.ti = clean(d.ti, 40);
        if (d.guild !== undefined) me.guild = d.guild ? { name: clean(d.guild.name, 20), tag: clean(d.guild.tag, 4) } : null;
        break;
      case 'chat': {
        const now = Date.now(); if (now - me.lastChat < 700) return; me.lastChat = now;
        const text = clean(d.text, 140).trim(); if (!text) return;
        const ch = d.ch === 'local' ? 'local' : 'global';
        broadcast({ t: 'chat', ch, from: me.nick, gtag: me.guild ? me.guild.tag : '', b: me.b, text }, ch === 'local' ? (p) => p.b === me.b && p.m === me.m : (p) => Math.ceil(p.b / REGION_SIZE) === Math.ceil(me.b / REGION_SIZE));
        break;
      }
      // ---------- Equipe (grupo de até 5) ----------
      case 'pt_who': {
        const list = [];
        for (const [, p2] of clients) if (p2.ready && p2 !== me) list.push({ spid: p2.spid, nick: p2.nick, lvl: p2.lvl, cls: p2.cls || '', b: p2.b, m: p2.m, x: Math.round(p2.x), y: Math.round(p2.y), gtag: p2.guild ? p2.guild.tag : '', inParty: !!p2.party });
        send(ws, { t: 'pt_who', list: list.slice(0, 200) });
        break;
      }
      case 'pt_inv': {
        const ws2 = bySpid(d.to); if (!ws2) { send(ws, { t: 'pt_msg', msg: 'Esse jogador não está online.' }); break; }
        const p2 = clients.get(ws2); if (p2.party) { send(ws, { t: 'pt_msg', msg: `${p2.nick} já está em uma equipe.` }); break; }
        const pt = me.party && PARTIES.get(me.party); if (pt && pt.mem.length >= 5) { send(ws, { t: 'pt_msg', msg: 'Sua equipe já tem 5 jogadores.' }); break; }
        if (pt && pt.st && pt.st !== 'idle') { send(ws, { t: 'pt_msg', msg: 'Sua equipe já está buscando partida.' }); break; }
        (p2.invites || (p2.invites = {}))[me.spid] = Date.now();
        send(ws2, { t: 'pt_invite', from: me.nick, fspid: me.spid, lvl: me.lvl, cls: me.cls || '' });
        send(ws, { t: 'pt_msg', msg: `Convite enviado para ${p2.nick}.` });
        break;
      }
      case 'pt_acc': {
        const t0 = me.invites && me.invites[d.from]; if (!t0 || Date.now() - t0 > 120000) { send(ws, { t: 'pt_msg', msg: 'O convite expirou.' }); break; }
        delete me.invites[d.from]; if (me.party) partyLeave(me);
        const ws2 = bySpid(d.from); if (!ws2) { send(ws, { t: 'pt_msg', msg: 'Quem convidou saiu do jogo.' }); break; }
        const p2 = clients.get(ws2); let pt = p2.party && PARTIES.get(p2.party);
        if (!pt) { pt = { id: 'P' + (++PARTY_SEQ), leader: p2.spid, mem: [p2.spid] }; PARTIES.set(pt.id, pt); p2.party = pt.id; }
        if (pt.mem.length >= 5) { send(ws, { t: 'pt_msg', msg: 'A equipe já está cheia.' }); break; }
        if (pt.st && pt.st !== 'idle') { send(ws, { t: 'pt_msg', msg: 'Essa equipe já está buscando partida ou jogando.' }); break; }
        pt.mem.push(me.spid); me.party = pt.id; partyPush(pt, `${me.nick} entrou na equipe.`);
        break;
      }
      case 'pt_dec': { if (me.invites) delete me.invites[d.from]; const ws2 = bySpid(d.from); if (ws2) send(ws2, { t: 'pt_msg', msg: `${me.nick} recusou o convite.` }); break; }
      case 'pt_leave': { const pt = me.party && PARTIES.get(me.party); if (pt && (pt.st === 'match' || me.match)) { send(ws, { t: 'pt_msg', msg: 'Só é possível sair da equipe antes da partida começar, ainda no mapa normal.' }); break; } if (me.party) partyLeave(me); break; }
      case 'pt_kick': {
        const pt = me.party && PARTIES.get(me.party); if (!pt || pt.leader !== me.spid) break;
        if (pt.st === 'match') { send(ws, { t: 'pt_msg', msg: 'Não dá para remover alguém durante a partida.' }); break; }
        const ws2 = bySpid(d.to); if (ws2 && clients.get(ws2).party === pt.id) { send(ws2, { t: 'pt_msg', msg: 'Você foi removido da equipe.' }); partyLeave(clients.get(ws2)); }
        break;
      }
      case 'rk_me': { send(ws, { t: 'rk_me', r: RANK[me.pid] || {} }); break; }
      case 'pm': {
        const now = Date.now(); if (now - (me.lastChat || 0) < 700) return; me.lastChat = now;
        const text = clean(d.text, 140).trim(); if (!text) return; const w2 = bySpid(d.to); if (!w2) { send(ws, { t: 'chat', ch: 'sys', text: 'Esse jogador não está online.' }); break; }
        const p2 = clients.get(w2); const msg = { t: 'chat', ch: 'pm', from: me.nick, fspid: me.spid, to: p2.nick, tspid: p2.spid, gtag: me.guild ? me.guild.tag : '', text };
        send(w2, msg); send(ws, msg); break;
      }
      case 'insp': {
        const w2 = bySpid(d.to); if (!w2) { send(ws, { t: 'insp_err', msg: 'Esse jogador não está online.' }); break; }
        send(w2, { t: 'insp_req', from: me.spid }); break;
      }
      case 'insp_res': {
        const w2 = bySpid(d.to); if (!w2 || !d.p || typeof d.p !== 'object') break;
        const pr = d.p; if (typeof pr.av === 'string' && pr.av.length > 30000) pr.av = '';
        const ranks = {}; for (const c of RK_CATS) { const t = rkTop(c, me); ranks[c] = t.me ? t.me.rank : null; }
        send(w2, { t: 'insp', spid: me.spid, p: pr, ranks }); break;
      }
      case 'rk': { const cat = RK_CATS.includes(d.cat) ? d.cat : 'pw'; send(ws, Object.assign({ t: 'rk', cat }, rkTop(cat, me))); break; }
      case 'pt_ready': {
        const pt = me.party && PARTIES.get(me.party); if (!pt) { send(ws, { t: 'pt_msg', msg: 'Monte uma equipe de 5 jogadores primeiro.' }); break; }
        if (pt.st === 'match' || me.match) break;
        pt.ready = pt.ready || new Set();
        if (!d.on) { const was = pt.st === 'queue'; pt.ready.delete(me.spid); if (was) { pt.st = 'idle'; const i = QUEUE.indexOf(pt.id); if (i >= 0) QUEUE.splice(i, 1); } partyPush(pt, was ? `${me.nick} cancelou: a busca por partida parou.` : null); break; }
        if (pt.mem.length < ARENA_TEAM) { send(ws, { t: 'pt_msg', msg: `A equipe precisa de ${ARENA_TEAM} jogadores para iniciar.` }); break; }
        if (!pt.mem.every((s2) => bySpid(s2))) { send(ws, { t: 'pt_msg', msg: 'Todos da equipe precisam estar online.' }); break; }
        if (me.m === 14 || me.m === 4 || me.m === 5 || me.m >= 11) { send(ws, { t: 'pt_msg', msg: 'Volte para uma ilha (mapa normal) antes de iniciar.' }); break; }
        if (arenaDay[me.pid] === dayKey()) { send(ws, { t: 'pt_msg', msg: 'Você já entrou na arena hoje. Volte amanhã!' }); break; }
        if (!d.tk) { send(ws, { t: 'pt_msg', msg: 'Você precisa de um Ticket da Arena (1.000 ouro).' }); break; }
        pt.ready.add(me.spid);
        if (pt.mem.every((s2) => pt.ready.has(s2))) { pt.st = 'queue'; if (!QUEUE.includes(pt.id)) QUEUE.push(pt.id); partyPush(pt, 'Todos prontos! Buscando equipe adversária…'); }
        else partyPush(pt, `${me.nick} está pronto (${pt.ready.size}/${pt.mem.length}).`);
        break;
      }
      case 'ar_hit': { const A = me.match && MATCHES.get(me.match); if (A) { if (Array.isArray(d.l)) for (const h of d.l.slice(0, 30)) A.hit(me.spid, num(h[0]) | 0, num(h[1])); else A.hit(me.spid, num(d.id) | 0, num(d.d)); } break; }
      case 'ar_dead': { const A = me.match && MATCHES.get(me.match); if (A) A.dead(me.spid, clean(d.by, 24)); break; }
      case 'ar_met': { const A = me.match && MATCHES.get(me.match); if (A) A.meteor(me.spid, num(d.x), num(d.y)); break; }
      case 'ar_quit': { const A = me.match && MATCHES.get(me.match); if (A) { A.leave(me.spid); } arenaDetach(me); break; }
      case 'revive': case 'pull': {
        for (const [ws2, p2] of clients) if (p2.spid === d.to && roomOf(p2) === roomOf(me) && (!me.match || (d.t === 'revive' ? p2.team === me.team : p2.team !== me.team))) send(ws2, d.t === 'revive' ? { t: 'revived', from: me.nick } : { t: 'pulled', from: me.nick, x: num(d.x), y: num(d.y) });
        break;
      }
      case 'pvp': case 'pvp_ko': {
        const dmg = Math.max(1, Math.min(99999, Math.floor(num(d.dmg, 1))));
        for (const [ws2, p2] of clients) if (p2.spid === d.to && roomOf(p2) === roomOf(me) && (!me.match || p2.team !== me.team)) {
          send(ws2, d.t === 'pvp' ? { t: 'pvp_hit', from: me.nick, fspid: me.spid, dmg } : { t: 'pvp_ko', from: me.nick });
          if (d.t === 'pvp_ko' && !me.match && !p2.match) { const now = Date.now(); if (!me.koT || now - me.koT > 3000) { me.koT = now; const acc = accounts[p2.pid]; const home = acc && acc.blk ? acc.blk : 1; rkAdd(p2, p2.b !== home ? 'eK' : 'wK', 1); } }
        }
        break;
      }
      case 'sg_join': {
        if (!me.guild) return send(ws, { t: 'sg_no', msg: 'Só membros de guilda podem entrar no Cerco ao Castelo.' });
        if (sgCount(me.b) >= SG_CAP && me.m !== 11) return send(ws, { t: 'sg_no', msg: `A arena do cerco está cheia (${SG_CAP} jogadores). Tente mais tarde.` });
        const s = sgOf(me.b); send(ws, { t: 'sg_ok', s: { t: s.t, sh: s.sh, cr: s.cr, resetAt: s.resetAt, winner: s.winner, n: sgCount(me.b) } });
        break;
      }
      case 'sg_hit': {
        if (me.m !== 11 || !me.guild) return; const s = sgOf(me.b); if (s.resetAt) return;
        const dmg = Math.max(1, Math.min(20000, Math.floor(num(d.dmg, 1)))); const tg = d.tg;
        if (tg === 't0' || tg === 't1' || tg === 't2') { const i = +tg[1]; if (s.t[i] > 0) s.t[i] = Math.max(0, s.t[i] - dmg); }
        else if (tg === 'cr') {
          if (s.t.some((h) => h > 0)) return;
          if (s.sh > 0) s.sh--; else s.cr = Math.max(0, s.cr - dmg);
          if (s.cr <= 0) {
            s.winner = { nick: me.nick, guild: me.guild }; s.resetAt = Date.now() + SG_RESET;
            castle.guild = me.guild; castle.champ = me.nick; castle.champPid = me.pid; castle.since = Date.now(); castle.buffs = []; castle.titles = [];
            save('castle.json', castle); broadcast({ t: 'castle', c: pubCastle() });
            { const isl = Math.max(0, Math.min(10, num(d.isl, 0) | 0)); const L = CHAMPS[isl] || (CHAMPS[isl] = {}); const r0 = L[me.pid] || (L[me.pid] = { n: 0 }); Object.assign(r0, { nick: me.nick, cls: me.cls || '', gtag: me.guild ? me.guild.tag : '', n: r0.n + 1, last: Date.now() }); save('champs.json', CHAMPS); broadcast({ t: 'champs', c: pubChamps() }); }
            broadcast({ t: 'chat', ch: 'sys', text: `${me.nick} quebrou o Cristal do Cerco! A guilda ${me.guild.name} [${me.guild.tag}] conquistou o castelo.` });
            send(ws, { t: 'castle', c: pubCastle(), chestOk: castle.chestWeek[me.pid] !== week() });
          }
        }
        s.dirty = true;
        break;
      }
      case 'rev': case 'pull': {
        for (const [ws2, p2] of clients) if (p2.spid === d.to && p2.b === me.b && p2.m === me.m) send(ws2, d.t === 'rev' ? { t: 'rev', from: me.nick } : { t: 'pull', from: me.nick, x: num(d.x), y: num(d.y) });
        break;
      }
      case 'gb_on': case 'gb_list': case 'gb_done': {
        const g = d.guild ? { name: clean(d.guild.name, 20), tag: clean(d.guild.tag, 4) } : me.guild; if (!g || !g.name) return; me.guild = g; const key = g.name.toLowerCase();
        const L = GBOSS[key] || (GBOSS[key] = {}); const now = Date.now(); for (const k in L) if (L[k].until < now) delete L[k];
        const bi = Math.max(0, Math.min(4, num(d.boss, 0) | 0)); let news = null;
        if (d.t === 'gb_on') { L[bi] = { until: now + 30 * 60 * 1000, by: me.nick }; news = { boss: bi, by: me.nick } }
        if (d.t === 'gb_done') delete L[bi];
        const list = Object.entries(L).map(([k, v]) => ({ boss: +k, until: v.until, by: v.by }));
        if (d.t === 'gb_list') send(ws, { t: 'gb', list }); else broadcast({ t: 'gb', list, news }, (q) => q.guild && q.guild.name && q.guild.name.toLowerCase() === key);
        break;
      }
      case 'cs_claim': {
        return send(ws, { t: 'cs_err', msg: 'O castelo só pode ser conquistado no Cerco.' });
        castle.guild = me.guild; castle.champ = me.nick; castle.champPid = me.pid; castle.since = Date.now(); castle.buffs = []; castle.titles = [];
        save('castle.json', castle); broadcast({ t: 'castle', c: pubCastle() });
        broadcast({ t: 'chat', ch: 'sys', text: `${me.nick} [${me.guild.tag}] conquistou o Trono do Castelo! A guilda ${me.guild.name} agora domina o castelo.` });
        send(ws, { t: 'castle', c: pubCastle(), chestOk: castle.chestWeek[me.pid] !== week() });
        break;
      }
      case 'cs_buffs': {
        if (castle.champPid !== me.pid) return send(ws, { t: 'cs_err', msg: 'Só o campeão do castelo escolhe os buffs.' });
        castle.buffs = [...new Set((d.ids || []).map((x) => num(x, -1) | 0).filter((x) => x >= 0 && x < 50))].slice(0, 5);
        save('castle.json', castle); broadcast({ t: 'castle', c: pubCastle() });
        break;
      }
      case 'cs_title': {
        if (castle.champPid !== me.pid) return send(ws, { t: 'cs_err', msg: 'Só o campeão do castelo distribui títulos.' });
        const tid = num(d.title, -1) | 0; if (tid < 0 || tid >= 50) return;
        const nick = clean(d.nick, 16).toLowerCase(); let target = null;
        for (const [, p] of clients) if (p.ready && p.nick.toLowerCase() === nick) target = p;
        if (!target) return send(ws, { t: 'cs_err', msg: 'Jogador não encontrado online.' });
        castle.titles = castle.titles.filter((t) => t.pid !== target.pid && t.title !== tid);
        if (castle.titles.length >= 5) return send(ws, { t: 'cs_err', msg: 'Os 5 títulos já foram distribuídos. Retire um antes.' });
        castle.titles.push({ pid: target.pid, spid: target.spid, nick: target.nick, title: tid });
        save('castle.json', castle); broadcast({ t: 'castle', c: pubCastle() });
        break;
      }
      case 'cs_untitle': {
        if (castle.champPid !== me.pid) return;
        castle.titles = castle.titles.filter((t) => t.title !== (num(d.title, -1) | 0)); save('castle.json', castle); broadcast({ t: 'castle', c: pubCastle() });
        break;
      }
      case 'cs_wd': {
        const cur = ['gold', 'ruby', 'cristal'].includes(d.cur) ? d.cur : null; const amt = Math.floor(num(d.amt));
        if (!cur || amt < 1) return;
        if (!castle.guild || !me.guild || me.guild.name !== castle.guild.name || !d.leader) return send(ws, { t: 'cs_err', msg: 'Só a liderança da guilda dominante pode sacar do armazém.' });
        if ((castle.tre[cur] || 0) < amt) return send(ws, { t: 'cs_err', msg: 'O armazém não tem esse valor.' });
        castle.tre[cur] -= amt; save('castle.json', castle); send(ws, { t: 'cs_wd_ok', cur, amt }); broadcast({ t: 'castle', c: pubCastle() });
        break;
      }
      case 'cs_chest': {
        if (castle.champPid !== me.pid) return send(ws, { t: 'cs_err', msg: 'Só o campeão do castelo pode abrir o baú real.' });
        if (castle.chestWeek[me.pid] === week()) return send(ws, { t: 'cs_err', msg: 'O baú real desta semana já foi coletado.' });
        castle.chestWeek[me.pid] = week(); save('castle.json', castle); send(ws, { t: 'cs_chest_ok' });
        break;
      }
      case 'cr_buy': {
        const n = Math.max(1, Math.min(50, Math.floor(num(d.n, 1)))); const left = crLeft(me.pid);
        if (n > left) return send(ws, { t: 'cs_err', msg: `Limite semanal: você ainda pode comprar ${left} cristal(is) esta semana.` });
        const r = castle.crbuy[me.pid] && castle.crbuy[me.pid].w === week() ? castle.crbuy[me.pid] : (castle.crbuy[me.pid] = { w: week(), n: 0 });
        r.n += n; castle.tre.gold += Math.floor(n * CR_PRICE * 0.1); save('castle.json', castle);
        send(ws, { t: 'cr_ok', n, left: crLeft(me.pid) }); broadcast({ t: 'castle', c: pubCastle() });
        break;
      }
      case 'cr_xchg': {
        const n = Math.max(1, Math.min(100, Math.floor(num(d.n, 1))));
        castle.tre.cristal += 2 * n; save('castle.json', castle); send(ws, { t: 'xchg_ok', n }); broadcast({ t: 'castle', c: pubCastle() });
        break;
      }
      case 'mk_list': {
        const it = d.item || {}; const price = Math.floor(num(d.price));
        if (!me.ready || price < 1 || price > 1e9) return send(ws, { t: 'mk_err', ref: d.ref, msg: 'Preço inválido.' });
        const l = { uid: market.next++, pid: me.pid, seller: me.nick, blk: me.b, price, cur: d.cur === 'ruby' ? 'ruby' : 'gold', kind: it.kind === 'eq' ? 'eq' : 'item', t: Date.now() };
        if (l.kind === 'eq') l.inst = it.inst; else { l.id = clean(it.id, 30); l.q = Math.max(1, num(it.q, 1) | 0); }
        if ((l.id === 'sacoOuro' || l.id === 'pacoDark') && (l.cur !== 'ruby' || l.price < 2 * l.q)) return send(ws, { t: 'mk_err', ref: d.ref, msg: 'Sacolinha de Ouro e Pacote de Darkstill: venda só em rubis, mínimo 2 rubis cada.' });
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
        const net = (l.id === 'sacoOuro' || l.id === 'pacoDark') ? Math.floor(l.price / 2) : Math.max(0, Math.floor(l.price * (1 - FEE)));
        castle.tre[l.cur] = (castle.tre[l.cur] || 0) + (l.price - net); save('castle.json', castle); broadcast({ t: 'castle', c: pubCastle() });
        const sws = byPid(l.pid);
        if (sws) send(sws, { t: 'sold', l, net, buyer: me.nick });
        else { const pr = proceeds[l.pid] || (proceeds[l.pid] = { gold: 0, ruby: 0, sales: [] }); pr[l.cur] += net; pr.sales.push({ uid: l.uid, name: l.id || (l.inst && l.inst.id), q: l.q || 1, net, cur: l.cur, buyer: me.nick }); save('proceeds.json', proceeds); }
        broadcast({ t: 'market', list: publicMarket() });
        break;
      }
    }
  });
  ws.on('close', () => { me.gone = true; if (me.match) { const A = MATCHES.get(me.match); if (A) A.leave(me.spid); } if (me.party) { const pt0 = PARTIES.get(me.party); if (pt0 && pt0.st !== 'match') partyUnready(pt0); }
  if (me.party) { const pid0 = me.party; clients.delete(ws); const pt = PARTIES.get(pid0); if (pt) { me.party = pid0; const keep = me.spid; pt.mem = pt.mem.filter((x) => x !== keep); me.party = null; if (pt.mem.length <= 1) { for (const s2 of pt.mem) { const w2 = bySpid(s2); if (w2) { clients.get(w2).party = null; send(w2, { t: 'pt', id: null, leader: null, mem: [] }); send(w2, { t: 'pt_msg', msg: 'A equipe foi desfeita.' }); } } PARTIES.delete(pt.id); } else { if (pt.leader === keep) pt.leader = pt.mem[0]; partyPush(pt, `${me.nick} saiu do jogo.`); } } }
  clients.delete(ws); if (me.ready) broadcast({ t: 'chat', ch: 'sys', text: `${me.nick} saiu do mundo.` }); });
});

setInterval(() => {
  const rooms = new Map();
  for (const [, p] of clients) { if (!p.ready) continue; const k = roomOf(p); (rooms.get(k) || rooms.set(k, []).get(k)).push(p); }
  for (const [ws, p] of clients) {
    if (!p.ready || ws.readyState !== 1) continue;
    const list = (rooms.get(roomOf(p)) || []).filter((o) => o !== p)
      .map((o) => [o.spid, o.nick, Math.round(o.x), Math.round(o.y), o.dir, o.mv, o.lvl, o.guild ? o.guild.tag : '', o.guild ? o.guild.name : '', o.mount, o.wp || '', o.sw || 0, o.dn || 0, o.sk || '', o.match ? o.team : -1, o.match ? Math.round((o.hp == null ? 1 : o.hp) * 100) : -1, o.cls || '', o.ti || '']);
    ws.send(JSON.stringify({ t: 'ps', p: list }));
  }
}, 100);
setInterval(() => { for (const pt of PARTIES.values()) partyPush(pt); }, 2000);
setInterval(() => {
  const c = {}; for (let k = 1; k <= NBLK; k++) c[k] = 0; let total = 0;
  for (const [, p] of clients) if (p.ready) { c[p.b] = (c[p.b] || 0) + 1; total++; }
  broadcast({ t: 'blocks', c, total, cap: BLK_CAP });
}, 2000);

server.listen(PORT, () => {
  console.log(`Ilhas do Portal rodando em http://localhost:${PORT}`);
  console.log(`Logins ativos: Google ${CFG.google ? 'sim' : 'não'} · X ${CFG.xId ? 'sim' : 'não'} · Telegram ${CFG.tgToken ? 'sim' : 'não'} · Convidado sim`);
});
