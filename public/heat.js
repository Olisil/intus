// intus statistics: talking to the stats service, adding up visits, and the 3D heat layers.
// Used by the hidden stats page (stats-app.js) and by the viewer in heat mode (?heat).

export const CELL = 0.25;
const TOKEN_KEY = 'intus.stats.token';

export const statsUrl = () => (document.querySelector('meta[name="intus-stats"]')?.content || '').replace(/\/+$/, '');
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

export async function api(path, { method = 'GET', body, token = getToken() } = {}) {
  const r = await fetch(statsUrl() + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) { const e = new Error(j.error || `${r.status}`); e.status = r.status; throw e; }
  return j;
}

export async function loadSessions(tour, from = 0) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const j = await api(`/api/sessions?tour=${encodeURIComponent(tour)}&from=${from}&limit=1000&offset=${offset}`);
    out.push(...j.sessions);
    if (!j.more) break;
  }
  return out;
}

// add up a set of visits
export function aggregate(sessions, { minDur = 5 } = {}) {
  const A = { visits: 0, seconds: [], touch: 0, gyro: 0, rooms: {}, walk: new Map(), look: new Map(), daily: new Map(), list: [], roomsPerVisit: 0 };
  for (const s of sessions) {
    const d = s.data || {};
    const dur = Number(d.dur || s.dur || 0);
    if (dur < minDur) continue;
    A.visits++;
    A.seconds.push(dur);
    if (s.device === 'touch') { A.touch++; if (d.gyro) A.gyro++; }
    const day = new Date(s.started).toISOString().slice(0, 10);
    A.daily.set(day, (A.daily.get(day) || 0) + 1);
    const seen = Object.keys(d.rooms || {});
    A.roomsPerVisit += seen.length;
    for (const [id, sec] of Object.entries(d.rooms || {})) {
      const r = A.rooms[id] || (A.rooms[id] = { visits: 0, secs: 0 });
      r.visits++; r.secs += sec;
    }
    for (const [k, v] of Object.entries(d.walk || {})) A.walk.set(k, (A.walk.get(k) || 0) + v);
    for (const [k, v] of Object.entries(d.look || {})) A.look.set(k, (A.look.get(k) || 0) + v);
    A.list.push({ sid: s.sid, started: s.started, dur, device: s.device, country: s.country, rooms: seen.length, order: d.order || [], path: d.path || [] });
  }
  if (A.visits) A.roomsPerVisit /= A.visits;
  return A;
}

export const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
export const fmtDur = (s) => { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };

// value -> colour along a ramp of [r,g,b] stops; t in 0..1
export const RAMPS = {
  walk: [[246, 214, 138], [240, 140, 60], [240, 80, 60], [212, 34, 74]],
  look: [[143, 227, 255], [90, 170, 255], [106, 92, 255], [190, 70, 255]],
};
export function ramp(name, t) {
  const st = RAMPS[name];
  t = Math.max(0, Math.min(1, t)) * (st.length - 1);
  const i = Math.min(st.length - 2, Math.floor(t)), f = t - i;
  return st[i].map((c, k) => Math.round(c + (st[i + 1][k] - c) * f));
}
export const scaleOf = (values) => {  // robust maximum (95th percentile) so one long stop doesn't wash out the rest
  const v = [...values].sort((a, b) => a - b);
  return v.length ? Math.max(1e-6, v[Math.floor(v.length * 0.95)]) : 1;
};

// spread each cell a little into its neighbours on the same surface, for a soft heat look
function soften(cells, axes) {
  const out = new Map();
  const K = [[0, 0, 1], [1, 0, 0.45], [-1, 0, 0.45], [0, 1, 0.45], [0, -1, 0.45], [1, 1, 0.2], [1, -1, 0.2], [-1, 1, 0.2], [-1, -1, 0.2]];
  for (const [key, v] of cells) {
    const p = key.split(':').map(Number);
    for (const [a, b, w] of K) {
      const q = [...p];
      q[axes[0]] += a; q[axes[1]] += b;
      const k2 = q.join(':');
      out.set(k2, (out.get(k2) || 0) + v * w);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 3D layers in the viewer
// pc: PlayCanvas namespace; levels: tour.map.levels (for floor heights); cast(o, d): first hit {p, n} or null
export function buildHeat3D({ pc, app, camera, tris, levels, A, cast }) {
  const layer = new pc.Layer({ name: 'Heat' });
  app.scene.layers.push(layer);
  camera.camera.layers = [...camera.camera.layers, layer.id];

  // the walls and floors hide heat behind them (the splat itself writes no depth)
  if (tris) {
    const m = new pc.Mesh(app.graphicsDevice);
    m.setPositions(tris.vertices); m.setIndices(tris.indices); m.update();
    const mat = new pc.StandardMaterial();
    mat.useLighting = false; mat.blendState = pc.BlendState.NOWRITE; mat.depthWrite = true; mat.cull = pc.CULLFACE_NONE;
    mat.update();
    const occ = new pc.Entity('heat-occluder');
    occ.addComponent('render', { meshInstances: [new pc.MeshInstance(m, mat)], layers: [layer.id] });
    app.root.addChild(occ);
  }

  // a soft round spot, so neighbouring cells melt together instead of showing tiles
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.45, 'rgba(255,255,255,.7)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const spot = new pc.Texture(app.graphicsDevice, { width: 64, height: 64, format: pc.PIXELFORMAT_RGBA8, mipmaps: true,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE });
  spot.setSource(cv);

  const makeLayer = (quads, name) => {
    if (!quads.length) return null;
    const pos = [], col = [], uv = [], idx = [];
    for (const q of quads) {
      const b = pos.length / 3;
      for (const v of q.corners) pos.push(...v);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let i = 0; i < 4; i++) col.push(q.color[0] / 255, q.color[1] / 255, q.color[2] / 255, q.alpha);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(pos); mesh.setColors(col); mesh.setUvs(0, uv); mesh.setIndices(idx); mesh.update();
    const mat = new pc.StandardMaterial();
    mat.useLighting = false; mat.diffuse = new pc.Color(0, 0, 0);
    mat.emissive = new pc.Color(1, 1, 1); mat.emissiveVertexColor = true;
    mat.opacityMap = spot; mat.opacityMapChannel = 'a';
    mat.opacityVertexColor = true; mat.opacityVertexColorChannel = 'a';
    mat.blendType = pc.BLEND_NORMAL; mat.depthWrite = false; mat.cull = pc.CULLFACE_NONE;
    mat.update();
    const e = new pc.Entity(`heat-${name}`);
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], layers: [layer.id] });
    app.root.addChild(e);
    return e;
  };

  // gaze heat: a soft tile on each looked-at surface cell, snapped onto the surface
  const byAxis = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()];
  for (const [k, v] of A.look) { const p = k.split(':').map(Number); byAxis[p[3]].set(p.slice(0, 3).join(':'), v); }
  const lookQuads = [];
  const lookMax = scaleOf([...A.look.values()]);
  byAxis.forEach((cells, ax) => {
    const along = ax >> 1;                                  // 0:x 1:y 2:z = the surface normal's axis
    const plane = [0, 1, 2].filter((i) => i !== along);
    for (const [k, v] of cells) {
      const t = Math.min(1, v / lookMax);
      if (t < 0.08) continue;
      const c = k.split(':').map((n) => (Number(n) + 0.5) * CELL);
      const n = [0, 0, 0]; n[along] = ax % 2 === 0 ? 1 : -1;
      // find the actual surface: cast from just in front of the cell back towards it
      const o = c.map((x, i) => x + n[i] * 0.4), d = n.map((x) => -x);
      const hit = cast(o, d);
      if (!hit || Math.abs(hit.p[along] - c[along]) > CELL) continue;
      const s = hit.p[along] + n[along] * 0.02, R = CELL * 1.1;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const p = [...c]; p[along] = s; p[plane[0]] += a * R; p[plane[1]] += b * R; return p;
      });
      lookQuads.push({ corners, color: ramp('look', t), alpha: 0.18 + 0.5 * t });
    }
  });

  // walking heat: tiles on the floor of each storey
  const walkQuads = [];
  const walkMax = scaleOf([...A.walk.values()]);
  for (const [k, v] of soften(A.walk, [1, 2])) {
    const t = Math.min(1, v / walkMax);
    if (t < 0.06) continue;
    const [li, ix, iz] = k.split(':').map(Number);
    const y = (levels?.[li]?.y ?? 0) + 0.03;
    const cx = (ix + 0.5) * CELL, cz = (iz + 0.5) * CELL, R = CELL * 1.1;
    walkQuads.push({ corners: [[cx - R, y, cz - R], [cx + R, y, cz - R], [cx + R, y, cz + R], [cx - R, y, cz + R]], color: ramp('walk', t), alpha: 0.15 + 0.5 * t });
  }
  return { walk: makeLayer(walkQuads, 'walk'), look: makeLayer(lookQuads, 'look'), counts: { walk: walkQuads.length, look: lookQuads.length } };
}
