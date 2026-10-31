// Anonymous visit statistics: where visitors walk, what they look at, which rooms they see.
// No cookies and nothing stored on the visitor's device - the visit id lives in memory only.
// Sent to the intus stats Worker every 15 s and when the visitor leaves.

const CELL = 0.25;          // metres per heat cell
const TICK = 0.25;          // seconds between samples
const PATH_EVERY = 2;       // seconds between route points
const MAX_LOOK = 3000, MAX_WALK = 3000, MAX_PATH = 900;

const visitId = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => abc[x % abc.length]).join('');
};

export function statsEnabled(url) {
  if (!url) return false;
  const q = new URLSearchParams(location.search);
  if (q.has('edit') || q.has('heat') || q.has('nostats')) return false;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !q.has('stats')) return false;
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') return false;
  return true;
}

export class VisitRecorder {
  constructor({ url, tour, device, lang }) {
    this.url = url.replace(/\/+$/, '') + '/collect';
    this.base = { v: 1, tour, sid: visitId(), started: Date.now(), device, lang };
    this.dur = 0; this.acc = 0; this.pathAcc = PATH_EVERY;
    this.rooms = {}; this.order = []; this.walk = {}; this.look = {}; this.path = [];
    this.quality = null; this.gyro = false; this.lastRoom = null;
    this.dirty = false; this.lastSend = 0;
    const flush = () => this.send(true);
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    this.timer = setInterval(() => { if (this.dirty && performance.now() - this.lastSend > 14000) this.send(false); }, 5000);
  }

  // called every frame while the visitor is in the tour (not paused)
  // s = { dt, feet:[x,y,z], level, room, eye:[x,y,z], dir:[x,y,z], cast(o, d) -> {p:[x,y,z], n:[x,y,z]} | null }
  tick(s) {
    this.acc += Math.min(s.dt, 0.25);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.dur += TICK;
      const [x, , z] = s.feet;
      const wk = `${s.level}:${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
      if (wk in this.walk || Object.keys(this.walk).length < MAX_WALK) this.walk[wk] = +((this.walk[wk] || 0) + TICK).toFixed(2);
      if (s.room) {
        this.rooms[s.room] = +((this.rooms[s.room] || 0) + TICK).toFixed(2);
        if (s.room !== this.lastRoom) { this.order.push(s.room); this.lastRoom = s.room; }
      }
      const hit = s.cast(s.eye, s.dir);
      if (hit) {
        const [px, py, pz] = hit.p, [nx, ny, nz] = hit.n;
        const ax = Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz) ? (nx > 0 ? 0 : 1)
          : Math.abs(ny) >= Math.abs(nz) ? (ny > 0 ? 2 : 3) : (nz > 0 ? 4 : 5);
        const lk = `${Math.floor(px / CELL)}:${Math.floor(py / CELL)}:${Math.floor(pz / CELL)}:${ax}`;
        if (lk in this.look || Object.keys(this.look).length < MAX_LOOK) this.look[lk] = (this.look[lk] || 0) + 1;
      }
      this.pathAcc += TICK;
      if (this.pathAcc >= PATH_EVERY && this.path.length < MAX_PATH) {
        this.pathAcc = 0;
        this.path.push([Math.round(this.dur), +x.toFixed(2), +z.toFixed(2), s.level]);
      }
      this.dirty = true;
    }
  }

  send(final) {
    if (!this.dirty || this.dur < 3) return;
    const body = JSON.stringify({
      ...this.base, dur: Math.round(this.dur), q: this.quality, gyro: this.gyro, final: !!final,
      rooms: this.rooms, order: this.order, walk: this.walk, look: this.look, path: this.path,
    });
    this.dirty = false;
    this.lastSend = performance.now();
    try {
      // text/plain keeps it a "simple" request: no preflight, and it survives the page closing
      if (!navigator.sendBeacon?.(this.url, new Blob([body], { type: 'text/plain' }))) {
        fetch(this.url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
      }
    } catch { /* stats must never break the tour */ }
  }
}
