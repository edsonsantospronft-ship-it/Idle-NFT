// Arena PvP 5v5 — simulação no servidor (lacaios, torres, nexus, chefes neutros e spots).
// Os jogadores controlam os próprios heróis; o servidor decide dano das unidades, abates e recompensas.
'use strict';
const T = 16, AOX = 48, AOY = 43;
const aw = (x, y) => ({ x: (AOX + x) * T, y: (AOY + y) * T });
const LANES = { top: [[4.5, 52], [3.5, 44], [3.5, 6], [6, 3.5], [48, 3.5], [56, 6.5]], mid: [[9.5, 54.5], [54.5, 9.5]], bot: [[12, 59.5], [20, 60.5], [58, 60.5], [60.5, 58], [60.5, 16], [57.5, 8]] };
const LREV = {}; for (const k in LANES) LREV[k] = LANES[k].slice().reverse();
const AR_TOW = [{ l: 'top', o: 0, x: 3.5, y: 30 }, { l: 'top', o: 1, x: 3.5, y: 46.5 }, { l: 'mid', o: 0, x: 18, y: 44 }, { l: 'mid', o: 1, x: 12.5, y: 50.5 }, { l: 'bot', o: 0, x: 31, y: 60.5 }, { l: 'bot', o: 1, x: 17, y: 60.5 }];
const AR_NEX = [{ x: 7, y: 57 }, { x: 57, y: 7 }], AR_FON = [{ x: 2.8, y: 61.2 }, { x: 61.2, y: 2.8 }];
const AR_PIT = { war: { x: 19.6, y: 19.7 }, ani: { x: 44.3, y: 45.2 } };
const SPOTK = ['ouro', 'xp', 'hab', 'cura', 'forca', 'vel'];
const AR_SPOTS = [
  { k: 'ouro', x: 24.3, y: 11.4 }, { k: 'ouro', x: 31.2, y: 17.6 }, { k: 'ouro', x: 10.5, y: 27.7 }, { k: 'ouro', x: 53.5, y: 36.3 }, { k: 'ouro', x: 32.8, y: 46.4 }, { k: 'ouro', x: 39.7, y: 52.3 },
  { k: 'xp', x: 34, y: 12.4 }, { k: 'xp', x: 29.7, y: 51.4 },
  { k: 'hab', x: 28.4, y: 10.8 }, { k: 'hab', x: 13.5, y: 30.2 }, { k: 'hab', x: 50.5, y: 33.8 }, { k: 'hab', x: 35.3, y: 53.2 },
  { k: 'cura', x: 11.7, y: 17 }, { k: 'cura', x: 51.9, y: 47.3 },
  { k: 'forca', x: 16.2, y: 35.3 }, { k: 'forca', x: 47.8, y: 28.7 },
  { k: 'vel', x: 25, y: 25.3 }];
const SPOTN = { ouro: 'Espírito do Ouro', xp: 'Guardião da Sabedoria', hab: 'Sentinela Arcana', cura: 'Fada da Cura', forca: 'Besta da Força', vel: 'Lebre do Vento' };
const ARBUFFS = [{ k: 'atk', n: 'Fúria', d: '+20% de dano' }, { k: 'def', n: 'Pele de Pedra', d: '-20% de dano recebido' }, { k: 'spd', n: 'Vento', d: '+25% de velocidade' }, { k: 'crit', n: 'Olho de Águia', d: '+10% de crítico' }, { k: 'regen', n: 'Regeneração', d: 'recupera 2% de vida por segundo' }, { k: 'steal', n: 'Vampirismo', d: '12% do dano vira vida' }];
const KC = { minion: 0, caster: 1, tower: 2, nexus: 3, boss: 4, spot: 5 };
// fração da vida máxima do alvo tirada por golpe
const FR = {
  minion: { minion: .2, caster: .22, tower: .008, nexus: .006, boss: .012, spot: .08 },
  caster: { minion: .22, caster: .26, tower: .008, nexus: .006, boss: .012, spot: .08 },
  tower: { minion: .34, caster: .4 }, boss: { minion: .3, caster: .3 }, spot: { minion: .1, caster: .1 },
  meteor: { minion: .6, caster: .6, tower: .06, nexus: .04, boss: .08, spot: .3 } };
// fração da vida máxima do JOGADOR tirada por golpe
const FRP = { minion: .025, caster: .03, tower: .12, boss: .08, spot: .03, meteor: .22 };
const WAVE_EVERY = 25, BOSS_FIRST = 20, BOSS_RESPAWN = 180, SPOT_RESPAWN = 70, MATCH_MAX = 1200;

function createMatch(id, teams, hooks) {
  // teams: [[p,...],[p,...]] — p são os registros de cliente do servidor (com .spid .nick .x .y .pd)
  const pds = teams.flat().map((p) => Math.max(4, Math.min(1e6, +p.pd || 8))).sort((a, b) => a - b);
  const pd = pds[Math.floor(pds.length / 2)] || 8;
  const A = { id, t: 0, pd, U: [], uid: 1, wave: 0, waveT: 5, kills: [0, 0], towers: [6, 6], TL: [1, 1], TX: [0, 0], skill: [0, 0], skillCD: [0, 0],
    buffs: [{}, {}], minBuff: [0, 0], tbuff: [{}, {}], boss: { war: { at: BOSS_FIRST }, ani: { at: BOSS_FIRST } }, spotQ: [], fx: [], proj: [], tele: [], over: null,
    pl: new Map(), teams };
  for (const tm of [0, 1]) for (const p of teams[tm]) A.pl.set(p.spid, { p, spid: p.spid, nick: p.nick, team: tm, dead: 2.5, gone: false, hits: 0, hitT: 0 });
  const add = (u) => { u.id = A.uid++; u.acd = u.acd || Math.random(); u.rt = 0; A.U.push(u); return u; };
  const alive = (u) => u && (u.isPlayer ? !u.pl.gone && !u.pl.p.gone && u.pl.dead <= A.t && u.pl.p.m === 14 : !u.dead && u.hp > 0);
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const inFon = (x, y, tm) => { const f = aw(AR_FON[tm].x, AR_FON[tm].y); return Math.hypot(x - f.x, y - f.y) < 46; };
  const playerUnit = (pl) => ({ isPlayer: true, pl, team: pl.team, get x() { return pl.p.x; }, get y() { return pl.p.y; }, kind: 'player' });
  const PU = new Map(); for (const pl of A.pl.values()) PU.set(pl.spid, playerUnit(pl));
  const toTeam = (tm, msg) => { for (const pl of A.pl.values()) if (pl.team === tm && !pl.gone) hooks.send(pl.spid, msg); };
  const toAll = (msg) => { for (const pl of A.pl.values()) if (!pl.gone) hooks.send(pl.spid, msg); };
  const ev = (spid, o) => hooks.send(spid, Object.assign({ t: 'ar_ev' }, o));
  const teamEv = (tm, o) => { for (const pl of A.pl.values()) if (pl.team === tm && !pl.gone) ev(pl.spid, o); };
  const allNote = (msg) => toAll({ t: 'ar_ev', msg });
  function mult(tm) {
    const b = A.buffs[tm], t = A.tbuff[tm], on = (k) => (b[k] || 0) > A.t;
    return { atk: (1 + .07 * (A.TL[tm] - 1)) * (on('atk') ? 1.2 : 1) * ((t.forca || 0) > A.t ? 1.2 : 1), def: on('def') ? .8 : 1, spd: (on('spd') ? 1.25 : 1) * ((t.vel || 0) > A.t ? 1.2 : 1) };
  }
  function structOK(u) {
    if (u.kind === 'tower') { if (u.order === 0) return true; return !A.U.some((v) => !v.dead && v.kind === 'tower' && v.team === u.team && v.lane === u.lane && v.order === 0); }
    if (u.kind === 'nexus') return A.U.filter((v) => !v.dead && v.kind === 'tower' && v.team === u.team && v.order === 1).length < 3;
    return true;
  }
  const invuln = (u) => (u.kind === 'tower' || u.kind === 'nexus') && !structOK(u);
  function enemies(tm) { const out = []; for (const u of A.U) if (!u.dead && u.team !== tm && u.team !== 2) out.push(u); for (const pu of PU.values()) if (pu.team !== tm && alive(pu)) out.push(pu); return out; }
  function nearest(u, list, range, filter) { let best = null, bd = range; for (const v of list) { if (!alive(v) || (filter && !filter(v))) continue; const d = d2(u, v); if (d < bd) { bd = d; best = v; } } return best; }
  function TX(tm, n) { A.TX[tm] += n; while (A.TX[tm] >= 120 * A.TL[tm]) { A.TX[tm] -= 120 * A.TL[tm]; A.TL[tm]++; toTeam(tm, { t: 'ar_ev', msg: `Sua equipe subiu para o <b>nível ${A.TL[tm]}</b> de equipe! (+7% de dano)` }); } }
  // ---- criação
  for (const tm of [0, 1]) {
    for (const t of AR_TOW) { const x = tm ? 64 - t.x : t.x, y = tm ? 64 - t.y : t.y; const p = aw(x, y);
      add({ team: tm, kind: 'tower', big: true, lane: tm ? { top: 'bot', bot: 'top', mid: 'mid' }[t.l] : t.l, order: t.o, name: (tm ? 'Torre Vermelha' : 'Torre Azul') + (t.o ? ' interna' : ' externa'), x: p.x, y: p.y, mhp: pd * 90, hp: pd * 90, range: 112, rate: 1.1 }); }
    const n = aw(AR_NEX[tm].x, AR_NEX[tm].y);
    add({ team: tm, kind: 'nexus', big: true, name: tm ? 'Nexus Vermelho' : 'Nexus Azul', x: n.x, y: n.y, mhp: pd * 150, hp: pd * 150, range: 0 });
  }
  function spot(s) { const p = aw(s.x, s.y); const big = s.k === 'xp' || s.k === 'hab'; return add({ team: 2, kind: 'spot', sk: s.k, spot: s, name: SPOTN[s.k], x: p.x, y: p.y, hx: p.x, hy: p.y, mhp: pd * (big ? 10 : 6), hp: pd * (big ? 10 : 6), range: 24, rate: 1.3, sp: 50, leash: 80 }); }
  for (const s of AR_SPOTS) spot(s);
  function boss(k) { const p = aw(AR_PIT[k].x, AR_PIT[k].y); const war = k === 'war';
    const u = add({ team: 2, kind: 'boss', bk: k, big: true, name: war ? 'Guerreiro Colossal' : 'Fera Ancestral', x: p.x, y: p.y, hx: p.x, hy: p.y, mhp: war ? 2000 : 1500, hp: war ? 2000 : 1500, range: war ? 34 : 38, rate: 1.4, sp: 45, leash: 80 });
    A.boss[k] = { u }; allNote(`<b style="color:#ff6ad8">${u.name}</b> apareceu na cova do rio (${war ? 'esquerda' : 'direita'})! ${u.mhp} de vida.`); }
  function minion(tm, lane, caster) { const L = tm ? LREV[lane] : LANES[lane]; const pos = aw(L[0][0], L[0][1]); const mb = A.minBuff[tm] > A.t;
    const hp = pd * (caster ? 2.6 : 3.5) * (mb ? 1.4 : 1) * (1 + .05 * (A.TL[tm] - 1));
    return add({ team: tm, kind: caster ? 'caster' : 'minion', lane, name: (tm ? 'Lacaio Vermelho' : 'Lacaio Azul') + (caster ? ' Arcano' : ''), x: pos.x + (Math.random() - .5) * 10, y: pos.y + (Math.random() - .5) * 10, mhp: hp, hp, range: caster ? 70 : 22, rate: caster ? 1.4 : 1.1, sp: (caster ? 52 : 56) * (mb ? 1.2 : 1), wi: 1 }); }
  // ---- dano
  function hurtPlayer(pu, f, src) { if (!alive(pu)) return; const def = mult(pu.team).def; hooks.send(pu.pl.spid, { t: 'ar_dmg', f: +(f * def).toFixed(4), n: src.name || '', k: src.kind }); }
  function hit(src, tgt, mulX) { if (!alive(tgt)) return; const tm = src.team; const M0 = tm === 2 ? { atk: 1 } : mult(tm);
    if (tgt.isPlayer) { let f = (FRP[src.kind] || .04) * (mulX || 1) * M0.atk; if (src.kind === 'tower') { src.stack = (src.stack || 0) + 1; f *= 1 + Math.min(1.5, (src.stack - 1) * .25); } hurtPlayer(tgt, f, src); return; }
    let f = ((FR[src.kind] || {})[tgt.kind] || .05) * (mulX || 1) * M0.atk;
    if (tm !== 2 && A.minBuff[tm] > A.t && (src.kind === 'minion' || src.kind === 'caster')) f *= 1.3;
    const def = tgt.team !== 2 ? mult(tgt.team).def : 1; dmg(tgt, tgt.mhp * f * def, src.team, null); }
  function dmg(u, d, team, spid) { if (u.dead || invuln(u)) return; u.hp -= d; if ((u.kind === 'boss' || u.kind === 'spot') && spid) u.aggro = PU.get(spid); if (u.hp <= 0) kill(u, team, spid); }
  function remove(u) { u.dead = true; const i = A.U.indexOf(u); if (i >= 0) A.U.splice(i, 1); }
  function kill(u, team, spid) { if (u.dead) return; remove(u); const byP = spid && A.pl.get(spid);
    if (u.kind === 'minion' || u.kind === 'caster') { if (team !== 2) TX(team, 5); if (byP) ev(spid, { gold: 3, xpf: .004 }); return; }
    if (u.kind === 'tower') { A.towers[u.team]--; TX(1 - u.team, 80); A.fx.push([4, Math.round(u.x), Math.round(u.y - 20), 40]);
      const who = byP ? byP.nick : 'as hordas';
      teamEv(1 - u.team, { gold: 60, msg: `Sua equipe destruiu a <b>${u.name}</b> (${who})! +60 ouro.` }); toTeam(u.team, { t: 'ar_ev', msg: `⚠ A equipe inimiga destruiu a <b>${u.name}</b>!` });
      if (byP) { ev(spid, { gold: 60, xpf: .03 }); if (hooks.stat) hooks.stat(spid, 'arT', 1); } return; }
    if (u.kind === 'nexus') { A.fx.push([4, Math.round(u.x), Math.round(u.y - 30), 80]); end(1 - u.team, 'nexus'); return; }
    if (u.kind === 'spot') { A.spotQ.push({ s: u.spot, at: A.t + SPOT_RESPAWN }); if (team === 2) return; spotReward(u.sk, team, u); return; }
    if (u.kind === 'boss') { A.boss[u.bk] = { at: A.t + BOSS_RESPAWN }; if (team === 2) return; bossReward(u.bk, team, u); } }
  function spotReward(k, tm, u) { const nm = SPOTN[k]; const other = (m) => toTeam(1 - tm, { t: 'ar_ev', msg: m });
    if (k === 'ouro') { teamEv(tm, { gold: 80, msg: `Sua equipe pegou o <b>${nm}</b>: +80 ouro.` }); }
    else if (k === 'xp') { TX(tm, 90); teamEv(tm, { xpf: .02, msg: `Sua equipe pegou o <b>${nm}</b>: +XP de equipe.` }); }
    else if (k === 'hab') { if (!A.skill[tm]) { A.skill[tm] = 1; teamEv(tm, { msg: '☄ Sua equipe liberou a <b>Habilidade da Equipe: Meteoro</b>! Use o botão na barra da arena (tecla Q).' }); other('⚠ A equipe inimiga liberou o <b>Meteoro</b>. Fique atento aos círculos no chão!'); }
      else { A.skillCD[tm] = Math.max(0, A.skillCD[tm] - 15); teamEv(tm, { msg: `Sua equipe pegou a <b>${nm}</b>: recarga do Meteoro reduzida.` }); } }
    else if (k === 'cura') { teamEv(tm, { heal: .4, msg: `Sua equipe pegou a <b>${nm}</b>: todos foram curados.` }); A.fx.push([2, Math.round(u.x), Math.round(u.y), 60]); }
    else if (k === 'forca') { A.tbuff[tm].forca = A.t + 90; teamEv(tm, { msg: `Sua equipe pegou a <b>${nm}</b>: +20% de dano por 90s.` }); }
    else if (k === 'vel') { A.tbuff[tm].vel = A.t + 90; teamEv(tm, { msg: `Sua equipe pegou a <b>${nm}</b>: +20% de velocidade por 90s.` }); } }
  function bossReward(k, tm, u) {
    if (k === 'ani') { const pool = ARBUFFS.slice().sort(() => Math.random() - .5).slice(0, 3); for (const b of pool) A.buffs[tm][b.k] = A.t + 180;
      teamEv(tm, { ruby: 300, gold: 500, toast: ['FERA ABATIDA', pool.map((b) => b.n).join(' · ')], msg: `🏆 Sua equipe abateu a <b>Fera Ancestral</b>! Bufs: ${pool.map((b) => '<b>' + b.n + '</b> (' + b.d + ')').join(', ')}. +300 rubis e +500 ouro!` });
      toTeam(1 - tm, { t: 'ar_ev', msg: '⚠ A equipe inimiga abateu a <b>Fera Ancestral</b> e ganhou 3 bufs.' }); }
    else { A.minBuff[tm] = A.t + 180;
      teamEv(tm, { ruby: 500, gold: 1000, toast: ['GUERREIRO ABATIDO', 'Hordas fortalecidas'], msg: '🏆 Sua equipe abateu o <b>Guerreiro Colossal</b>! Suas hordas ganharam 5 bufs: +40% vida, +30% dano, +20% velocidade, +25% armadura e +25% velocidade de ataque. +1000 ouro e +500 rubis!' });
      toTeam(1 - tm, { t: 'ar_ev', msg: '⚠ A equipe inimiga abateu o <b>Guerreiro Colossal</b>: as hordas dela ficaram mais fortes.' }); } }
  // ---- IA
  function attack(u, t) { u.acd = u.rate * (u.team !== 2 && A.minBuff[u.team] > A.t && (u.kind === 'minion' || u.kind === 'caster') ? .8 : 1); u.atk = .25;
    if (u.kind === 'tower') { A.fx.push([0, Math.round(u.x), Math.round(u.y - 66), Math.round(t.x), Math.round(t.y - 8), u.team]); hit(u, t); return; }
    if (u.kind === 'caster') { A.proj.push({ x: u.x, y: u.y - 12, t, src: u }); return; }
    hit(u, t);
    if (u.kind === 'boss') { A.fx.push([2, Math.round(t.x), Math.round(t.y), 26]); for (const v of enemies(2)) if (v !== t && d2(v, t) < 30) hit(u, v, .5); } }
  function towerAI(u, dt) { if (u.kind === 'nexus') return; u.acd -= dt; u.rt -= dt;
    if (u.rt <= 0) { u.rt = .25; const en = enemies(u.team); let t = null, bd = u.range;
      if (u.tg && alive(u.tg) && d2(u, u.tg) < u.range && !u.tg.isPlayer) t = u.tg;
      if (!t) for (const v of en) if (!v.isPlayer && (v.kind === 'minion' || v.kind === 'caster')) { const d = d2(u, v); if (d < bd) { bd = d; t = v; } }
      if (!t) { bd = u.range; for (const v of en) if (v.isPlayer) { const d = d2(u, v); if (d < bd) { bd = d; t = v; } } }
      if (t !== u.tg) u.stack = 0; u.tg = t; }
    if (u.tg && alive(u.tg) && d2(u, u.tg) < u.range && u.acd <= 0) attack(u, u.tg); }
  function step(u, gx, gy, dt, sp) { const dx = gx - u.x, dy = gy - u.y, l = Math.hypot(dx, dy) || 1; const s = Math.min(l, sp * dt); u.x += dx / l * s; u.y += dy / l * s; u.fl = dx < 0 ? 1 : 0; u.mv = s > .01 ? 1 : 0; return l - s; }
  function minionAI(u, dt) { u.acd -= dt; u.rt -= dt;
    if (u.rt <= 0) { u.rt = .3; const en = enemies(u.team); let t = nearest(u, en, 78, (v) => v.kind === 'minion' || v.kind === 'caster'); if (!t) t = nearest(u, en, 70, (v) => v.isPlayer); if (!t) t = nearest(u, en, 90, (v) => (v.kind === 'tower' || v.kind === 'nexus') && structOK(v)); u.tg = t; }
    const t = u.tg; const sp = u.sp * mult(u.team).spd;
    if (t && alive(t)) { const d = d2(u, t); const rr = u.range + (t.big ? 16 : 0); if (d > rr) step(u, t.x, t.y + (t.big ? 6 : 0), dt, sp); else { u.mv = 0; if (u.acd <= 0) attack(u, t); } return; }
    const L = u.team ? LREV[u.lane] : LANES[u.lane];
    if (u.wi >= L.length) { const nx = aw(AR_NEX[1 - u.team].x, AR_NEX[1 - u.team].y); step(u, nx.x, nx.y, dt, sp); return; }
    const p = aw(L[u.wi][0], L[u.wi][1]); if (step(u, p.x, p.y, dt, sp) < 6) u.wi++; }
  function neutralAI(u, dt) { u.acd -= dt; const t = u.aggro;
    if (t && alive(t) && Math.hypot(t.x - u.hx, t.y - u.hy) < u.leash + 30) { const d = d2(u, t); if (d > u.range + (u.kind === 'boss' ? 8 : 0)) step(u, t.x, t.y, dt, u.sp); else { u.mv = 0; if (u.acd <= 0) attack(u, t); } return; }
    u.aggro = null; if (Math.hypot(u.x - u.hx, u.y - u.hy) > 3) step(u, u.hx, u.hy, dt, u.sp * 1.4); else { u.mv = 0; u.hp = Math.min(u.mhp, u.hp + u.mhp * .2 * dt); } }
  // ---- fim
  function end(winner, why) { if (A.over) return; A.over = { winner, why };
    for (const pl of A.pl.values()) { if (pl.gone) continue; const win = pl.team === winner;
      hooks.send(pl.spid, { t: 'ar_end', win, why, kills: A.kills, towers: A.towers, TL: A.TL, gold: win ? 800 : 200, xpf: win ? .25 : .08 }); }
    hooks.ended(A); }
  // ---- API
  A.tick = function (dt) { if (A.over) return; A.t += dt; A.fx = [];
    A.waveT -= dt; if (A.waveT <= 0) { A.waveT = WAVE_EVERY; A.wave++; for (const tm of [0, 1]) for (const l of ['top', 'mid', 'bot']) { for (let k = 0; k < 3; k++) minion(tm, l, false); minion(tm, l, true); } if (A.wave === 1) allNote('As <b>hordas</b> saíram pelas 3 rotas!'); }
    for (let i = A.spotQ.length - 1; i >= 0; i--) if (A.t >= A.spotQ[i].at) { spot(A.spotQ[i].s); A.spotQ.splice(i, 1); }
    for (const k of ['war', 'ani']) { const b = A.boss[k]; if (!b.u && b.at != null && A.t >= b.at) boss(k); }
    for (const u of A.U.slice()) { if (u.dead) continue; u.atk = Math.max(0, (u.atk || 0) - dt);
      if (u.kind === 'tower' || u.kind === 'nexus') towerAI(u, dt); else if (u.kind === 'minion' || u.kind === 'caster') minionAI(u, dt); else neutralAI(u, dt);
      if ((u.kind === 'minion' || u.kind === 'caster') && inFon(u.x, u.y, 1 - u.team)) dmg(u, u.mhp * .4 * dt, 1 - u.team, null); }
    for (let i = A.proj.length - 1; i >= 0; i--) { const p = A.proj[i]; const t = p.t; if (!alive(t)) { A.proj.splice(i, 1); continue; } const dx = t.x - p.x, dy = (t.y - (t.big ? 30 : 8)) - p.y, l = Math.hypot(dx, dy);
      if (l < 8) { A.proj.splice(i, 1); hit(p.src, t); continue; } p.x += dx / l * 230 * dt; p.y += dy / l * 230 * dt; }
    for (const tm of [0, 1]) if (A.skillCD[tm] > 0) A.skillCD[tm] -= dt;
    for (let i = A.tele.length - 1; i >= 0; i--) { const f = A.tele[i]; if (A.t >= f.at) { A.tele.splice(i, 1); A.fx.push([4, Math.round(f.x), Math.round(f.y), f.r]); const src = { team: f.team, kind: 'meteor', name: 'Meteoro' };
      for (const v of enemies(f.team)) if (Math.hypot(v.x - f.x, v.y - f.y) < f.r) hit(src, v);
      for (const v of A.U) if (v.team === 2 && !v.dead && Math.hypot(v.x - f.x, v.y - f.y) < f.r) dmg(v, v.mhp * .3, f.team, f.spid); } }
    if (A.t > MATCH_MAX) { const tb = A.towers[0], tr = A.towers[1]; end(tr < tb ? 1 : tb < tr ? 0 : A.kills[0] >= A.kills[1] ? 0 : 1, 'tempo'); return; }
    for (const tm of [0, 1]) if (![...A.pl.values()].some((pl) => pl.team === tm && !pl.gone)) { end(1 - tm, 'abandono'); return; }
  };
  A.state = function () { const bf = [0, 1].map((tm) => { const o = {}; for (const k in A.buffs[tm]) if (A.buffs[tm][k] > A.t) o[k] = Math.round(A.buffs[tm][k] - A.t); for (const k in A.tbuff[tm]) if (A.tbuff[tm][k] > A.t) o[k] = Math.round(A.tbuff[tm][k] - A.t); if (A.minBuff[tm] > A.t) o.hordas = Math.round(A.minBuff[tm] - A.t); return o; });
    const bo = {}; for (const k of ['war', 'ani']) { const b = A.boss[k]; bo[k] = b.u && !b.u.dead ? { hp: Math.round(b.u.hp), mhp: b.u.mhp } : { at: b.at != null ? Math.round(b.at - A.t) : null }; }
    const u = A.U.map((v) => [v.id, KC[v.kind], v.team, Math.round(v.x), Math.round(v.y), Math.max(0, Math.round(v.hp)), Math.round(v.mhp), (invuln(v) ? 1 : 0) | (v.atk > 0 ? 2 : 0) | (v.mv ? 4 : 0) | (v.fl ? 8 : 0) | (A.minBuff[v.team] > A.t ? 16 : 0),
      v.kind === 'spot' ? SPOTK.indexOf(v.sk) : v.kind === 'boss' ? (v.bk === 'war' ? 0 : 1) : v.kind === 'tower' ? v.order : 0, v.tg && v.tg.isPlayer ? v.tg.pl.spid : '']);
    return { t: 'ar_s', tm: Math.round(A.t * 10) / 10, k: A.kills, tw: A.towers, TL: A.TL, sk: A.skill, cd: A.skillCD.map((c) => Math.max(0, Math.ceil(c))), bf, bo, u,
      fx: A.fx, pr: A.proj.map((p) => [Math.round(p.x), Math.round(p.y), p.src.team]), te: A.tele.map((f) => [Math.round(f.x), Math.round(f.y), f.r, f.team, Math.round((f.at - A.t) * 10) / 10]) }; };
  A.hit = function (spid, id, d) { const pl = A.pl.get(spid); if (!pl || pl.gone || A.over || pl.dead > A.t) return; const now = Date.now(); if (now - pl.hitT > 1000) { pl.hitT = now; pl.hits = 0; } if (++pl.hits > 40) return;
    const u = A.U.find((v) => v.id === id); if (!u || u.team === pl.team) return; if (Math.hypot(u.x - pl.p.x, u.y - pl.p.y) > 420) return;
    d = Math.max(0, Math.min(1e7, +d || 0)); if (!d) return; if (invuln(u)) return; dmg(u, d, pl.team, spid); };
  A.dead = function (spid, bySpid) { const pl = A.pl.get(spid); if (!pl || A.over || pl.dead > A.t) return; pl.dead = A.t + 9; const k = bySpid && A.pl.get(bySpid);
    if (k && k.team !== pl.team) { A.kills[k.team]++; if (hooks.stat) hooks.stat(k.spid, 'arK', 1); TX(k.team, 40); ev(k.spid, { gold: 40, xpf: .02, msg: `Você abateu <b>${pl.nick}</b>! +40 ouro.` }); toAll({ t: 'ar_ev', msg: `<b>${k.nick}</b> abateu <b>${pl.nick}</b>.` }); }
    else { A.kills[1 - pl.team]++; TX(1 - pl.team, 20); } };
  A.meteor = function (spid, x, y) { const pl = A.pl.get(spid); if (!pl || A.over || pl.dead > A.t) return; const tm = pl.team; if (!A.skill[tm] || A.skillCD[tm] > 0) return;
    if (Math.hypot(x - pl.p.x, y - pl.p.y) > 260) return; A.skillCD[tm] = 35; A.tele.push({ x: +x, y: +y, r: 52, team: tm, at: A.t + 1, spid });
    toTeam(tm, { t: 'ar_ev', msg: `☄ <b>${pl.nick}</b> lançou o Meteoro da Equipe!` }); };
  A.leave = function (spid) { const pl = A.pl.get(spid); if (pl) pl.gone = true; };
  A.team = (spid) => { const pl = A.pl.get(spid); return pl ? pl.team : null; };
  return A;
}
module.exports = { createMatch };
