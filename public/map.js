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

// Close the gaps the room detection leaves between rooms (it stops short of the walls): every
// rectangle edge that faces another room within `reach` moves halfway towards it, leaving `wall`
// between them (rectangles of the same room meet exactly). Idempotent; stairs are left alone.
export function tightenRooms(rooms, wall = 0.12, reach = 0.7) {
  const out = rooms.map((r) => ({ ...r, rects: (r.rects || []).map((q) => [...q]) }));
  const items = [];
  out.forEach((r) => { if (r.kind !== 'stairs') r.rects.forEach((q, k) => items.push({ r, q, o: [...rooms[out.indexOf(r)].rects[k]] })); });
  const EDGES = [  // [edge index, facing edge index on the other rect, sign, span axes]
    [2, 0, 1, 1, 3], [0, 2, -1, 1, 3], [3, 1, 1, 0, 2], [1, 3, -1, 0, 2],
  ];
  for (const A of items) {
    for (const [e, f, sgn, s0, s1] of EDGES) {
      let best = null;
      for (const B of items) {
        if (B === A || B.r.level !== A.r.level) continue;
        const g = sgn * (B.o[f] - A.o[e]);
        const overlap = Math.min(A.o[s1], B.o[s1]) - Math.max(A.o[s0], B.o[s0]);
        if (overlap < 0.25 || g < -1e-6 || g > reach) continue;
        const w = B.r === A.r ? 0 : wall;
        if (!best || g < best.g) best = { g, w };
      }
      if (best && best.g > best.w + 1e-4) A.q[e] = +(A.o[e] + sgn * (best.g - best.w) / 2).toFixed(3);
    }
  }
  return out;
}

export class TourMap {
  constructor(canvas, map, { onPick = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick;
    this.mode = 'small';
    this.only = null;          // storey to show: null = automatic (large: all, small: the one you're on)
    this.hover = null;
    this.current = null;
    this.feet = null; this.yaw = 0;
    this.spin = 0; this.drag = null; this.userTurn = 0; this.lastInteract = 0;
    this.accent = '#e8dcc7';
    this.setMap(map);
    this._bind();
  }

  setMap(map) {
    this.map = map;
    this.levels = map.levels || [];
    const rooms = tightenRooms((map.rooms || []).filter((r) => !r.hidden));
    this.rooms = rooms.map((r) => {
      const loops = unionOutline(r.rects || []);
      const level = this.levels[r.level] || { y: 0, height: 2.5 };
      const top = r.kind === 'stairs' && this.levels[r.top] ? this.levels[r.top].y + this.levels[r.top].height : level.y + level.height;
      // label at the centre of the biggest rectangle
      const big = [...(r.rects || [])].sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]))[0] || [0, 0, 0, 0];
      return { ...r, loops, y0: level.y, y1: top, label: [(big[0] + big[2]) / 2, (big[1] + big[3]) / 2] };
    });
    this.ext = this._extent(null);
  }

  _extent(level) {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const r of this.rooms) {
      if (level !== null && r.level !== level) continue;
      for (const q of r.rects) { u0 = Math.min(u0, q[0]); v0 = Math.min(v0, q[1]); u1 = Math.max(u1, q[2]); v1 = Math.max(v1, q[3]); }
    }
    if (!isFinite(u0)) return level !== null ? this._extent(null) : (this.levels[0]?.bounds || [-5, -5, 5, 5]);
    return [u0, v0, u1, v1];
  }

  // which room is a position in (feet in tour space)?
  roomAt(x, y, z) {
    const a = this.map.angle || 0;
    const [u, v] = toPlan(a, x, z);
    const li = this.levelAt(y);
    const onFloor = this.levels.length ? Math.abs(y - this.levels[li].y) < 0.2 : true;
    const inRoom = (r) => r.rects.some((q) => u >= q[0] && u <= q[2] && v >= q[1] && v <= q[3]);
    if (!onFloor) {
      const s = this.rooms.find((r) => r.kind === 'stairs' && y > r.y0 - 0.1 && y < r.y1 && inRoom(r));
      if (s) return s.id;
    }
    const r = this.rooms.find((r) => r.kind !== 'stairs' && r.level === li && inRoom(r))
      || this.rooms.find((r) => r.kind === 'stairs' && r.level === li && inRoom(r));
    return r ? r.id : null;
  }

  levelAt(y) {
    let li = 0;
    this.levels.forEach((l, i) => { if (y >= l.y - 0.3) li = i; });
    return li;
  }

  room(id) { return this.rooms.find((r) => r.id === id) || null; }

  // the storey you're on (on stairs: the one the stairs start from)
  get hereLevel() {
    const cur = this.room(this.current);
    if (cur?.kind === 'stairs') return cur.level;
    return this.feet ? this.levelAt(this.feet[1]) : (cur ? cur.level : 0);
  }

  // ------------------------------------------------------------ view
  _view(w, h, shown) {
    const large = this.mode === 'large';
    const a = this.map.angle || 0;
    let phi, elev;
    if (large) {
      // square-on to the walls, turned a little so it reads as 3D; drifts slowly until you touch it
      phi = -a + 0.5 + Math.sin(this.spin * 0.25) * 0.35 + this.userTurn;
      elev = 0.5;
    } else {
      // heading-up: the way you look always points up on the map
      phi = (this.yaw * Math.PI) / 180;
      elev = 0.9;
    }
    const gap = large && shown.length > 1 ? 3.2 : 0;   // extra space between storeys (exploded view)
    const [u0, v0, u1, v1] = shown.length === 1 ? this._extent(shown[0]) : this.ext;
    const [cx, cz] = fromPlan(a, (u0 + u1) / 2, (v0 + v1) / 2);
    const off = (li) => (gap ? li * gap : 0);
    const ys = shown.map((i) => this.levels[i].y + off(i));
    const yMid = (Math.min(...ys) + Math.max(...ys) + (this.levels[shown.at(-1)]?.height || 2.5)) / 2;
    const cp = Math.cos(phi), sp = Math.sin(phi), se = Math.sin(elev), ce = Math.cos(elev);
    const proj = (x, y, z, li = 0) => {
      const dx = x - cx, dz = z - cz, dy = y + off(li) - yMid;
      const rx = dx * cp - dz * sp, rz = dx * sp + dz * cp;
      return [rx, rz * se - dy * ce];
    };
    let x0, y0, x1, y1;
    if (large) {
      x0 = y0 = Infinity; x1 = y1 = -Infinity;
      for (const li of shown) {
        const l = this.levels[li];
        for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
          const [x, z] = fromPlan(a, u, v);
          for (const y of [l.y, l.y + l.height]) {
            const [px, py] = proj(x, y, z, li);
            x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
          }
        }
      }
    } else {
      // fit a circle round the storey, so the scale stays put while the map turns with you
      const r = Math.hypot(u1 - u0, v1 - v0) / 2 + 0.3;
      const hh = (this.levels[shown[0]]?.height || 2.5) * ce / 2;
      x0 = -r; x1 = r; y0 = -r * se - hh; y1 = r * se + hh;
    }
    const pad = large ? 0.1 : 0.06;
    const s = Math.min(w * (1 - 2 * pad) / (x1 - x0 || 1), h * (1 - 2 * pad) / (y1 - y0 || 1));
    const ox = w / 2 - s * (x0 + x1) / 2, oy = h / 2 - s * (y0 + y1) / 2;
    return { a, s, P: (x, y, z, li) => { const [px, py] = proj(x, y, z, li); return [ox + s * px, oy + s * py]; } };
  }

  // ------------------------------------------------------------ drawing
  draw(dt = 0) {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const large = this.mode === 'large';
    if (large && performance.now() - this.lastInteract > 2500 && !this.drag) this.spin += dt;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.levels.length) return;
    const here = this.hereLevel;
    const shown = this.only !== null && this.only !== undefined && this.levels[this.only] ? [this.only]
      : large ? this.levels.map((_, i) => i) : [here];
    this.shown = shown;
    const V = this._view(w, h, shown);
    const a = V.a;
    const k = large ? 1 : 0.85;   // line weight
    this.screenRooms = [];
    for (const li of shown) {
      for (const r of this.rooms) {
        if (r.level !== li) continue;
        const isCur = r.id === this.current, isHover = r.id === this.hover;
        const floorPts = r.loops.map((loop) => loop.map(([u, v]) => { const [x, z] = fromPlan(a, u, v); return V.P(x, r.y0, z, li); }));
        const stairs = r.kind === 'stairs' && this.levels[r.top];
        const ceilY = stairs ? this.levels[r.top].y : r.y1;   // a staircase box reaches the floor above
        const topLi = stairs && shown.includes(r.top) ? r.top : li;
        const ceilPts = r.loops.map((loop) => loop.map(([u, v]) => { const [x, z] = fromPlan(a, u, v); return V.P(x, ceilY, z, topLi); }));
        this.screenRooms.push({ id: r.id, loops: floorPts, level: li });
        if (isCur || isHover) {
          ctx.beginPath();
          for (const loop of floorPts) { loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
          ctx.fillStyle = isCur ? 'rgba(232,220,199,0.26)' : 'rgba(232,220,199,0.14)';
          ctx.fill('evenodd');
        }
        const strong = isCur || isHover;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        // walls and ceiling: faint wires
        ctx.strokeStyle = `rgba(244,241,236,${strong ? 0.38 : 0.13})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        floorPts.forEach((loop, n) => loop.forEach(([x, y], i) => { ctx.moveTo(x, y); ctx.lineTo(...ceilPts[n][i]); }));
        for (const loop of ceilPts) { loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
        ctx.stroke();
        // the floor outline is what matters: strong
        ctx.strokeStyle = strong ? this.accent : 'rgba(244,241,236,0.85)';
        ctx.lineWidth = (strong ? 2.8 : 1.8) * k;
        ctx.beginPath();
        for (const loop of floorPts) { loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
        ctx.stroke();
      }
      if (this.feet && li === here) this._drawMe(V, li);
    }
    if (large) this._drawLabels(V, shown);
  }

  _drawMe(V, li) {
    const ctx = this.ctx;
    const [x, y, z] = this.feet;
    const [px, py] = V.P(x, y, z, li);
    const yr = (this.yaw * Math.PI) / 180;
    const fx = -Math.sin(yr), fz = -Math.cos(yr);
    const L = 1.8, spread = 0.5;
    const tip = (ang) => {
      const c = Math.cos(ang), s = Math.sin(ang);
      return V.P(x + (fx * c - fz * s) * L, y, z + (fx * s + fz * c) * L, li);
    };
    const g = ctx.createRadialGradient(px, py, 0, px, py, V.s * L);
    g.addColorStop(0, 'rgba(232,220,199,0.7)');
    g.addColorStop(1, 'rgba(232,220,199,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let t = -spread; t <= spread + 1e-6; t += spread / 6) ctx.lineTo(...tip(t));
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, this.mode === 'large' ? 5.5 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(13,13,14,0.85)';
    ctx.stroke();
  }

  _drawLabels(V, shown) {
    const ctx = this.ctx;
    const a = V.a;
    ctx.font = '500 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const r of this.rooms) {
      if (!shown.includes(r.level)) continue;
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

  // ------------------------------------------------------------ interaction
  pick(x, y) {
    const hits = (this.screenRooms || []).filter((r) => pointInLoops(r.loops, x, y));
    hits.sort((p, q) => q.level - p.level);  // upper storeys are drawn on top
    return hits[0]?.id || null;
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointermove', (e) => {
      this.lastInteract = performance.now();
      if (this.drag && this.mode === 'large') {
        const dx = e.clientX - this.drag.x;
        if (Math.abs(dx) > 3) this.drag.moved = true;
        this.userTurn = this.drag.turn - dx * 0.006;   // the house turns with the pointer
        return;
      }
      const id = this.pick(...pos(e));
      if (id !== this.hover) { this.hover = id; c.style.cursor = id ? 'pointer' : this.mode === 'large' ? 'grab' : 'pointer'; }
    });
    c.addEventListener('pointerleave', () => { this.hover = null; });
    c.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, turn: this.userTurn, moved: false };
      if (this.mode === 'large') c.setPointerCapture?.(e.pointerId);
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag; this.drag = null;
      if (d && d.moved) return;
      this.onPick?.(this.pick(...pos(e)), this.mode);
    });
  }
}
