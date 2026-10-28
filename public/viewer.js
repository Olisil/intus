// intus walkthrough viewer
// Renders a Gaussian splat tour with PlayCanvas and walks it with a Rapier
// character controller (wall collision, stair auto-step, snap to ground).
//
// URL parameters
//   ?t=<id>          load tours/<id>/tour.json   (default: first id in tours/index.json, else "demo")
//   ?tour=<url>      load any tour.json by URL
//   ?room=<id|name>  start in this room
//   ?q=high|light    force the quality (otherwise chosen for the device, and remembered when changed)
//   ?edit            developer mode: F fly, G show collision, P copy spawn, position readout
//   ?lang=sv|en      force UI language

import { TourMap } from './map.js';
import { buildKeypad, buildStick, howToHTML, PHONE_FLIP } from './controls.js';
import { Gyro, yawPitchOf } from './gyro.js';

// Start downloading the engine and physics right away, in parallel with the tour itself.
const libs = Promise.all([import('./lib/playcanvas.mjs'), import('./lib/rapier.mjs')]);

const qs = new URLSearchParams(location.search);
const EDIT = qs.has('edit');
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem('intus.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('intus.' + k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- strings
const STRINGS = {
  en: {
    loading: 'Loading', enter: 'Step inside', resume: 'Continue', tapEnter: 'Tap to step inside',
    move: 'Move', look: 'Look around', run: 'Walk faster', reset: 'Back to start', exit: 'Pause', map: 'Map',
    drag: 'Drag', stick: 'Joystick', hint: 'WASD to walk · mouse to look · Esc to pause',
    hintTouch: 'Joystick to walk · drag to look', mouse: 'Mouse',
    lookShort: 'Look', tilt: 'Tilt phone',
    gyro: 'Look around by moving your phone', gyroOn: 'Move your phone to look around', gyroOff: 'Drag to look around',
    gyroNone: "This phone doesn't report how it's turned", gyroDenied: 'Motion access was not allowed',
    err: 'The tour files could not be loaded.', start: 'Start', goTo: 'Go to', floor: 'Floor', wholeHouse: 'Whole house',
    mapHint: 'Click a room to go there · drag to turn the house', mapHintTouch: 'Tap a room to go there',
    quality: 'Quality', qAuto: 'Auto', qHigh: 'High', qLight: 'Light', mb: 'MB',
  },
  sv: {
    loading: 'Laddar', enter: 'Kliv in', resume: 'Fortsätt', tapEnter: 'Tryck för att kliva in',
    move: 'Gå', look: 'Se dig omkring', run: 'Gå snabbare', reset: 'Till början', exit: 'Paus', map: 'Karta',
    drag: 'Dra', stick: 'Styrspak', hint: 'WASD för att gå · musen för att titta · Esc för paus',
    hintTouch: 'Styrspak för att gå · dra för att titta', mouse: 'Mus',
    lookShort: 'Titta', tilt: 'Vrid mobilen',
    gyro: 'Titta runt genom att röra telefonen', gyroOn: 'Rör telefonen för att se dig omkring', gyroOff: 'Dra för att se dig omkring',
    gyroNone: 'Telefonen rapporterar inte hur den vrids', gyroDenied: 'Åtkomst till rörelse tilläts inte',
    err: 'Visningens filer kunde inte laddas.', start: 'Start', goTo: 'Gå till', floor: 'Våning', wholeHouse: 'Hela huset',
    mapHint: 'Klicka på ett rum för att gå dit · dra för att vrida huset', mapHintTouch: 'Tryck på ett rum för att gå dit',
    quality: 'Kvalitet', qAuto: 'Auto', qHigh: 'Hög', qLight: 'Lätt', mb: 'MB',
  },
};
let T = STRINGS.en;

// ---------------------------------------------------------------- tour config
// Where tours live. Set once in the page:  <meta name="intus-tours" content="https://<your-bucket>/">
// Without it, tours load from the site's own tours/ folder.
const TOURS_BASE = new URL(document.querySelector('meta[name="intus-tours"]')?.content || 'tours/', document.baseURI).href;

async function resolveTourUrl() {
  if (qs.get('tour')) return new URL(qs.get('tour'), document.baseURI).href;
  let id = qs.get('t');
  if (!id) {
    for (const base of [TOURS_BASE, new URL('tours/', document.baseURI).href]) {
      try {
        const idx = await (await fetch(new URL('index.json', base), { cache: 'no-cache' })).json();
        id = idx.default || idx.tours?.[0]?.id;
        if (id) break;
      } catch { /* none here */ }
    }
  }
  id = encodeURIComponent(id || 'demo');
  for (const base of [TOURS_BASE, new URL('tours/', document.baseURI).href]) {
    const url = new URL(`${id}/tour.json`, base).href;
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.ok) return { url, json: await r.json() };
    } catch { /* next */ }
  }
  throw new Error(`tour "${decodeURIComponent(id)}" not found`);
}

const DEFAULTS = {
  title: 'Walkthrough', eyebrow: '', subtitle: '', lang: null,
  splat: 'tour.sog', splatLite: null, collision: 'collision.glb',
  spawn: { position: [0, 0, 0], yaw: 0 },
  eyeHeight: 1.6, walkSpeed: 1.4, runSpeed: 2.8,
  fov: 75, background: '#0d0d0e',
  stepHeight: 0.28, playerRadius: 0.22,
  bounds: null, path: null, map: null,
};

// ---------------------------------------------------------------- device + quality
const touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
function weakDevice() {
  const c = navigator.connection || {};
  if (c.saveData || ['slow-2g', '2g', '3g'].includes(c.effectiveType) || (c.downlink && c.downlink < 4)) return true;
  if (touch) return true;                                       // phones and tablets
  if (navigator.deviceMemory && navigator.deviceMemory <= 4) return true;
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return true;
  return false;
}
const qualitySetting = () => qs.get('q') || store.get('quality') || 'auto';
const chooseQuality = (tour) => {
  if (!tour.splatLite) return 'high';
  const s = qualitySetting();
  if (s === 'high' || s === 'light') return s;
  return weakDevice() ? 'light' : 'high';
};

// ---------------------------------------------------------------- download with progress + resume
// Flaky wifi drops long downloads; this picks up where it stopped (HTTP range) instead of restarting.
async function download(url, onProgress, tries = 5) {
  let got = 0, total = 0, chunks = [];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, got ? { headers: { Range: `bytes=${got}-` } } : { cache: 'no-cache' });
      if (got && res.status !== 206) { got = 0; chunks = []; }
      if (!res.ok) throw new Error(`${url} (${res.status})`);
      if (!total) total = parseInt(res.headers.get('content-length') || '0', 10) + got;
      if (!res.body?.getReader) { const b = await res.arrayBuffer(); onProgress(b.byteLength, b.byteLength); return b; }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.byteLength;
        onProgress(got, total);
      }
      return await new Blob(chunks).arrayBuffer();
    } catch (e) {
      if (attempt >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------------- GLB collision loader
// Minimal glTF 2.0 binary reader for the collision mesh written by collision.py (one node, no transforms).
function parseGlbTriangles(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('collision file is not a GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    else if (type === 0x004e4942) bin = buf.slice(start, start + len);
    off = start + len;
  }
  const positions = [], indices = [];
  let base = 0;
  for (const mesh of json.meshes) for (const prim of mesh.primitives) {
    if (prim.mode !== undefined && prim.mode !== 4) continue;
    const read = (i) => {
      const acc = json.accessors[i], view = json.bufferViews[acc.bufferView];
      const C = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType];
      const n = acc.count * ({ SCALAR: 1, VEC3: 3 }[acc.type] || 1);
      return new C(bin.slice((view.byteOffset || 0) + (acc.byteOffset || 0)), 0, n);
    };
    const pos = read(prim.attributes.POSITION);
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
    const count = pos.length / 3;
    const idx = prim.indices !== undefined ? read(prim.indices) : Uint32Array.from({ length: count }, (_, i) => i);
    for (let i = 0; i < idx.length; i++) indices.push(idx[i] + base);
    base += count;
  }
  return { vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// ---------------------------------------------------------------- main
async function main() {
  const { url: tourUrl, json } = await resolveTourUrl();
  const tour = { ...DEFAULTS, ...json };
  const lang = qs.get('lang') || tour.lang || (navigator.language || 'en').slice(0, 2);
  T = STRINGS[lang] || STRINGS.en;
  document.documentElement.lang = STRINGS[lang] ? lang : 'en';
  document.title = tour.title;
  $('title').textContent = tour.title;
  $('eyebrow').textContent = tour.eyebrow || '';
  $('subtitle').textContent = tour.subtitle || '';
  $('enterLabel').textContent = T.loading;
  $('keys').innerHTML = howToHTML({ touch, gyro: touch && Gyro.supported, T });
  const resolve = (f) => new URL(f, tourUrl).href;

  // ---- floor map (drawn while everything else loads)
  let mapLarge = null, mapSmall = null, pendingRoom = qs.get('room');
  let goToRoom = null;  // set once the player exists
  if (tour.map && tour.map.rooms?.length) {
    const pick = (id, from) => {
      if (!id) { if (from === 'small') pause(); return; }
      if (goToRoom) goToRoom(id);
      else {  // still loading: remember the choice and show it as where you'll start
        pendingRoom = id; mapLarge.current = id;
        document.querySelectorAll('.room-chip').forEach((b) => b.classList.toggle('chosen', b.dataset.room === id));
      }
    };
    mapLarge = new TourMap($('mapLarge'), tour.map, { onPick: pick });
    mapLarge.mode = 'large';
    mapSmall = new TourMap($('mapSmall'), tour.map, { onPick: pick });
    mapSmall.mode = 'small';
    // storey pickers: the big map (whole house before you enter, your storey once inside) and the small one
    const levels = tour.map.levels || [];
    if (levels.length > 1) {
      const opts = levels.map((_, i) => `<option value="${i}">${T.floor} ${i + 1}</option>`).join('');
      $('mapFloor').innerHTML = `<option value="all">${T.wholeHouse}</option>` + opts;
      $('miniFloor').innerHTML = opts;
      $('mapFloor').classList.remove('hidden');
      $('miniFloor').classList.remove('hidden');
      $('mapFloor').addEventListener('change', (e) => { mapLarge.only = e.target.value === 'all' ? null : +e.target.value; });
      $('miniFloor').addEventListener('change', (e) => { mapSmall.only = +e.target.value; mapSmall.pinnedFrom = mapSmall.hereLevel; });
      for (const el of [$('mapFloor'), $('miniFloor')]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    $('introMap').classList.remove('hidden');
    $('intro').classList.add('with-map');
    $('mapHint').textContent = touch ? T.mapHintTouch : T.mapHint;
    // room buttons, by storey
    const rooms = mapLarge.rooms;
    const groups = levels.map((_, li) => rooms.filter((r) => r.level === li));
    $('roomList').innerHTML = groups.map((g, li) => !g.length ? '' :
      `<div class="room-group">${levels.length > 1 ? `<span class="room-floor">${T.floor} ${li + 1}</span>` : ''}${g.map((r) =>
        `<button class="room-chip${r.id === tour.map.startRoom ? ' start' : ''}" data-room="${r.id}">${(r.name || '').replace(/</g, '&lt;')}${r.id === tour.map.startRoom ? `<em>${T.start}</em>` : ''}</button>`).join('')}</div>`).join('');
    $('roomsTitle').textContent = T.goTo;
    $('rooms').classList.remove('hidden');
    $('roomList').addEventListener('click', (e) => { const b = e.target.closest('[data-room]'); if (b) pick(b.dataset.room, 'large'); });
    $('roomList').addEventListener('mouseover', (e) => { const b = e.target.closest('[data-room]'); mapLarge.hover = b ? b.dataset.room : null; });
    $('roomList').addEventListener('mouseleave', () => { mapLarge.hover = null; });
  }
  let last = performance.now();
  const mapLoop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (mapLarge && !$('intro').classList.contains('hidden')) mapLarge.draw(dt);
    else if (mapSmall && !$('miniWrap').classList.contains('hidden')) {
      // the small map follows you onto another storey unless you picked one to look at
      const here = mapSmall.hereLevel;
      if (mapSmall.only !== null && mapSmall.pinnedFrom !== here) mapSmall.only = null;
      if (document.activeElement !== $('miniFloor')) $('miniFloor').value = String(mapSmall.only ?? here);
      mapSmall.draw(dt);
    }
    requestAnimationFrame(mapLoop);
  };
  requestAnimationFrame(mapLoop);

  // ---- quality
  let quality = chooseQuality(tour);
  if (tour.splatLite) {
    $('quality').classList.remove('hidden');
    $('qualityLabel').textContent = T.quality;
    const seg = $('qualitySeg');
    seg.innerHTML = [['auto', T.qAuto], ['high', T.qHigh], ['light', T.qLight]]
      .map(([v, l]) => `<button data-q="${v}">${l}</button>`).join('');
    const mark = () => [...seg.children].forEach((b) => b.classList.toggle('on', b.dataset.q === qualitySetting()));
    mark();
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]'); if (!b) return;
      store.set('quality', b.dataset.q);
      mark();
      const want = chooseQuality(tour);
      if (want !== quality) switchQuality?.(want);
    });
  }
  let switchQuality = null;

  // ---- downloads, all in parallel
  const progressBar = $('progress').firstElementChild;
  const progressText = $('progressText');
  const showProgress = (got, total) => {
    if (!total) return;
    $('progress').classList.remove('indeterminate');
    progressBar.style.width = `${Math.min(100, (got / total) * 100).toFixed(1)}%`;
    progressText.textContent = `${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} ${T.mb}`;
  };
  $('progress').classList.add('indeterminate');
  const splatFile = () => (quality === 'light' && tour.splatLite ? tour.splatLite : tour.splat);
  const splatData = download(resolve(splatFile()), showProgress);
  const collisionData = tour.collision
    ? fetch(resolve(tour.collision)).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
    : Promise.resolve(null);
  const [pc, { default: RAPIER }] = await libs;

  // ---- PlayCanvas app
  const canvas = $('c');
  const app = new pc.Application(canvas, {
    graphicsDeviceOptions: { antialias: false, alpha: false, powerPreference: 'high-performance' },
  });
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  // adaptive resolution: drop the render scale when frames get slow, raise it again when there's room
  const baseRatio = Math.min(window.devicePixelRatio || 1, touch ? 1.5 : 2);
  let renderScale = quality === 'light' ? 0.85 : 1;
  const minScale = Math.max(0.5, 0.75 / baseRatio);
  const applyScale = () => { app.graphicsDevice.maxPixelRatio = baseRatio * renderScale; app.resizeCanvas(); };
  applyScale();
  window.addEventListener('resize', () => app.resizeCanvas());
  app.start();

  const camera = new pc.Entity('camera');
  camera.addComponent('camera', {
    clearColor: new pc.Color().fromString(tour.background),
    fov: tour.fov, nearClip: 0.05, farClip: 500,
  });
  app.root.addChild(camera);

  const loadSplat = async (buf, file) => {
    const asset = new pc.Asset(`tour-${file}`, 'gsplat', { url: resolve(file), filename: file, contents: buf });
    await new Promise((ok, fail) => {
      asset.ready(ok);
      asset.on('error', (e) => fail(new Error(`splat: ${e}`)));
      app.assets.add(asset);
      app.assets.load(asset);
    });
    return asset;
  };

  // ---- physics + collision
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  let tris = null;
  try {
    const buf = await collisionData;
    if (buf) tris = parseGlbTriangles(buf);
  } catch (e) { console.warn('Collision mesh failed to load:', e); }
  if (tris && tris.indices.length) world.createCollider(RAPIER.ColliderDesc.trimesh(tris.vertices, tris.indices));
  else world.createCollider(RAPIER.ColliderDesc.cuboid(1000, 0.05, 1000).setTranslation(0, -0.05, 0));

  let splatAsset = await loadSplat(await splatData, splatFile());
  const splat = new pc.Entity('splat');
  splat.addComponent('gsplat', { asset: splatAsset });
  splat.setEulerAngles(0, 0, 180);   // PLY/SOG data -> engine space (PlayCanvas convention)
  app.root.addChild(splat);

  switchQuality = async (want) => {
    const prev = quality;
    quality = want;
    $('qualitySeg').classList.add('busy');
    try {
      const file = splatFile();
      const asset = await loadSplat(await download(resolve(file), () => {}), file);
      const old = splatAsset;
      splat.gsplat.asset = asset;
      splatAsset = asset;
      app.assets.remove(old); old.unload();
      renderScale = Math.min(1, renderScale + (want === 'light' ? 0.15 : 0)); applyScale();
    } catch (e) { console.warn(e); quality = prev; }
    $('qualitySeg').classList.remove('busy');
  };

  // ---- player
  const R = tour.playerRadius;
  const HALF = Math.max(0.1, (1.75 - 2 * R) / 2);      // capsule ~1.75 m tall
  const CENTER = HALF + R;                              // feet -> capsule centre
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(HALF, R), body);
  const kcc = world.createCharacterController(0.02);
  kcc.setUp({ x: 0, y: 1, z: 0 });
  kcc.enableAutostep(tour.stepHeight, 0.05, false);
  kcc.enableSnapToGround(0.35);
  kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
  kcc.setMinSlopeSlideAngle((65 * Math.PI) / 180);
  kcc.setSlideEnabled(true);

  const feet = new pc.Vec3(), prevFeet = new pc.Vec3(), drawFeet = new pc.Vec3();
  let yaw = 0, pitch = 0, vy = 0, fly = false, smoothEye = null;
  const gyro = new Gyro();
  const place = (x, y, z, yw = yaw, pt = 0) => {
    if (gyro.on) gyro.setYaw(yw);
    feet.set(x, y + 0.02, z); prevFeet.copy(feet);
    yaw = yw; pitch = pt; vy = 0; smoothEye = null;
    body.setTranslation({ x, y: y + CENTER + 0.02, z }, true);
    body.setNextKinematicTranslation({ x, y: y + CENTER + 0.02, z });
  };
  // where the tour starts: the room marked as start in the studio, else the spawn point
  const startRoom = mapLarge?.room(tour.map?.startRoom) || null;
  const respawn = () => {
    if (startRoom?.start) {
      const [x, y, z] = startRoom.start.position;
      place(x, y, z, startRoom.start.yaw || 0, 0);
    } else {
      const [x, y, z] = tour.spawn.position;
      place(x, y, z, tour.spawn.yaw || 0, tour.spawn.pitch || 0);
    }
  };
  respawn();
  goToRoom = (id) => {
    const r = mapLarge?.room(id);
    if (!r?.start) return;
    const [x, y, z] = r.start.position;
    place(x, y, z, r.start.yaw || 0, 0);
    currentRoom = null;
    start();
  };
  if (pendingRoom) {
    const r = mapLarge?.rooms.find((q) => q.id === pendingRoom || (q.name || '').toLowerCase() === String(pendingRoom).toLowerCase());
    if (r?.start) { const [x, y, z] = r.start.position; place(x, y, z, r.start.yaw || 0); }
  }

  // ---- debug collision overlay (edit mode, key G)
  let overlay = null;
  if (EDIT && tris) {
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(tris.vertices);
    mesh.setIndices(tris.indices);
    mesh.update();
    mesh.generateWireframe();
    const mat = new pc.StandardMaterial();
    mat.emissive = new pc.Color(1, 0.45, 0.1);
    mat.useLighting = false;
    mat.update();
    const mi = new pc.MeshInstance(mesh, mat);
    mi.renderStyle = pc.RENDERSTYLE_WIREFRAME;
    overlay = new pc.Entity('collision');
    overlay.addComponent('render', { meshInstances: [mi] });
    overlay.enabled = false;
    app.root.addChild(overlay);
  }

  // ---- input
  const keys = new Set();
  const stick = { x: 0, y: 0 };
  let active = false;
  addEventListener('keydown', (e) => {
    if (!active) return;
    keys.add(e.code);
    if (e.code === 'KeyR') respawn();
    if (e.code === 'KeyM' && mapSmall) {
      const shown = !$('miniWrap').classList.toggle('hidden');
      store.set('minimap', shown ? 'on' : 'off');
    }
    if (EDIT && e.code === 'KeyF') { fly = !fly; vy = 0; }
    if (EDIT && e.code === 'KeyG' && overlay) overlay.enabled = !overlay.enabled;
    if (EDIT && e.code === 'KeyP') {
      const spawn = { position: [+feet.x.toFixed(3), +feet.y.toFixed(3), +feet.z.toFixed(3)], yaw: +yaw.toFixed(1) };
      navigator.clipboard?.writeText(`"spawn": ${JSON.stringify(spawn)}`);
      console.log('spawn', JSON.stringify(spawn));
      flash(`Copied spawn ${JSON.stringify(spawn)}`);
    }
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const look = (dx, dy, k) => {
    yaw -= dx * k;
    pitch = Math.max(-85, Math.min(85, pitch - dy * k));
  };
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) look(e.movementX, e.movementY, 0.12);
  });

  // touch: joystick on the left, drag anywhere else to look
  const stickEl = $('stick'), knob = $('knob');
  buildStick(stickEl, 112);
  buildKeypad($('keypad'));
  let stickId = null, lookId = null, lx = 0, ly = 0;
  const stickMove = (t) => {
    const r = stickEl.getBoundingClientRect();
    let x = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    stick.x = x; stick.y = y;
    knob.style.transform = `translate(${x * 20}px, ${y * 20}px)`;
  };
  stickEl.addEventListener('touchstart', (e) => { e.preventDefault(); stickId = e.changedTouches[0].identifier; stickMove(e.changedTouches[0]); }, { passive: false });
  canvas.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; }, { passive: true });
  addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) stickMove(t);
      else if (t.identifier === lookId) {
        if (gyro.on) gyro.turn(-(t.clientX - lx) * 0.25); else look(t.clientX - lx, t.clientY - ly, 0.25);
        lx = t.clientX; ly = t.clientY;
      }
    }
  }, { passive: true });
  addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; stick.x = stick.y = 0; knob.style.transform = ''; }
      if (t.identifier === lookId) lookId = null;
    }
  });

  // ---- enter / pause
  const intro = $('intro'), enter = $('enter');
  enter.disabled = false;
  $('enterLabel').textContent = touch ? T.tapEnter : T.enter;
  $('progress').classList.add('hidden');
  progressText.textContent = '';
  document.body.classList.add('ready');
  const showMini = () => { if (mapSmall && store.get('minimap') !== 'off') $('miniWrap').classList.remove('hidden'); };
  let entered = false;
  function start() {
    active = true; entered = true;
    intro.classList.add('hidden');
    $('hud').classList.remove('hidden');
    showMini();
    if (touch) stickEl.classList.remove('hidden');
    else { $('keypad').classList.remove('hidden'); canvas.requestPointerLock?.(); }
  }
  function pause() {
    active = false; keys.clear();
    if (mapLarge && entered) {  // inside the tour: the big map shows the storey you're on
      mapLarge.only = mapLarge.hereLevel;
      if ($('mapFloor').options.length) $('mapFloor').value = String(mapLarge.only);
    }
    $('enterLabel').textContent = T.resume;
    intro.classList.remove('hidden');
    $('hud').classList.add('hidden');
    if (touch) stickEl.classList.add('hidden');
    if (document.pointerLockElement) document.exitPointerLock?.();
  }
  enter.addEventListener('click', start);
  canvas.addEventListener('click', () => { if (active && !touch && document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
  document.addEventListener('pointerlockchange', () => {
    if (!touch && document.pointerLockElement !== canvas && active && !EDIT) pause();
  });

  $('badgeTitle').textContent = tour.title;
  const hint = $('hint');
  hint.textContent = touch ? T.hintTouch : T.hint;
  setTimeout(() => { hint.style.opacity = 0; }, 7000);
  const flash = (msg) => { hint.textContent = msg; hint.style.opacity = 1; setTimeout(() => { hint.style.opacity = 0; }, 2500); };
  if (touch && Gyro.supported) {
    const btn = $('gyroBtn');
    btn.innerHTML = PHONE_FLIP;
    btn.classList.remove('hidden');
    btn.title = T.gyro; btn.setAttribute('aria-label', T.gyro);
    btn.addEventListener('click', async () => {
      if (gyro.on) { gyro.disable(); pitch = 0; btn.classList.remove('on'); btn.setAttribute('aria-pressed', 'false'); flash(T.gyroOff); return; }
      try {
        await gyro.enable(yaw);
        btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true'); flash(T.gyroOn);
      } catch (e) { flash(e.message === 'denied' ? T.gyroDenied : T.gyroNone); }
    });
  }
  if (EDIT) $('dev').classList.remove('hidden');

  // ---- rooms: which one are we in?
  let currentRoom = null, toastT = null;
  const updateRoom = () => {
    if (!mapLarge) return;
    const id = mapLarge.roomAt(feet.x, feet.y, feet.z);
    if (id && id !== currentRoom) {
      const changed = currentRoom !== null;
      currentRoom = id;
      const name = mapLarge.room(id)?.name || '';
      $('badgeRoom').textContent = name;
      $('badgeRoom').classList.toggle('hidden', !name);
      if (changed && active && name) {
        const t = $('roomToast');
        t.textContent = name; t.classList.add('show');
        clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
      }
    }
    for (const m of [mapLarge, mapSmall]) {
      m.current = currentRoom; m.feet = [drawFeet.x, drawFeet.y, drawFeet.z]; m.yaw = yaw;
    }
  };

  // ---- simulation
  const STEP = 1 / 60;
  let acc = 0, ema = 1 / 60, lastAdjust = performance.now(), roomT = 0;
  const forward = new pc.Vec3(), right = new pc.Vec3(), move = new pc.Vec3(), tmp = new pc.Vec3();
  const minY = tour.bounds ? tour.bounds.min[1] - 3 : -20;

  // light up the keys (and the joystick arrows) for the way you're moving
  const dirEls = [...document.querySelectorAll('#keypad [data-dir], #stick [data-dir]')];
  let dirState = '';
  const showDirections = () => {
    const k = (...c) => active && c.some((x) => keys.has(x));
    const d = {
      f: k('KeyW', 'ArrowUp') || stick.y < -0.35, b: k('KeyS', 'ArrowDown') || stick.y > 0.35,
      l: k('KeyA', 'ArrowLeft') || stick.x < -0.35, r: k('KeyD', 'ArrowRight') || stick.x > 0.35,
    };
    const st = `${+d.f}${+d.b}${+d.l}${+d.r}`;
    if (st === dirState) return;
    dirState = st;
    for (const el of dirEls) el.classList.toggle('on', d[el.dataset.dir]);
    $('keypad').classList.toggle('active', st !== '0000');
  };

  app.on('update', (dt) => {
    dt = Math.min(dt, 0.1);
    // adaptive resolution (only while walking, and not more often than every 1.5 s)
    ema = ema * 0.94 + dt * 0.06;
    const now = performance.now();
    if (active && now - lastAdjust > 1500) {
      if (ema > 1 / 42 && renderScale > minScale) { renderScale = Math.max(minScale, renderScale - 0.1); applyScale(); lastAdjust = now; }
      else if (ema < 1 / 57 && renderScale < 1 && now - lastAdjust > 5000) { renderScale = Math.min(1, renderScale + 0.05); applyScale(); lastAdjust = now; }
    }
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
      prevFeet.copy(feet);
      const yr = (yaw * Math.PI) / 180;
      forward.set(-Math.sin(yr), 0, -Math.cos(yr));
      right.set(Math.cos(yr), 0, -Math.sin(yr));
      let f = 0, s = 0, u = 0;
      if (active) {
        if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
        if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
        if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
        if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
        if (keys.has('KeyE') || keys.has('Space')) u += 1;
        if (keys.has('KeyQ') || keys.has('KeyC')) u -= 1;
        f -= stick.y; s += stick.x;
      }
      const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
      const speed = (run ? tour.runSpeed : tour.walkSpeed) * (fly ? 1.5 : 1);
      move.set(forward.x * f + right.x * s, 0, forward.z * f + right.z * s);
      if (move.length() > 1) move.normalize();
      move.mulScalar(speed * STEP);

      if (fly) {
        feet.add(move); feet.y += u * speed * STEP;
        body.setNextKinematicTranslation({ x: feet.x, y: feet.y + CENTER, z: feet.z });
      } else {
        vy = Math.max(vy - 9.81 * STEP, -20);
        kcc.computeColliderMovement(collider, { x: move.x, y: vy * STEP, z: move.z });
        const m = kcc.computedMovement();
        if (kcc.computedGrounded()) vy = 0;
        const p = body.translation();
        const nx = p.x + m.x, ny = p.y + m.y, nz = p.z + m.z;
        body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
        feet.set(nx, ny - CENTER, nz);
        if (feet.y < minY) respawn();
      }
      world.step();
    }
    // draw between the last two physics steps: smooth motion at any refresh rate (no 60 Hz judder)
    drawFeet.lerp(prevFeet, feet, acc / STEP);
    const eyeY = drawFeet.y + tour.eyeHeight;
    smoothEye = smoothEye === null || fly ? eyeY : pc.math.lerp(smoothEye, eyeY, 1 - Math.exp(-dt * 14));
    camera.setPosition(drawFeet.x, smoothEye, drawFeet.z);
    const gq = gyro.frame(dt);
    if (gq) {
      camera.setRotation(new pc.Quat(gq[0], gq[1], gq[2], gq[3]));
      ({ yaw, pitch } = yawPitchOf(gq));
    } else camera.setEulerAngles(pitch, yaw, 0);
    showDirections();
    if ((roomT += dt) > 0.1) { roomT = 0; updateRoom(); }
    if (EDIT) {
      $('dev').textContent =
        `pos  ${feet.x.toFixed(2)} ${feet.y.toFixed(2)} ${feet.z.toFixed(2)}\nyaw  ${yaw.toFixed(0)}°   ${fly ? 'FLY' : 'walk'}\n` +
        `room ${currentRoom || '-'}   ${quality}  scale ${renderScale.toFixed(2)}  ${(1 / ema).toFixed(0)} fps\n` +
        `F fly · G collision · P copy spawn`;
    }
    void tmp;
  });

  // small scripting hook (used by tests and for embedding)
  window.__tour = {
    app, tour, keys, respawn, goToRoom,
    get feet() { return [feet.x, feet.y, feet.z]; },
    get view() { return { yaw, pitch }; },
    get room() { return currentRoom; },
    get quality() { return quality; },
    get renderScale() { return renderScale; },
    setView: (y, p = 0) => { yaw = y; pitch = p; },
    teleport: (x, y, z) => { place(x, y, z, yaw, pitch); },
    setActive: (v) => { active = v; },
    pause, start,
  };
}

main().catch((e) => {
  console.error(e);
  $('intro').classList.add('hidden');
  $('error').classList.remove('hidden');
  $('errorText').textContent = `${T.err} ${e.message || e}`;
  window.__tourError = String(e.message || e);
});
