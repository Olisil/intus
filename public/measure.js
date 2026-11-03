// intus measuring tool: freeze the view, click two points on any surface, read the distance.
// Points snap onto the splat itself (the cloud of Gaussian centres), guided by the collision mesh,
// so the numbers are as true as the scan allows. Measurements stay in the scene for the whole visit.

export const RULER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3.5 15.5 15.5 3.5l5 5-12 12z"/><path d="M6.5 12.5l2 2M9 10l1.2 1.2M11.5 7.5l2 2M14 5l1.2 1.2"/></svg>';

const ACCENT = '#e8dcc7';

// Gaussian centres bucketed into a coarse grid (splat-local space), for fast ray queries.
class CentreGrid {
  constructor(centres) {
    const n = centres.length / 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = centres[i * 3], y = centres[i * 3 + 1], z = centres[i * 3 + 2];
      if (!Number.isFinite(x + y + z)) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    let cell = 0.2;
    const dims = () => [Math.floor((x1 - x0) / cell) + 1, Math.floor((y1 - y0) / cell) + 1, Math.floor((z1 - z0) / cell) + 1];
    while (dims().reduce((a, b) => a * b, 1) > 6e6) cell *= 1.25;
    const [nx, ny, nz] = dims();
    Object.assign(this, { centres, n, x0, y0, z0, cell, nx, ny, nz });
    const cellOf = new Int32Array(n), count = new Int32Array(nx * ny * nz + 1);
    for (let i = 0; i < n; i++) {
      const c = this._cell(centres[i * 3], centres[i * 3 + 1], centres[i * 3 + 2]);
      cellOf[i] = c;
      if (c >= 0) count[c + 1]++;
    }
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    const fill = count.slice(0, -1), items = new Int32Array(count[count.length - 1]);
    for (let i = 0; i < n; i++) if (cellOf[i] >= 0) items[fill[cellOf[i]]++] = i;
    this.start = count; this.items = items;
  }

  _cell(x, y, z) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell), k = Math.floor((z - this.z0) / this.cell);
    if (!(i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz)) return -1;
    return i + this.nx * (j + this.ny * k);
  }

  // centres within radius r(t) of the ray o + t d (unit d), as [t, x, y, z] rows sorted by t
  _near(o, d, tMin, tMax, R0, RK) {
    const seen = new Set(), C = this.centres, out = [];
    const reach = Math.ceil(Math.max(R0, tMax * RK) / this.cell);
    const step = this.cell * 0.5;
    for (let t = tMin; t <= tMax + step; t += step) {
      const px = o[0] + d[0] * t, py = o[1] + d[1] * t, pz = o[2] + d[2] * t;
      for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) for (let c = -reach; c <= reach; c++) {
        const id = this._cell(px + a * this.cell, py + b * this.cell, pz + c * this.cell);
        if (id < 0 || seen.has(id)) continue;
        seen.add(id);
        for (let s = this.start[id], e = this.start[id + 1]; s < e; s++) {
          const i = this.items[s];
          const x = C[i * 3], y = C[i * 3 + 1], z = C[i * 3 + 2];
          const vx = x - o[0], vy = y - o[1], vz = z - o[2];
          const tt = vx * d[0] + vy * d[1] + vz * d[2];
          if (tt < tMin || tt > tMax) continue;
          const r = Math.max(R0, tt * RK);
          if (vx * vx + vy * vy + vz * vz - tt * tt < r * r) out.push([tt, x, y, z]);
        }
      }
    }
    return out.sort((p, q) => p[0] - q[0]);
  }

  // First surface along the ray. The Gaussians are sparse (each covers several cm), so: find the
  // nearest place where several centres agree (a surface, not a stray floater), fit a plane through
  // the centres there, and intersect the ray with it - exact on walls, floors, ceilings and tops.
  hit(o, d, tMin, tMax) {
    for (const [R0, RK] of [[0.05, 0.012], [0.1, 0.02]]) {
      const pts = this._near(o, d, tMin, tMax, R0, RK);
      for (let i = 0; i < pts.length; i++) {
        let j = i;
        while (j + 1 < pts.length && pts[j + 1][0] - pts[i][0] < 0.1) j++;
        if (j - i + 1 < 4) continue;
        const t0 = pts[(i + j) >> 1][0];
        const local = pts.filter((q) => q[0] > pts[i][0] - 0.05 && q[0] < pts[i][0] + 0.25);
        const t = planeHit(local, o, d, t0);
        return t ?? t0;
      }
    }
    return null;
  }
}

// least-squares plane through points ([t,x,y,z] rows), dropping outliers once; ray o + t d meets it at t
function planeHit(rows, o, d, tGuess) {
  let pts = rows.map((r) => [r[1], r[2], r[3]]);
  let plane = null;
  for (let pass = 0; pass < 2; pass++) {
    if (pts.length < 4) return plane ? rayPlane(plane, o, d, tGuess) : null;
    plane = fitPlane(pts);
    if (!plane) return null;
    const [n, c] = plane;
    pts = pts.filter((p) => Math.abs((p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]) < 0.03);
  }
  return rayPlane(plane, o, d, tGuess);
}
function rayPlane([n, c], o, d, tGuess) {
  const den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
  if (Math.abs(den) < 0.2) return null;       // grazing: trust the cluster instead
  const t = ((c[0] - o[0]) * n[0] + (c[1] - o[1]) * n[1] + (c[2] - o[2]) * n[2]) / den;
  return Math.abs(t - tGuess) < 0.15 ? t : null;
}
function fitPlane(pts) {
  const n = pts.length, c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= n; c[1] /= n; c[2] /= n;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a][b] += q[a] * q[b];
  }
  // Jacobi eigen-decomposition of the 3x3 covariance; the normal is the smallest eigenvector
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-12) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = cs * akp - sn * akq; A[k][q] = sn * akp + cs * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = cs * apk - sn * aqk; A[q][k] = sn * apk + cs * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq; }
    }
  }
  const ev = [A[0][0], A[1][1], A[2][2]];
  const m = ev.indexOf(Math.min(...ev));
  // a plane needs spread in two directions; a blob or a line can't define one
  const sorted = [...ev].sort((x, y) => x - y);
  if (sorted[1] < 4 * sorted[0] || sorted[1] / n < 0.0004) return null;
  return [[V[0][m], V[1][m], V[2][m]], c];
}

const fmtNum = (x, dec) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', dec));

export class Measure {
  // cast(o, d): first collision hit {p, n} or null (world space)
  constructor({ pc, app, camera, splat, cast, T, lang, planAngle = 0, scale = 1, onToggle }) {
    Object.assign(this, { pc, app, camera, splat, cast, T, scale, onToggle });
    this.dec = lang === 'en' ? '.' : ',';
    this.on = false;
    this.list = [];            // { a:[x,y,z], b:[x,y,z], axis }
    this.first = null;         // pending first point
    this.hover = null;         // { p, ok, snapped }
    this.hl = -1;              // highlighted measurement (list hover)
    this.grid = null; this.gridRes = null;
    const a = planAngle;
    this.axes = [[0, 1, 0, '↕'], [Math.cos(a), 0, -Math.sin(a), '↔'], [Math.sin(a), 0, Math.cos(a), '↔']];
    this.vis = new Map(); this.visT = 0;
    this._dom();
  }

  // ------------------------------------------------------------ DOM
  _dom() {
    const $ = (id) => document.getElementById(id);
    const T = this.T;
    this.layer = $('measureLayer'); this.ctx = this.layer.getContext('2d');
    this.cross = $('measureCross');
    this.btn = $('measureBtn'); this.panel = $('measurePanel'); this.listEl = $('mpList');
    this.btn.innerHTML = RULER + '<em class="count hidden"></em>';
    this.btn.title = T.measureKey; this.btn.setAttribute('aria-label', T.measure);
    $('mpTitle').textContent = T.measure;
    $('mpTip').textContent = T.measureTip;
    $('mpDone').textContent = T.measureDone;
    $('mpClear').textContent = T.measureClear;
    this.btn.addEventListener('click', () => { this.btn.blur(); this.onToggle?.(); });
    $('mpDone').addEventListener('click', (e) => { e.currentTarget.blur(); this.onToggle?.(); });
    $('mpClear').addEventListener('click', (e) => { e.currentTarget.blur(); this.list = []; this.first = null; this._renderList(); });
    this.listEl.addEventListener('click', (e) => {
      const x = e.target.closest('[data-del]'); if (!x) return;
      this.list.splice(+x.dataset.del, 1); this.hl = -1; this._renderList();
    });
    this.listEl.addEventListener('mouseover', (e) => { const r = e.target.closest('[data-i]'); this.hl = r ? +r.dataset.i : -1; });
    this.listEl.addEventListener('mouseleave', () => { this.hl = -1; });
    this._renderList();
  }

  fmt(m) {
    const cm = Math.round(m * this.scale * 200) / 2;   // nearest half centimetre
    if (cm < 100) return `${fmtNum(cm, this.dec)} cm`;
    const whole = Math.floor(cm / 100);
    return `${whole} m ${fmtNum(+(cm - whole * 100).toFixed(1), this.dec)} cm`;
  }

  _renderList() {
    const n = this.list.length;
    this.listEl.innerHTML = n ? this.list.map((m, i) => `<li data-i="${i}"><span class="n">${i + 1}</span><b>${this.fmt(dist(m.a, m.b))}</b>${m.axis ? `<i>${m.axis}</i>` : ''}<button data-del="${i}" aria-label="×">×</button></li>`).join('')
      : `<li class="empty">${this.T.measureEmpty}</li>`;
    document.getElementById('mpClear').disabled = !n;
    const c = this.btn.querySelector('.count');
    c.textContent = n; c.classList.toggle('hidden', !n);
  }

  setOn(v) {
    this.on = v;
    this.first = null; this.hover = null;
    this.panel.classList.toggle('hidden', !v);
    this.btn.classList.toggle('on', v);
    this.cross.classList.add('hidden');
    document.body.classList.toggle('measuring', v);
    if (v) this._ensureGrid();
  }

  // ------------------------------------------------------------ picking
  _ensureGrid() {
    const res = this.splat.gsplat?.asset && this.app.assets.get(this.splat.gsplat.asset)?.resource;
    const centres = res?.centers;
    if (!centres?.length || this.gridRes === res) return;
    this.gridRes = res;
    this.grid = new CentreGrid(centres);
  }

  ray(x, y) {
    const cam = this.camera;
    const o = cam.getPosition(), f = cam.camera.screenToWorld(x, y, 10);
    const d = [f.x - o.x, f.y - o.y, f.z - o.z], l = Math.hypot(...d);
    return { o: [o.x, o.y, o.z], d: d.map((v) => v / l) };
  }

  // the surface point under a screen position (CSS pixels on the canvas)
  pickAt(x, y) {
    const { o, d } = this.ray(x, y);
    const coll = this.cast(o, d);
    const tColl = coll ? Math.hypot(coll.p[0] - o[0], coll.p[1] - o[1], coll.p[2] - o[2]) : null;
    this._ensureGrid();
    let t = null;
    if (this.grid) {
      const pc = this.pc, inv = new pc.Mat4().copy(this.splat.getWorldTransform()).invert();
      const ol = inv.transformPoint(new pc.Vec3(...o)), dl = inv.transformVector(new pc.Vec3(...d)).normalize();
      t = this.grid.hit([ol.x, ol.y, ol.z], [dl.x, dl.y, dl.z], 0.15, (tColl ?? 12) + 0.35);
    }
    if (t === null) t = tColl;
    if (t === null) return null;
    return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  }

  // lock the second point to the nearest of: vertical, along the walls one way, the other way
  _lock(a, p) {
    const v = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let best = null;
    for (const ax of this.axes) {
      const k = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
      if (!best || Math.abs(k) > Math.abs(best.k)) best = { ax, k };
    }
    return { p: [a[0] + best.ax[0] * best.k, a[1] + best.ax[1] * best.k, a[2] + best.ax[2] * best.k], axis: best.ax[3] };
  }

  _snapToEnds(x, y) {
    let best = null;
    for (const m of this.list) for (const p of [m.a, m.b]) {
      const s = this.toScreen(p);
      if (!s) continue;
      const dd = Math.hypot(s[0] - x, s[1] - y);
      if (dd < 12 && (!best || dd < best.dd)) best = { p, dd };
    }
    return best?.p || null;
  }

  move(x, y, shift) {
    if (!this.on) return;
    const snap = this._snapToEnds(x, y);
    let p = snap || this.pickAt(x, y), axis = null;
    if (p && this.first && shift) ({ p, axis } = this._lock(this.first, p));
    this.hover = { p, x, y, snapped: !!snap, axis };
    this.cross.classList.remove('hidden');
    this.cross.classList.toggle('miss', !p);
    this.cross.classList.toggle('snap', !!snap);
    const s = p && axis ? this.toScreen(p) : null;
    this.cross.style.transform = `translate(${s ? s[0] : x}px, ${s ? s[1] : y}px)`;
  }

  click(x, y, shift) {
    if (!this.on) return;
    this.move(x, y, shift);
    const h = this.hover;
    if (!h?.p) return;
    if (!this.first) { this.first = h.p; return; }
    if (dist(this.first, h.p) < 0.005) return;
    this.list.push({ a: this.first, b: h.p, axis: h.axis });
    this.first = null;
    this._renderList();
  }

  cancel() { if (this.first) { this.first = null; return true; } return false; }
  undo() { if (this.first) this.first = null; else this.list.pop(); this._renderList(); }

  // ------------------------------------------------------------ drawing (2D overlay)
  toScreen(p) {
    const m = this._vp; if (!m) return null;
    const d = m.data;
    const x = d[0] * p[0] + d[4] * p[1] + d[8] * p[2] + d[12], y = d[1] * p[0] + d[5] * p[1] + d[9] * p[2] + d[13];
    const w = d[3] * p[0] + d[7] * p[1] + d[11] * p[2] + d[15];
    if (w < 0.05) return null;
    return [(x / w * 0.5 + 0.5) * this.W, (0.5 - y / w * 0.5) * this.H];
  }

  // a 3D segment as screen points, cut where it passes behind the camera
  _seg(a, b) {
    const d = this._vp.data;
    const clip = (p) => [d[0] * p[0] + d[4] * p[1] + d[8] * p[2] + d[12], d[1] * p[0] + d[5] * p[1] + d[9] * p[2] + d[13],
      d[3] * p[0] + d[7] * p[1] + d[11] * p[2] + d[15]];
    let A = clip(a), B = clip(b);
    const n = 0.05;
    if (A[2] < n && B[2] < n) return null;
    const cut = (P, Q) => { const t = (n - P[2]) / (Q[2] - P[2]); return [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t, n]; };
    if (A[2] < n) A = cut(A, B); else if (B[2] < n) B = cut(B, A);
    const s = (P) => [(P[0] / P[2] * 0.5 + 0.5) * this.W, (0.5 - P[1] / P[2] * 0.5) * this.H];
    return [s(A), s(B)];
  }

  _visible(p, eye) {
    const k = p.join();
    const now = performance.now();
    const v = this.vis.get(k);
    if (v && now - v.t < 200) return v.ok;
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]], L = Math.hypot(...d);
    const hit = L > 0.01 ? this.cast(eye, d.map((x) => x / L)) : null;
    const ok = !hit || Math.hypot(hit.p[0] - eye[0], hit.p[1] - eye[1], hit.p[2] - eye[2]) > L - 0.25;
    this.vis.set(k, { ok, t: now });
    return ok;
  }

  frame() {
    const c = this.layer, dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.list.length && !this.first) return;
    const cam = this.camera.camera;
    this._vp = (this._vp || new this.pc.Mat4()).mul2(cam.projectionMatrix, cam.viewMatrix);
    this.W = W; this.H = H;
    const e = this.camera.getPosition(), eye = [e.x, e.y, e.z];
    const labels = [];
    this.list.forEach((m, i) => {
      const seen = this._visible(m.a, eye) || this._visible(m.b, eye);
      const near = Math.hypot(m.a[0] - eye[0], m.a[2] - eye[2]) < 25;
      if (!near) return;
      this._line(m.a, m.b, { alpha: seen ? 1 : 0.28, strong: i === this.hl });
      if (seen) labels.push({ m, i });
    });
    if (this.first) {
      const to = this.hover?.p;
      this._dot(this.first, 1);
      if (to) this._line(this.first, to, { alpha: 1, dashed: true });
    }
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const { m, i } of labels) this._label(m.a, m.b, `${this.fmt(dist(m.a, m.b))}${m.axis ? ' ' + m.axis : ''}`, i === this.hl);
    if (this.first && this.hover?.p) this._label(this.first, this.hover.p, `${this.fmt(dist(this.first, this.hover.p))}${this.hover.axis ? ' ' + this.hover.axis : ''}`, true);
  }

  _line(a, b, { alpha = 1, dashed = false, strong = false }) {
    const s = this._seg(a, b);
    if (!s) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(13,13,14,.55)'; ctx.lineWidth = strong ? 6 : 4.5;
    ctx.beginPath(); ctx.moveTo(...s[0]); ctx.lineTo(...s[1]); ctx.stroke();
    ctx.strokeStyle = ACCENT; ctx.lineWidth = strong ? 3 : 2;
    if (dashed) ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.moveTo(...s[0]); ctx.lineTo(...s[1]); ctx.stroke();
    ctx.restore();
    this._dot(a, alpha); this._dot(b, alpha);
  }

  _dot(p, alpha) {
    const s = this.toScreen(p);
    if (!s) return;
    const ctx = this.ctx;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(s[0], s[1], 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(13,13,14,.85)'; ctx.stroke();
    ctx.restore();
  }

  _label(a, b, text, strong) {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const s = this.toScreen(mid);
    if (!s) return;
    const ctx = this.ctx;
    const w = ctx.measureText(text).width + 18;
    ctx.fillStyle = strong ? ACCENT : 'rgba(18,18,20,.86)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(s[0] - w / 2, s[1] - 12, w, 24, 12) : ctx.rect(s[0] - w / 2, s[1] - 12, w, 24);
    ctx.fill();
    ctx.fillStyle = strong ? '#141414' : '#f4f1ec';
    ctx.fillText(text, s[0], s[1] + 0.5);
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
