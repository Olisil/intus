// intus floor map: a small 3D wireframe of the house drawn on a 2D canvas.
// Rooms are unions of rectangles in the plan frame (see rooms.py):
//   u = cos(a) x - sin(a) z,  v = sin(a) x + cos(a) z
// Used by the viewer (large on the start/pause screen, small while walking) and by the studio.

export const toPlan = (a, x, z) => [Math.cos(a) * x - Math.sin(a) * z, Math.sin(a) * x + Math.cos(a) * z];
export const fromPlan = (a, u, v) => [Math.cos(a) * u + Math.sin(a) * v, -Math.sin(a) * u + Math.cos(a) * v];

// Outline loops of a union of axis-aligned rectangles [u0, v0, u1, v1] (exact, via coordinate compression).
export function unionOutline(rects) {
  rects = rects.filter((r) => r[2] > r[0] && r[3] > r[1]);
  if (!rects.length) return [];
  const us = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  const vs = [...new Set(rects.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
  const W = us.length - 1, H = vs.length - 1;
  const inside = (i, j) => {
    if (i < 0 || j < 0 || i >= W || j >= H) return false;
    const cu = (us[i] + us[i + 1]) / 2, cv = (vs[j] + vs[j + 1]) / 2;
    return rects.some((r) => cu > r[0] && cu < r[2] && cv > r[1] && cv < r[3]);
  };
  const cell = [];
  for (let i = 0; i < W; i++) { cell.push([]); for (let j = 0; j < H; j++) cell[i].push(inside(i, j)); }
  const isIn = (i, j) => i >= 0 && j >= 0 && i < W && j < H && cell[i][j];
  const edges = new Map(); // "i,j" start corner -> list of end corners
  const add = (a, b) => { const k = a.join(); if (!edges.has(k)) edges.set(k, []); edges.get(k).push(b); };
  for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
    if (!cell[i][j]) continue;
    if (!isIn(i, j - 1)) add([i, j], [i + 1, j]);
    if (!isIn(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
    if (!isIn(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
    if (!isIn(i - 1, j)) add([i, j + 1], [i, j]);
  }
  const loops = [];
  while (edges.size) {
    const [k0] = edges.keys();
    let cur = k0.split(',').map(Number);
    const loop = [];
    for (let guard = 0; guard < 100000; guard++) {
      const k = cur.join(), outs = edges.get(k);
      if (!outs) break;
      const nxt = outs.pop();
      if (!outs.length) edges.delete(k);
      loop.push(cur);
      cur = nxt;
      if (cur.join() === k0 && !edges.has(k0)) break;
    }
    // drop points in the middle of straight runs
    const pts = loop.map(([i, j]) => [us[i], vs[j]]);
    const out = pts.filter((p, n) => {
      const a = pts[(n - 1 + pts.length) % pts.length], b = pts[(n + 1) % pts.length];
      return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
    });
    if (out.length >= 3) loops.push(out);
  }
  return loops;
}

const pointInLoops = (loops, x, y) => {
  let c = false;
  for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const [xi, yi] = l[i], [xj, yj] = l[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

export class TourMap {
  constructor(canvas, map, { baseUrl = '', onPick = null, imageUrl = null } = {}) {
    this.imageUrl = imageUrl;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick;
    this.images = [];
    this.mode = 'small';
    this.hover = null;
    this.current = null;
    this.feet = null; this.yaw = 0;
    this.spin = 0; this.drag = null; this.userTurn = 0; this.lastInteract = 0;
    this.accent = '#e8dcc7';
    this.setMap(map, baseUrl);
    this._bind();
  }

  setMap(map, baseUrl = '') {
    this.map = map;
    const a = map.angle || 0;
    this.levels = map.levels || [];
    this.rooms = (map.rooms || []).filter((r) => !r.hidden).map((r) => {
      const loops = unionOutline(r.rects || []);
      const level = this.levels[r.level] || { y: 0, height: 2.5 };
      const top = r.kind === 'stairs' && this.levels[r.top] ? this.levels[r.top].y + this.levels[r.top].height : level.y + level.height;
      // label at the centre of the biggest rectangle
      const big = [...(r.rects || [])].sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]))[0] || [0, 0, 0, 0];
      return { ...r, loops, y0: level.y, y1: top, label: [(big[0] + big[2]) / 2, (big[1] + big[3]) / 2] };
    });
    // extent of the house in the plan frame, for fitting
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const r of this.rooms) for (const q of r.rects) { u0 = Math.min(u0, q[0]); v0 = Math.min(v0, q[1]); u1 = Math.max(u1, q[2]); v1 = Math.max(v1, q[3]); }
    if (!isFinite(u0)) for (const l of this.levels) { [u0, v0, u1, v1] = l.bounds; }
    this.ext = [u0, v0, u1, v1];
    const prev = this.images || [];
    this.images = this.levels.map((l, i) => {
      if (!l.image) return null;
      if (prev[i] && prev[i]._file === l.image) return prev[i];
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img._file = l.image;
      img.onload = () => { this.dirty = true; };
      img.src = this.imageUrl ? this.imageUrl(l.image) : baseUrl ? new URL(l.image, baseUrl).href : l.image;
      return img;
    });
    this.dirty = true;
  }

  // which room is a position in (feet in tour space)?
  roomAt(x, y, z) {
    const a = this.map.angle || 0;
    const [u, v] = toPlan(a, x, z);
    const lv = this.levels;
    let li = 0;
    for (let i = 0; i < lv.length; i++) if (y >= lv[i].y - 0.3) li = i;
    const onFloor = lv.length ? Math.abs(y - lv[li].y) < 0.2 : true;
    const inRoom = (r) => r.rects.some((q) => u >= q[0] && u <= q[2] && v >= q[1] && v <= q[3]);
    if (!onFloor) {
      const s = this.rooms.find((r) => r.kind === 'stairs' && y > r.y0 - 0.1 && y < r.y1 && inRoom(r));
      if (s) return s.id;
    }
    const r = this.rooms.find((r) => r.kind !== 'stairs' && r.level === li && inRoom(r))
      || this.rooms.find((r) => r.kind === 'stairs' && r.level === li && inRoom(r));
    return r ? r.id : null;
  }

  room(id) { return this.rooms.find((r) => r.id === id) || null; }

  // ------------------------------------------------------------ view
  _view(w, h, only = null) {
    const large = this.mode === 'large';
    const a = this.map.angle || 0;
    // look at the house square-on to its walls, turned a little so it reads as 3D
    const auto = large ? Math.sin(this.spin * 0.25) * 0.35 : 0;
    const phi = -a + 0.5 + auto + this.userTurn;
    const elev = large ? 0.5 : 0.85;      // radians above the horizon
    const gap = large ? 3.2 : 0;          // extra space between storeys (exploded view)
    const shown = only === null ? this.levels.map((_, i) => i) : [only];
    let [u0, v0, u1, v1] = this.ext;
    if (only !== null) {  // fit the storey you're on
      const rs = this.rooms.filter((r) => r.level === only);
      if (rs.length) {
        u0 = Math.min(...rs.flatMap((r) => r.rects.map((q) => q[0]))); v0 = Math.min(...rs.flatMap((r) => r.rects.map((q) => q[1])));
        u1 = Math.max(...rs.flatMap((r) => r.rects.map((q) => q[2]))); v1 = Math.max(...rs.flatMap((r) => r.rects.map((q) => q[3])));
      }
    }
    const [cx, cz] = fromPlan(a, (u0 + u1) / 2, (v0 + v1) / 2);
    const ys = shown.map((i) => this.levels[i].y + i * gap);
    const yMid = ys.length ? (Math.min(...ys) + Math.max(...ys) + (this.levels[shown.at(-1)]?.height || 2.5)) / 2 : 1.2;
    const cp = Math.cos(phi), sp = Math.sin(phi), se = Math.sin(elev), ce = Math.cos(elev);
    const proj = (x, y, z, li = 0) => {
      const dx = x - cx, dz = z - cz, dy = y + (li || 0) * gap - yMid;
      const rx = dx * cp - dz * sp, rz = dx * sp + dz * cp;
      return [rx, rz * se - dy * ce];
    };
    // fit: project the corners of the house at all heights
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    this.levels.forEach((l, li) => {
      if (!shown.includes(li)) return;
      for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
        const [x, z] = fromPlan(a, u, v);
        for (const y of [l.y, l.y + l.height]) {
          const [px, py] = proj(x, y, z, li);
          x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        }
      }
    });
    const pad = large ? 0.1 : 0.08;
    const s = Math.min(w * (1 - 2 * pad) / (x1 - x0 || 1), h * (1 - 2 * pad) / (y1 - y0 || 1));
    const ox = w / 2 - s * (x0 + x1) / 2, oy = h / 2 - s * (y0 + y1) / 2;
    return {
      a, gap, s, phi, se, ce,
      P: (x, y, z, li) => { const [px, py] = proj(x, y, z, li); return [ox + s * px, oy + s * py]; },
      // the plan -> screen mapping of a storey's floor is affine (orthographic view)
      floorTransform: (li) => {
        const l = this.levels[li];
        const o = this._plan2screen(a, l.bounds[0], l.bounds[1], l.y, li, proj, ox, oy, s);
        const ou = this._plan2screen(a, l.bounds[0] + 1, l.bounds[1], l.y, li, proj, ox, oy, s);
        const ov = this._plan2screen(a, l.bounds[0], l.bounds[1] + 1, l.y, li, proj, ox, oy, s);
        return [ou[0] - o[0], ou[1] - o[1], ov[0] - o[0], ov[1] - o[1], o[0], o[1]];
      },
    };
  }

  _plan2screen(a, u, v, y, li, proj, ox, oy, s) {
    const [x, z] = fromPlan(a, u, v);
    const [px, py] = proj(x, y, z, li);
    return [ox + s * px, oy + s * py];
  }

  // ------------------------------------------------------------ drawing
  draw(dt = 0) {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    if (this.mode === 'large' && performance.now() - this.lastInteract > 2500 && !this.drag) this.spin += dt;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.levels.length) return;
    const large = this.mode === 'large';
    const curRoom = this.room(this.current);
    const curLevel = this.feet && !(curRoom?.kind === 'stairs') ? this._levelOf(this.feet[1]) : (curRoom ? curRoom.level : 0);
    const V = this._view(w, h, large ? null : curLevel);
    this.V = V;
    const a = V.a;
    this.screenRooms = [];
    this.levels.forEach((l, li) => {
      if (!large && li !== curLevel) return;
      const fade = 1;
      // floor picture
      const img = this.images[li];
      if (img && img.complete && img.naturalWidth) {
        const [b0, b1, b2, b3] = l.bounds;
        const m = V.floorTransform(li);
        ctx.save();
        ctx.globalAlpha = (large ? 0.85 : 0.55) * fade;
        ctx.setTransform(dpr * m[0] * (b2 - b0) / img.naturalWidth, dpr * m[1] * (b2 - b0) / img.naturalWidth,
          dpr * m[2] * (b3 - b1) / img.naturalHeight, dpr * m[3] * (b3 - b1) / img.naturalHeight, dpr * m[4], dpr * m[5]);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
      }
      for (const r of this.rooms) {
        if (r.level !== li) continue;
        const isCur = r.id === this.current, isHover = r.id === this.hover;
        const floorPts = r.loops.map((loop) => loop.map(([u, v]) => { const [x, z] = fromPlan(a, u, v); return V.P(x, r.y0, z, li); }));
        const stairs = r.kind === 'stairs' && this.levels[r.top];
        const ceilY = stairs ? this.levels[r.top].y : r.y1;   // a staircase box reaches the floor above
        const topLi = stairs ? r.top : li;
        const ceilPts = r.loops.map((loop) => loop.map(([u, v]) => { const [x, z] = fromPlan(a, u, v); return V.P(x, ceilY, z, topLi); }));
        this.screenRooms.push({ id: r.id, loops: floorPts, level: li });
        // fill
        if (isCur || isHover) {
          ctx.beginPath();
          for (const loop of floorPts) loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.fillStyle = isCur ? `rgba(232,220,199,${large ? 0.3 : 0.42})` : 'rgba(232,220,199,0.16)';
          ctx.fill('evenodd');
        }
        const strong = isCur || isHover;
        ctx.lineJoin = 'round';
        // vertical edges and ceiling: the "wire" of the house
        ctx.strokeStyle = `rgba(244,241,236,${(strong ? 0.75 : large ? 0.32 : 0.22) * fade})`;
        ctx.lineWidth = strong ? 1.2 : 0.8;
        ctx.beginPath();
        floorPts.forEach((loop, k) => loop.forEach(([x, y], i) => { ctx.moveTo(x, y); ctx.lineTo(...ceilPts[k][i]); }));
        for (const loop of ceilPts) { loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
        ctx.stroke();
        // floor outline
        ctx.strokeStyle = strong ? this.accent : `rgba(244,241,236,${0.7 * fade})`;
        ctx.lineWidth = strong ? 2 : 1.1;
        ctx.beginPath();
        for (const loop of floorPts) { loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
        ctx.stroke();
      }
      // you are here
      if (this.feet && li === curLevel) this._drawMe(V, li);
    });
    if (large) this._drawLabels(V);
  }

  _levelOf(y) {
    let li = 0;
    this.levels.forEach((l, i) => { if (y >= l.y - 0.3) li = i; });
    return li;
  }

  _drawMe(V, li) {
    const ctx = this.ctx;
    const [x, y, z] = this.feet;
    const [px, py] = V.P(x, y, z, li);
    const yr = (this.yaw * Math.PI) / 180;
    const fx = -Math.sin(yr), fz = -Math.cos(yr);
    const L = 1.6, spread = 0.5;
    const tip = (ang) => {
      const c = Math.cos(ang), s = Math.sin(ang);
      return V.P(x + (fx * c - fz * s) * L, y, z + (fx * s + fz * c) * L, li);
    };
    const g = ctx.createRadialGradient(px, py, 0, px, py, V.s * L);
    g.addColorStop(0, 'rgba(232,220,199,0.55)');
    g.addColorStop(1, 'rgba(232,220,199,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let t = -spread; t <= spread + 1e-6; t += spread / 6) ctx.lineTo(...tip(t));
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, this.mode === 'large' ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(13,13,14,0.85)';
    ctx.stroke();
  }

  _drawLabels(V) {
    const ctx = this.ctx;
    const a = V.a;
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const r of this.rooms) {
      const [x, z] = fromPlan(a, r.label[0], r.label[1]);
      const [px, py] = V.P(x, r.y0 + 0.05, z, r.level);
      const text = r.name || '';
      const w = ctx.measureText(text).width + 16;
      const box = [px - w / 2, py - 11, w, 22];
      if (placed.some((b) => !(box[0] > b[0] + b[2] || box[0] + box[2] < b[0] || box[1] > b[1] + b[3] || box[1] + box[3] < b[1]))) continue;
      placed.push(box);
      const on = r.id === this.hover || r.id === this.current;
      ctx.fillStyle = on ? 'rgba(232,220,199,0.95)' : 'rgba(18,18,20,0.78)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(...box, 11) : ctx.rect(...box);
      ctx.fill();
      ctx.fillStyle = on ? '#141414' : 'rgba(244,241,236,0.92)';
      ctx.fillText(text, px, py + 0.5);
    }
  }

  // ------------------------------------------------------------ interaction (large mode)
  pick(x, y) {
    const hits = (this.screenRooms || []).filter((r) => pointInLoops(r.loops, x, y));
    hits.sort((p, q) => q.level - p.level);  // upper storeys are drawn on top
    return hits[0]?.id || null;
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointermove', (e) => {
      if (this.mode !== 'large') return;
      this.lastInteract = performance.now();
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        if (Math.abs(dx) > 3) this.drag.moved = true;
        this.userTurn = this.drag.turn + dx * 0.006;
        return;
      }
      const id = this.pick(...pos(e));
      if (id !== this.hover) { this.hover = id; c.style.cursor = id ? 'pointer' : 'grab'; }
    });
    c.addEventListener('pointerleave', () => { this.hover = null; });
    c.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'large') return;
      this.drag = { x: e.clientX, turn: this.userTurn, moved: false };
      c.setPointerCapture?.(e.pointerId);
    });
    c.addEventListener('pointerup', (e) => {
      if (this.mode !== 'large') { this.onPick?.(null, 'small'); return; }
      const d = this.drag; this.drag = null;
      if (d && d.moved) return;
      const id = this.pick(...pos(e));
      if (id) this.onPick?.(id, 'large');
    });
  }
}
