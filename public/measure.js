// intus measuring tool: freeze the view, click two points on any surface, read the distance.
// Points land on the real surface under the pointer (see CentreGrid.hit for how, and why that isn't
// simply "what you see"). Measurements stay in the scene for the whole visit.

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

  // centres within radius r(t) of the ray o + t d (unit d), as [t, x, y, z, index] rows sorted by t
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
          if (vx * vx + vy * vy + vz * vz - tt * tt < r * r) out.push([tt, x, y, z, i]);
        }
      }
    }
    return out.sort((p, q) => p[0] - q[0]);
  }

  // centres within r of point p, as [t(along d from o), x, y, z, index] rows
  _ball(p, r, o, d) {
    const C = this.centres, out = [], reach = Math.ceil(r / this.cell);
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) for (let c = -reach; c <= reach; c++) {
      const id = this._cell(p[0] + a * this.cell, p[1] + b * this.cell, p[2] + c * this.cell);
      if (id < 0) continue;
      for (let s = this.start[id], e = this.start[id + 1]; s < e; s++) {
        const i = this.items[s], x = C[i * 3], y = C[i * 3 + 1], z = C[i * 3 + 2];
        if ((x - p[0]) ** 2 + (y - p[1]) ** 2 + (z - p[2]) ** 2 > r * r) continue;
        out.push([(x - o[0]) * d[0] + (y - o[1]) * d[1] + (z - o[2]) * d[2], x, y, z, i]);
      }
    }
    return out;
  }

  // The surface under a ray: { t, n } or null.
  //
  // What you see in a splat is not always where the surface is: glossy tiles, polished floors and
  // glass are drawn by Gaussians that sit behind the real surface, like a reflection. So the
  // visible colour can't be trusted for depth. Instead this looks for the first place along the
  // ray where the Gaussians form a real surface (enough opacity in a thin layer, lying in a plane),
  // and never goes past the walls and floors of the collision model (which is built from solid
  // splats only). With no such layer it falls back to the collision surface, refined by a plane fit.
  hit(o, d, tMin, tColl, nColl, op) {
    const wt = (i) => (op ? op[i] : 0.3);
    const far = tColl != null ? tColl + 0.25 : 12;
    const WIN = 0.08;
    // a thin cone first; then a wider one, where only a clear plane counts (sparse, glossy surfaces)
    for (const [R0, RK, W0, needPlane] of [[0.06, 0.01, 0.5, false], [0.13, 0.02, 0.8, true]]) {
      const rows = this._near(o, d, tMin, far, R0, RK);
      const W = rows.map((r) => wt(r[4]));
      let jEnd = 0, acc = 0;
      for (let i = 0; i < rows.length; i++) {
        if (jEnd < i) { jEnd = i; acc = 0; }
        while (jEnd < rows.length && rows[jEnd][0] - rows[i][0] < WIN) acc += W[jEnd++];
        const ww = acc;
        acc -= W[i];
        if (ww < W0) continue;
        const win = rows.slice(i, jEnd), ws = W.slice(i, jEnd);
        let sw = 0, st = 0;
        win.forEach((r, k) => { sw += ws[k]; st += r[0] * ws[k]; });
        const tm = st / sw;
        const plane = win.length >= 5 ? fitPlane(win, ws) : null;
        if (!plane && (needPlane || ww < 2)) continue;     // a few loose specks: haze, not a surface
        if (plane) {
          const tp = rayPlane(plane, o, d);
          if (tp !== null && Math.abs(tp - tm) < 0.1) return { t: tp, n: plane[0] };
          if (needPlane) continue;
        }
        return { t: tm, n: null };
      }
    }
    if (tColl == null) return null;
    // something solid is there (the collision model says so): take the densest splat layer around it
    {
      const rows = this._near(o, d, Math.max(tMin, tColl - 0.15), tColl + 0.25, 0.13, 0.02);
      const W = rows.map((r) => wt(r[4]));
      let best = null, jEnd = 0, acc = 0;
      for (let i = 0; i < rows.length; i++) {
        if (jEnd < i) { jEnd = i; acc = 0; }
        while (jEnd < rows.length && rows[jEnd][0] - rows[i][0] < WIN) acc += W[jEnd++];
        if (!best || acc > best.w) best = { w: acc, i, j: jEnd };
        acc -= W[i];
      }
      if (best && best.w >= 0.3) {
        let sw = 0, st = 0;
        for (let k = best.i; k < best.j; k++) { sw += W[k]; st += rows[k][0] * W[k]; }
        const win = rows.slice(best.i, best.j), plane = win.length >= 5 ? fitPlane(win, W.slice(best.i, best.j)) : null;
        const tp = plane ? rayPlane(plane, o, d) : null;
        if (tp !== null && Math.abs(tp - st / sw) < 0.08) return { t: tp, n: plane[0] };
        return { t: st / sw, n: nColl };
      }
    }
    // the collision surface (5 cm voxels), refined by a plane through the splats around it
    const p = [o[0] + d[0] * tColl, o[1] + d[1] * tColl, o[2] + d[2] * tColl];
    const near = this._ball(p, 0.2, o, d);
    const plane = near.length >= 6 ? fitPlane(near, near.map((r) => wt(r[4]))) : null;
    if (plane) {
      const tp = rayPlane(plane, o, d);
      if (tp !== null && Math.abs(tp - tColl) < 0.08) return { t: tp, n: plane[0] };
    }
    return { t: tColl, n: nColl };
  }
}

function rayPlane([n, c], o, d) {
  const den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
  if (Math.abs(den) < 0.2) return null;       // grazing: not reliable
  return ((c[0] - o[0]) * n[0] + (c[1] - o[1]) * n[1] + (c[2] - o[2]) * n[2]) / den;
}
// weighted least-squares plane through [t,x,y,z,...] rows, one round of outlier removal
function fitPlane(rows, ws) {
  let pts = rows.map((r, k) => [r[1], r[2], r[3], ws[k]]), plane = null;
  for (let pass = 0; pass < 2; pass++) {
    if (pts.length < 5) return plane;
    const fit = fitOnce(pts);
    if (!fit) return plane;
    plane = fit;
    const [n, c] = fit;
    pts = pts.filter((p) => Math.abs((p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]) < 0.025);
  }
  return plane;
}
function fitOnce(pts) {
  let sw = 0; const c = [0, 0, 0];
  for (const p of pts) { sw += p[3]; c[0] += p[0] * p[3]; c[1] += p[1] * p[3]; c[2] += p[2] * p[3]; }
  if (sw <= 0) return null;
  c[0] /= sw; c[1] /= sw; c[2] /= sw;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a][b] += p[3] * q[a] * q[b] / sw;
  }
  // Jacobi eigen-decomposition of the 3x3 covariance; the normal is the smallest eigenvector
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-14) continue;
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
  const sorted = [...ev].sort((x, y) => x - y);
  // a plane needs spread in two directions and little thickness
  if (sorted[1] < 4 * sorted[0] || sorted[1] < 0.0004) return null;
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
    this.btn = $('toolMeasure'); this.panel = $('measureSec'); this.listEl = $('mpList'); this.countEl = $('drawerCount');
    this.btn.innerHTML = `<span class="ti">${RULER}</span><span class="tl"><b>${T.measure}</b>${T.measureKeyShort ? `<small>${T.measureKeyShort}</small>` : ''}</span>`;
    this.btn.title = T.measureKey;
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
    this.countEl.textContent = n; this.countEl.classList.toggle('hidden', !n);
  }

  setOn(v) {
    this.on = v;
    this.first = null; this.hover = null;
    this.panel.classList.toggle('hidden', !v);
    this.btn.classList.toggle('on', v);
    this.btn.setAttribute('aria-pressed', String(v));
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
    this.op = null;
    // each Gaussian's opacity (to tell surfaces from haze) is read back from the GPU once, in the background
    const gd = res.gsplatData;
    if (gd?.decompress) {
      const sb = gd.shBands;
      gd.shBands = 0;            // colours beyond the base aren't needed here
      const job = gd.decompress();
      gd.shBands = sb;
      job.then((data) => {
        if (this.gridRes !== res) return;
        const O = data.getProp('opacity'), op = new Float32Array(O.length);
        for (let i = 0; i < O.length; i++) op[i] = 1 / (1 + Math.exp(-O[i]));
        this.op = op;
      }).catch((e) => console.warn('measure: splat data unavailable', e));
    }
  }

  ray(x, y) {
    const cam = this.camera;
    const o = cam.getPosition(), f = cam.camera.screenToWorld(x, y, 10);
    const d = [f.x - o.x, f.y - o.y, f.z - o.z], l = Math.hypot(...d);
    return { o: [o.x, o.y, o.z], d: d.map((v) => v / l) };
  }

  // the surface under a screen position (CSS pixels on the canvas): { p, n } in world space, or null
  pickAt(x, y) {
    const { o, d } = this.ray(x, y);
    const coll = this.cast(o, d);
    const tColl = coll ? Math.hypot(coll.p[0] - o[0], coll.p[1] - o[1], coll.p[2] - o[2]) : null;
    this._ensureGrid();
    let h = null;
    if (this.grid) {
      const pc = this.pc, M = this.splat.getWorldTransform(), inv = new pc.Mat4().copy(M).invert();
      const ol = inv.transformPoint(new pc.Vec3(...o)), dl = inv.transformVector(new pc.Vec3(...d)).normalize();
      const nl = coll ? inv.transformVector(new pc.Vec3(...coll.n)) : null;
      h = this.grid.hit([ol.x, ol.y, ol.z], [dl.x, dl.y, dl.z], 0.12, tColl, nl && [nl.x, nl.y, nl.z], this.op);
      if (h?.n) { const nw = M.transformVector(new pc.Vec3(...h.n)).normalize(); h.n = [nw.x, nw.y, nw.z]; }
    } else if (coll) h = { t: tColl, n: coll.n };
    if (!h) return null;
    let n = h.n;
    if (n && n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0) n = n.map((v) => -v);   // facing the viewer
    return { p: [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t], n };
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
    const hit = snap ? { p: snap, n: null } : this.pickAt(x, y);
    let p = hit?.p || null, axis = null;
    if (p && this.first && shift) ({ p, axis } = this._lock(this.first, p));
    this.hover = { p, n: axis ? null : hit?.n, x, y, snapped: !!snap, axis };
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
    if (!this.list.length && !this.first && !(this.on && this.hover?.p)) return;
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
    // where the pointer lands: a small ring lying on the surface, so you can see it's on it
    if (this.on && this.hover?.p && this.hover.n) this._ring(this.hover.p, this.hover.n);
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

  _ring(p, n) {
    const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(n, a)), v = cross(n, u), R = 0.07, pts = [];
    for (let k = 0; k <= 32; k++) {
      const t = (k / 32) * Math.PI * 2, c = Math.cos(t) * R, s = Math.sin(t) * R;
      const q = this.toScreen([p[0] + u[0] * c + v[0] * s, p[1] + u[1] * c + v[1] * s, p[2] + u[2] * c + v[2] * s]);
      if (!q) return;
      pts.push(q);
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(...q) : ctx.moveTo(...q)));
    ctx.fillStyle = 'rgba(232,220,199,.22)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(13,13,14,.45)'; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = ACCENT; ctx.stroke();
    ctx.restore();
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
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
