// Ilhas do Portal — servidor multiplayer (Node.js + WebSocket)
// Serve o jogo (public/index.html) e sincroniza jogadores, chat e Mercado Global.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });

// ---------- persistência simples em JSON ----------
function load(name, def) { try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return def; } }
const saveT = {};
function save(name, obj) { clearTimeout(saveT[name]); saveT[name] = setTimeout(() => fs.writeFile(path.join(DATA, name), JSON.stringify(obj), () => {}), 300); }
const market = load('market.json', { next: 1, list: [] });   // anúncios do Mercado Global
const proceeds = load('proceeds.json', {});                 // pagamentos de vendas guardados para quem estava offline
const FEE = 0.05;

// ---------- HTTP: entrega o jogo ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' ) p = '/index.html';
  if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('não encontrado'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const clients = new Map(); // ws -> jogador
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').slice(0, n);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg, filter) { const s = JSON.stringify(msg); for (const [ws, p] of clients) if (ws.readyState === 1 && (!filter || filter(p))) ws.send(s); }
function byPid(pid) { for (const [ws, p] of clients) if (p.pid === pid) return ws; return null; }
function publicMarket() { return market.list; }

wss.on('connection', (ws) => {
  const me = { pid: null, nick: '?', guild: null, lvl: 1, b: 1, m: 0, x: 0, y: 0, dir: 'd', mv: 0, mount: '', lastChat: 0, ready: false };
  clients.set(ws, me);
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    switch (d.t) {
      case 'hello': {
        me.pid = clean(d.pid, 40) || ('p' + Math.random().toString(36).slice(2));
        me.nick = clean(d.nick, 16) || 'Aventureiro';
        me.guild = d.guild ? { name: clean(d.guild.name, 20), tag: clean(d.guild.tag, 4) } : null;
        me.lvl = num(d.lvl, 1); me.ready = true;
        const pr = proceeds[me.pid]; if (pr) { delete proceeds[me.pid]; save('proceeds.json', proceeds); }
        send(ws, { t: 'welcome', pid: me.pid, market: publicMarket(), proceeds: pr || null });
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
        const msg = { t: 'chat', ch, from: me.nick, gtag: me.guild ? me.guild.tag : '', b: me.b, text };
        broadcast(msg, ch === 'local' ? (p) => p.b === me.b && p.m === me.m : null);
        break;
      }
      case 'mk_list': {
        const it = d.item || {}; const price = Math.floor(num(d.price));
        if (!me.ready || price < 1 || price > 1e9) return send(ws, { t: 'mk_err', ref: d.ref, msg: 'Preço inválido.', item: it });
        const l = { uid: market.next++, pid: me.pid, seller: me.nick, blk: me.b, price, cur: d.cur === 'ruby' ? 'ruby' : 'gold', kind: it.kind === 'eq' ? 'eq' : 'item', t: Date.now() };
        if (l.kind === 'eq') l.inst = it.inst; else { l.id = clean(it.id, 30); l.q = Math.max(1, num(it.q, 1) | 0); }
        market.list.push(l); save('market.json', market);
        send(ws, { t: 'mk_listed', ref: d.ref, l });
        broadcast({ t: 'market', list: publicMarket() });
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

// snapshots de posição por sala (bloco + ilha), 10x por segundo
setInterval(() => {
  const rooms = new Map();
  for (const [, p] of clients) { if (!p.ready) continue; const k = p.b + ':' + p.m; (rooms.get(k) || rooms.set(k, []).get(k)).push(p); }
  for (const [ws, p] of clients) {
    if (!p.ready || ws.readyState !== 1) continue;
    const list = (rooms.get(p.b + ':' + p.m) || []).filter((o) => o !== p)
      .map((o) => [o.pid, o.nick, Math.round(o.x), Math.round(o.y), o.dir, o.mv, o.lvl, o.guild ? o.guild.tag : '', o.guild ? o.guild.name : '', o.mount]);
    ws.send(JSON.stringify({ t: 'ps', p: list }));
  }
}, 100);
// quantos jogadores há em cada bloco
setInterval(() => {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0 }; let total = 0;
  for (const [, p] of clients) if (p.ready) { c[p.b] = (c[p.b] || 0) + 1; total++; }
  broadcast({ t: 'blocks', c, total });
}, 2000);

server.listen(PORT, () => console.log(`Ilhas do Portal rodando em http://localhost:${PORT}`));
