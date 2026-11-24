// 부킹 클럽 실시간 서버.
// - Room: 장소(0 노을, 1 바닷속)와 방 번호마다 하나. 최대 30명. 위치·춤·반응을 같은 방 사람들에게 전달만 한다.
// - Stats: 일자별(한국 날짜) 입장수 / 순 사용자 / 재방문 / 최대 동시 접속.
// 대화 기능은 없고, 이름은 정해진 낱말 조합만 허용한다(누구도 다른 사람에게 글을 보여줄 수 없게).
import { DurableObject } from 'cloudflare:workers';

const MAX_PEOPLE = 30, MAX_ROOMS = 40, MAX_BOTS = 6;
const ADJ = ['신난','졸린','배고픈','수줍은','용감한','느긋한','반짝이는','엉뚱한','씩씩한','말랑한','날쌘','든든한'];
const ANI = ['수달','너구리','펭귄','고양이','다람쥐','문어','판다','오리','거북이','여우','햄스터','고래'];
const NAME_RE = new RegExp('^(' + ADJ.join('|') + ')(' + ANI.join('|') + ')[1-9][0-9]$');
const pick = a => a[Math.floor(Math.random() * a.length)];
const makeName = () => pick(ADJ) + pick(ANI) + (10 + Math.floor(Math.random() * 90));
const shortId = () => Math.random().toString(36).slice(2, 8);
const num = (v, lim) => { v = Number(v); return Number.isFinite(v) ? Math.max(-lim, Math.min(lim, Math.round(v * 100) / 100)) : 0; };
const int = (v, lo, hi) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo; };
const kstDay = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

function allowed(env, origin) {
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(origin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      if (!allowed(env, req.headers.get('Origin') || '')) return new Response('forbidden', { status: 403 });
      const place = url.searchParams.get('place') === '1' ? 1 : 0;
      // 1번 방부터 자리가 있는 방을 찾는다. 꽉 찬 방은 409로 답한다.
      for (let r = 1; r <= MAX_ROOMS; r++) {
        const stub = env.ROOM.get(env.ROOM.idFromName(place + '-' + r));
        const res = await stub.fetch(new Request('https://room/ws?place=' + place + '&room=' + r, req));
        if (res.status !== 409) return res;
      }
      return new Response('full', { status: 503 });
    }
    if (url.pathname === '/stats') return statsPage(req, env);
    if (url.pathname === '/') return new Response('booking-club ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  }
};

/* ---------------- Room ---------------- */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rate = new WeakMap();
    // 메시지가 없으면 잠들었다가(요금 절약) 깨어날 때 각 연결에 붙여둔 정보로 상태를 되살린다.
    this.peers = new Map(); this.bots = new Map(); this.host = null;
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment(); if (!a || !a.id) continue;
      this.peers.set(ws, a);
      if (a.host) { this.host = ws; (a.bots || []).forEach(b => this.bots.set(b.id, b)); }
    }
    if (!this.host && this.peers.size) this.pickHost();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (this.ctx.getWebSockets().length >= MAX_PEOPLE) return new Response('room full', { status: 409 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ place: int(url.searchParams.get('place'), 0, 1), room: int(url.searchParams.get('room'), 1, MAX_ROOMS) });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  save(ws) { const a = this.peers.get(ws); if (a) { if (ws === this.host) a.bots = [...this.bots.values()]; ws.serializeAttachment(a); } }
  send(ws, m) { try { ws.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch (e) {} }
  broadcast(m, except) { const s = JSON.stringify(m); for (const ws of this.peers.keys()) if (ws !== except) this.send(ws, s); }
  humans() { return this.peers.size; }
  pub(a) { return { id: a.id, name: a.name, v: a.v, x: a.x, z: a.z, tx: a.tx, tz: a.tz, m: a.m, seat: a.seat }; }
  // 방장: 화면을 보고 있는 사람 중 가장 먼저 들어온 사람. 모두 자리를 비우면 그중 가장 먼저 온 사람.
  pickHost() {
    let best = null;
    const better = (a, b) => !b || (!!a.away !== !!b.away ? !a.away : a.since < b.since);
    for (const [ws, a] of this.peers) if (better(a, best && this.peers.get(best))) best = ws;
    const old = this.host;
    if (best === old) return;
    if (old && this.peers.has(old)) { const o = this.peers.get(old); o.host = false; o.bots = undefined; old.serializeAttachment(o); this.send(old, { t: 'h0' }); }
    this.host = best;
    if (best) { this.peers.get(best).host = true; this.save(best); this.send(best, { t: 'h', bots: [...this.bots.values()] }); }
    else this.bots.clear();
  }
  // 1초에 20개 넘게 보내면 버린다(장난 방지).
  limited(ws) {
    const now = Date.now(); let r = this.rate.get(ws);
    if (!r || now - r.t > 1000) { r = { t: now, n: 0 }; this.rate.set(ws, r); }
    return ++r.n > 20;
  }
  report() {
    const stats = this.env.STATS.get(this.env.STATS.idFromName('global'));
    const a = this.peers.values().next().value;
    if (a) this.ctx.waitUntil(stats.online(a.place + '-' + a.room, this.humans()).catch(() => {}));
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 1500 || this.limited(ws)) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'p') return this.send(ws, { t: 'p', c: m.c, s: Date.now() });
    const me = this.peers.get(ws);

    if (m.t === 'hi') {
      if (me) return;
      const base = ws.deserializeAttachment() || {};
      const a = {
        ...base, id: 'u' + shortId(), name: typeof m.name === 'string' && NAME_RE.test(m.name) ? m.name : makeName(),
        v: m.v == null ? int(Math.random() * 6, 0, 5) : int(m.v, 0, 5), x: num(Math.random() * 8 - 4, 12), z: num(1 + Math.random() * 3, 12), m: 0, seat: -1, since: Date.now(), host: false
      };
      a.tx = a.x; a.tz = a.z;
      this.peers.set(ws, a);
      if (!this.host) { this.host = ws; a.host = true; }
      ws.serializeAttachment(a);
      const others = [...this.peers].filter(([w]) => w !== ws).map(([, p]) => this.pub(p));
      this.send(ws, { t: 'w', you: this.pub(a), room: a.room, place: a.place, host: a.host, now: Date.now(), peers: others, bots: [...this.bots.values()], n: this.humans() });
      this.broadcast({ t: 'j', p: this.pub(a), n: this.humans() }, ws);
      if (m.enter && typeof m.vid === 'string' && /^[a-z0-9]{8,40}$/.test(m.vid)) {
        const stats = this.env.STATS.get(this.env.STATS.idFromName('global'));
        this.ctx.waitUntil(stats.enter(m.vid).catch(() => {}));
      }
      this.report();
      return;
    }
    if (!me) return;

    if (m.t === 'away' || m.t === 'back') {
      me.away = m.t === 'away'; ws.serializeAttachment(me);
      if ((me.away && ws === this.host) || (!me.away && this.host && this.peers.get(this.host).away)) this.pickHost();
      if (ws === this.host) this.save(ws);
    } else if (m.t === 's') {
      me.x = num(m.x, 12); me.z = num(m.z, 12); me.tx = num(m.tx, 12); me.tz = num(m.tz, 12); me.m = int(m.m, 0, 6); me.seat = int(m.seat, -1, 40);
      ws.serializeAttachment(me);
      this.broadcast({ t: 's', id: me.id, x: me.x, z: me.z, tx: me.tx, tz: me.tz, m: me.m, seat: me.seat }, ws);
    } else if (m.t === 'r') {
      const now = Date.now(); if (now - (me.rc || 0) < 700) return; me.rc = now;
      this.broadcast({ t: 'r', id: me.id, k: int(m.k, 1, 2), to: typeof m.to === 'string' ? m.to.slice(0, 12) : '' }, ws);
    } else if (m.t === 'b' && ws === this.host) {
      // 컴퓨터 댄서는 방장(가장 먼저 들어온 사람)의 화면이 움직이고, 서버는 전달만 한다.
      const id = typeof m.id === 'string' && /^b[a-z0-9]{1,8}$/.test(m.id) ? m.id : null; if (!id) return;
      if (m.op === 'add') {
        if (this.bots.has(id) || this.bots.size >= MAX_BOTS) return;
        const b = { id, name: NAME_RE.test(m.name) ? m.name : makeName(), v: int(m.v, 0, 5), x: num(m.x, 12), z: num(m.z, 12), m: int(m.m, 0, 6), seat: -1, bot: 1 };
        b.tx = b.x; b.tz = b.z; this.bots.set(id, b);
        this.broadcast({ t: 'j', p: b }, ws);
      } else if (m.op === 'del') {
        if (this.bots.delete(id)) this.broadcast({ t: 'l', id }, ws);
      } else if (m.op === 's') {
        const b = this.bots.get(id); if (!b) return;
        b.x = num(m.x, 12); b.z = num(m.z, 12); b.tx = num(m.tx, 12); b.tz = num(m.tz, 12); b.m = int(m.m, 0, 6); b.seat = int(m.seat, -1, 40);
        this.broadcast({ t: 's', id, x: b.x, z: b.z, tx: b.tx, tz: b.tz, m: b.m, seat: b.seat }, ws);
      } else if (m.op === 'r') {
        if (!this.bots.has(id)) return;
        this.broadcast({ t: 'r', id, k: int(m.k, 1, 3), to: typeof m.to === 'string' ? m.to.slice(0, 12) : '' }, ws);
      }
      this.save(ws);
    }
  }

  async webSocketClose(ws) { this.drop(ws); try { ws.close(1000); } catch (e) {} }
  async webSocketError(ws) { this.drop(ws); }
  drop(ws) {
    const a = this.peers.get(ws); if (!a) return;
    this.peers.delete(ws);
    this.broadcast({ t: 'l', id: a.id, n: this.humans() });
    if (ws === this.host) { this.host = null; this.pickHost(); }
    if (!this.peers.size) this.bots.clear();
    const stats = this.env.STATS.get(this.env.STATS.idFromName('global'));
    this.ctx.waitUntil(stats.online(a.place + '-' + a.room, this.humans()).catch(() => {}));
  }
}

/* ---------------- Stats ---------------- */
// 저장하는 것: 브라우저가 만든 무작위 번호의 해시값과 날짜뿐. 이름·IP·기기 정보는 저장하지 않는다.
export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily(day TEXT PRIMARY KEY, entries INTEGER NOT NULL DEFAULT 0, uniques INTEGER NOT NULL DEFAULT 0, revisits INTEGER NOT NULL DEFAULT 0, peak INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS seen(day TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY(day, vid));
      CREATE TABLE IF NOT EXISTS first(vid TEXT PRIMARY KEY, day TEXT NOT NULL);`);
    this.rooms = new Map(); this.cleaned = '';
  }
  row(day) { this.sql.exec('INSERT INTO daily(day) VALUES(?) ON CONFLICT(day) DO NOTHING', day); }
  async enter(vid) {
    const day = kstDay(), h = await hash(vid);
    this.row(day);
    const fresh = this.sql.exec('INSERT INTO seen(day, vid) VALUES(?, ?) ON CONFLICT DO NOTHING', day, h).rowsWritten > 0;
    let revisit = 0;
    if (fresh) {
      const f = this.sql.exec('SELECT day FROM first WHERE vid = ?', h).toArray();
      if (f.length) revisit = f[0].day < day ? 1 : 0;
      else this.sql.exec('INSERT INTO first(vid, day) VALUES(?, ?)', h, day);
    }
    this.sql.exec('UPDATE daily SET entries = entries + 1, uniques = uniques + ?, revisits = revisits + ? WHERE day = ?', fresh ? 1 : 0, revisit, day);
    // 날짜별 방문 기록은 120일 지나면 지운다(합계는 daily에 남음).
    if (this.cleaned !== day) { this.cleaned = day; this.sql.exec('DELETE FROM seen WHERE day < ?', kstDay(Date.now() - 120 * 86400e3)); }
  }
  async online(roomKey, count) {
    if (count > 0) this.rooms.set(roomKey, count); else this.rooms.delete(roomKey);
    let total = 0; for (const c of this.rooms.values()) total += c;
    const day = kstDay(); this.row(day);
    this.sql.exec('UPDATE daily SET peak = MAX(peak, ?) WHERE day = ?', total, day);
  }
  async report(limit) {
    let now = 0; for (const c of this.rooms.values()) now += c;
    return { now, days: this.sql.exec('SELECT day, entries, uniques, revisits, peak FROM daily ORDER BY day DESC LIMIT ?', limit).toArray() };
  }
}

async function hash(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('booking-club:' + s));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function page(body) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>부킹 클럽 통계</title>
<style>body{font-family:system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#1a1b4b;color:#fff8f0;margin:0;padding:24px 16px;max-width:720px;margin:auto}
h1{font-size:22px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:10px 6px;border-bottom:1px solid rgba(255,255,255,.18);text-align:right}th:first-child,td:first-child{text-align:left}
th{font-size:13px;color:#d6cbe8;font-weight:600}input,button{font:inherit;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.3);background:#2a2560;color:inherit}button{background:#ffd400;color:#231a3d;font-weight:800;border:0}
.now{font-size:18px;margin:8px 0 20px}.note{color:#d6cbe8;font-size:13px;line-height:1.6;margin-top:20px}</style>${body}`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
async function statsPage(req, env) {
  const form = '<h1>부킹 클럽 통계</h1><form method="post"><input type="password" name="key" placeholder="비밀번호" autocomplete="current-password" required> <button>보기</button></form>';
  if (!env.STATS_KEY) return page('<h1>통계 비밀번호가 아직 설정되지 않았어요.</h1>');
  if (req.method !== 'POST') return page(form);
  const key = String((await req.formData()).get('key') || '');
  if (!same(key, env.STATS_KEY)) return page(form + '<p>비밀번호가 맞지 않아요.</p>');
  const r = await env.STATS.get(env.STATS.idFromName('global')).report(90);
  const rows = r.days.map(d => `<tr><td>${esc(d.day)}</td><td>${d.entries}</td><td>${d.uniques}</td><td>${d.uniques - d.revisits}</td><td>${d.revisits}</td><td>${d.peak}</td></tr>`).join('');
  return page(`<h1>부킹 클럽 통계</h1><div class="now">지금 접속 중: <b>${r.now}</b>명</div>
<table><thead><tr><th>날짜(한국)</th><th>입장수</th><th>순 사용자</th><th>신규</th><th>재방문</th><th>최대 동시</th></tr></thead><tbody>${rows || '<tr><td colspan="6">아직 기록이 없어요.</td></tr>'}</tbody></table>
<p class="note">입장수: "입장하기"를 누른 횟수 전부. 순 사용자: 그날 들어온 서로 다른 사람(브라우저) 수. 신규: 그날 처음 온 사람. 재방문: 그날 온 사람 중 예전 날짜에도 왔던 사람. 최대 동시: 그날 같은 시각에 가장 많이 접속해 있던 사람 수.<br>다른 기기·브라우저로 오거나 방문 기록을 지우면 새 사람으로 세어져요.</p>`);
}
