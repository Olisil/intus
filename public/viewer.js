// Nassau walkthrough viewer
// Renders a Gaussian splat tour with PlayCanvas and walks it with a Rapier
// character controller (wall collision, stair auto-step, snap to ground).
//
// URL parameters
//   ?t=<id>          load tours/<id>/tour.json   (default: first id in tours/index.json, else "demo")
//   ?tour=<url>      load any tour.json by URL
//   ?edit            developer mode: F fly, G show collision, P copy spawn, position readout
//   ?lang=sv|en      force UI language

import * as pc from './lib/playcanvas.mjs';
import RAPIER from './lib/rapier.mjs';

const qs = new URLSearchParams(location.search);
const EDIT = qs.has('edit');
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- strings
const STRINGS = {
  en: {
    loading: 'Loading', enter: 'Step inside', resume: 'Continue', tapEnter: 'Tap to step inside',
    move: 'Move', look: 'Look around', run: 'Walk faster', reset: 'Back to start', exit: 'Pause',
    drag: 'Drag', stick: 'Joystick', hint: 'WASD to walk · mouse to look · Esc to pause',
    hintTouch: 'Joystick to walk · drag to look', mouse: 'Mouse',
    err: 'The tour files could not be loaded.',
  },
  sv: {
    loading: 'Laddar', enter: 'Kliv in', resume: 'Fortsätt', tapEnter: 'Tryck för att kliva in',
    move: 'Gå', look: 'Se dig omkring', run: 'Gå snabbare', reset: 'Till början', exit: 'Paus',
    drag: 'Dra', stick: 'Styrspak', hint: 'WASD för att gå · musen för att titta · Esc för paus',
    hintTouch: 'Styrspak för att gå · dra för att titta', mouse: 'Mus',
    err: 'Visningens filer kunde inte laddas.',
  },
};
let T = STRINGS.en;

// ---------------------------------------------------------------- tour config
async function resolveTourUrl() {
  if (qs.get('tour')) return new URL(qs.get('tour'), document.baseURI).href;
  let id = qs.get('t');
  if (!id) {
    try {
      const idx = await (await fetch(new URL('tours/index.json', document.baseURI), { cache: 'no-cache' })).json();
      id = idx.default || idx.tours?.[0]?.id;
    } catch { /* no index */ }
  }
  return new URL(`tours/${encodeURIComponent(id || 'demo')}/tour.json`, document.baseURI).href;
}

const DEFAULTS = {
  title: 'Walkthrough', eyebrow: '', subtitle: '', lang: null,
  splat: 'tour.sog', collision: 'collision.glb',
  spawn: { position: [0, 0, 0], yaw: 0 },
  eyeHeight: 1.6, walkSpeed: 1.4, runSpeed: 2.8,
  fov: 75, background: '#0d0d0e',
  stepHeight: 0.28, playerRadius: 0.22,
  bounds: null, path: null,
};

// ---------------------------------------------------------------- GLB collision loader
// Minimal glTF 2.0 binary reader: collects all triangle primitives, baked into world space.
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
  const g = json;
  const read = (accIdx) => {
    const acc = g.accessors[accIdx];
    const view = g.bufferViews[acc.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
    const Ctor = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType];
    const byteOff = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = view.byteStride || Ctor.BYTES_PER_ELEMENT * comps;
    const out = new Ctor(acc.count * comps);
    const src = new DataView(bin);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const p = byteOff + i * stride + c * Ctor.BYTES_PER_ELEMENT;
        out[i * comps + c] = Ctor === Float32Array ? src.getFloat32(p, true)
          : Ctor === Uint32Array ? src.getUint32(p, true)
          : Ctor === Uint16Array ? src.getUint16(p, true) : src.getUint8(p);
      }
    }
    return out;
  };
  const positions = [], indices = [];
  let base = 0;
  const visit = (nodeIdx, parent) => {
    const n = g.nodes[nodeIdx];
    const local = new pc.Mat4();
    if (n.matrix) local.set(n.matrix);
    else {
      const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
      local.setTRS(new pc.Vec3(...t), new pc.Quat(r[0], r[1], r[2], r[3]), new pc.Vec3(...s));
    }
    const world = new pc.Mat4().mul2(parent, local);
    if (n.mesh !== undefined) {
      for (const prim of g.meshes[n.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const pos = read(prim.attributes.POSITION);
        const v = new pc.Vec3();
        const count = pos.length / 3;
        for (let i = 0; i < count; i++) {
          v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
          world.transformPoint(v, v);
          positions.push(v.x, v.y, v.z);
        }
        const idx = prim.indices !== undefined ? read(prim.indices) : Uint32Array.from({ length: count }, (_, i) => i);
        for (let i = 0; i < idx.length; i++) indices.push(idx[i] + base);
        base += count;
      }
    }
    (n.children || []).forEach((c) => visit(c, world));
  };
  const scene = g.scenes?.[g.scene ?? 0];
  (scene ? scene.nodes : g.nodes.map((_, i) => i)).forEach((i) => visit(i, new pc.Mat4()));
  return { vertices: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// ---------------------------------------------------------------- main
async function main() {
  const tourUrl = await resolveTourUrl();
  const res = await fetch(tourUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${tourUrl} (${res.status})`);
  const tour = { ...DEFAULTS, ...(await res.json()) };
  const lang = qs.get('lang') || tour.lang || (navigator.language || 'en').slice(0, 2);
  T = STRINGS[lang] || STRINGS.en;
  document.documentElement.lang = STRINGS[lang] ? lang : 'en';
  document.title = tour.title;
  $('title').textContent = tour.title;
  $('eyebrow').textContent = tour.eyebrow || '';
  $('subtitle').textContent = tour.subtitle || '';
  $('enterLabel').textContent = T.loading;

  const touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  $('keys').innerHTML = touch
    ? `<span>${T.stick}</span><span>${T.move}</span><span>${T.drag}</span><span>${T.look}</span>`
    : `<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>${T.move}</span>
       <span><kbd>${T.mouse}</kbd></span><span>${T.look}</span>
       <span><kbd>Shift</kbd></span><span>${T.run}</span>
       <span><kbd>R</kbd></span><span>${T.reset}</span>
       <span><kbd>Esc</kbd></span><span>${T.exit}</span>`;

  const resolve = (f) => new URL(f, tourUrl).href;

  // ---- PlayCanvas app
  const canvas = $('c');
  const app = new pc.Application(canvas, {
    graphicsDeviceOptions: { antialias: false, alpha: false, powerPreference: 'high-performance' },
  });
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, touch ? 1.5 : 2);
  window.addEventListener('resize', () => app.resizeCanvas());
  app.start();

  const camera = new pc.Entity('camera');
  camera.addComponent('camera', {
    clearColor: new pc.Color().fromString(tour.background),
    fov: tour.fov, nearClip: 0.05, farClip: 500,
  });
  app.root.addChild(camera);

  // ---- splat
  const progressBar = $('progress').firstElementChild;
  $('progress').classList.add('indeterminate');
  const splatAsset = new pc.Asset('tour', 'gsplat', { url: resolve(tour.splat) });
  splatAsset.on('progress', (got, total) => {
    if (!total) return;
    $('progress').classList.remove('indeterminate');
    progressBar.style.width = `${Math.min(100, (got / total) * 100).toFixed(1)}%`;
  });
  const splatLoaded = new Promise((ok, fail) => {
    splatAsset.ready(ok);
    splatAsset.on('error', (e) => fail(new Error(`splat: ${e}`)));
  });
  app.assets.add(splatAsset);
  app.assets.load(splatAsset);

  // ---- physics + collision, in parallel with the splat download
  const physicsReady = (async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    let tris = null;
    if (tour.collision) {
      try {
        const r = await fetch(resolve(tour.collision));
        if (r.ok) tris = parseGlbTriangles(await r.arrayBuffer());
        else console.warn('No collision mesh found; walking on a flat floor.');
      } catch (e) { console.warn('Collision mesh failed to load:', e); }
    }
    if (tris && tris.indices.length) {
      world.createCollider(RAPIER.ColliderDesc.trimesh(tris.vertices, tris.indices));
    } else {
      // fallback: an infinite floor at y = 0 so the tour is still walkable
      world.createCollider(RAPIER.ColliderDesc.cuboid(1000, 0.05, 1000).setTranslation(0, -0.05, 0));
    }
    return { world, tris };
  })();

  const [, phys] = await Promise.all([splatLoaded, physicsReady]);
  const splat = new pc.Entity('splat');
  splat.addComponent('gsplat', { asset: splatAsset });
  splat.setEulerAngles(0, 0, 180);   // PLY/SOG data -> engine space (PlayCanvas convention)
  app.root.addChild(splat);

  // ---- player
  const { world } = phys;
  const R = tour.playerRadius;
  const HALF = Math.max(0.1, (1.75 - 2 * R) / 2);      // capsule ~1.75 m tall
  const CENTER = HALF + R;                              // feet -> capsule centre
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(HALF, R), body);
  const kcc = world.createCharacterController(0.02);
  kcc.setUp({ x: 0, y: 1, z: 0 });
  kcc.enableAutostep(tour.stepHeight, 0.12, false);
  kcc.enableSnapToGround(0.35);
  kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
  kcc.setMinSlopeSlideAngle((65 * Math.PI) / 180);
  kcc.setSlideEnabled(true);

  const feet = new pc.Vec3();
  let yaw = 0, pitch = 0, vy = 0, fly = false;
  const respawn = () => {
    const [x, y, z] = tour.spawn.position;
    feet.set(x, y + 0.02, z);
    yaw = tour.spawn.yaw || 0; pitch = tour.spawn.pitch || 0; vy = 0;
    body.setNextKinematicTranslation({ x, y: y + CENTER + 0.02, z });
    body.setTranslation({ x, y: y + CENTER + 0.02, z }, true);
  };
  respawn();

  // ---- debug collision overlay (edit mode, key G)
  let overlay = null;
  if (EDIT && phys.tris) {
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(phys.tris.vertices);
    mesh.setIndices(phys.tris.indices);
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
  let stickId = null, lookId = null, lx = 0, ly = 0;
  const stickMove = (t) => {
    const r = stickEl.getBoundingClientRect();
    let x = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    stick.x = x; stick.y = y;
    knob.style.transform = `translate(${x * 36}px, ${y * 36}px)`;
  };
  stickEl.addEventListener('touchstart', (e) => { e.preventDefault(); stickId = e.changedTouches[0].identifier; stickMove(e.changedTouches[0]); }, { passive: false });
  canvas.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; }, { passive: true });
  addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) stickMove(t);
      else if (t.identifier === lookId) { look(t.clientX - lx, t.clientY - ly, 0.25); lx = t.clientX; ly = t.clientY; }
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
  const start = () => {
    active = true;
    intro.classList.add('hidden');
    $('hud').classList.remove('hidden');
    if (touch) stickEl.classList.remove('hidden');
    else canvas.requestPointerLock?.();
  };
  enter.addEventListener('click', start);
  canvas.addEventListener('click', () => { if (active && !touch && document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
  document.addEventListener('pointerlockchange', () => {
    if (!touch && document.pointerLockElement !== canvas && active && !EDIT) {
      active = false; keys.clear();
      $('enterLabel').textContent = T.resume;
      intro.classList.remove('hidden');
    }
  });

  $('badge').textContent = tour.title;
  const hint = $('hint');
  hint.textContent = touch ? T.hintTouch : T.hint;
  setTimeout(() => { hint.style.opacity = 0; }, 7000);
  const flash = (msg) => { hint.textContent = msg; hint.style.opacity = 1; setTimeout(() => { hint.style.opacity = 0; }, 2500); };
  if (EDIT) $('dev').classList.remove('hidden');

  // ---- simulation
  const STEP = 1 / 60;
  let acc = 0;
  const forward = new pc.Vec3(), right = new pc.Vec3(), move = new pc.Vec3();
  const minY = tour.bounds ? tour.bounds.min[1] - 3 : -20;
  let smoothEye = null;

  app.on('update', (dt) => {
    dt = Math.min(dt, 0.1);
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
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
      move.set(0, 0, 0).add(forward.clone().mulScalar(f)).add(right.clone().mulScalar(s));
      if (move.length() > 1) move.normalize();
      move.mulScalar(speed * STEP);

      if (fly) {
        feet.add(move).add(new pc.Vec3(0, u * speed * STEP, 0));
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
    // smooth eye height so stair steps don't jolt the view
    const eyeY = feet.y + tour.eyeHeight;
    smoothEye = smoothEye === null || fly ? eyeY : pc.math.lerp(smoothEye, eyeY, 1 - Math.exp(-dt * 14));
    camera.setPosition(feet.x, smoothEye, feet.z);
    camera.setEulerAngles(pitch, yaw, 0);
    if (EDIT) {
      $('dev').textContent =
        `pos  ${feet.x.toFixed(2)} ${feet.y.toFixed(2)} ${feet.z.toFixed(2)}\nyaw  ${yaw.toFixed(0)}°   ${fly ? 'FLY' : 'walk'}\n` +
        `F fly · G collision · P copy spawn`;
    }
  });

  // small scripting hook (used by tests and for embedding)
  window.__tour = {
    app, tour, keys, respawn,
    get feet() { return [feet.x, feet.y, feet.z]; },
    get view() { return { yaw, pitch }; },
    setView: (y, p = 0) => { yaw = y; pitch = p; },
    teleport: (x, y, z) => { feet.set(x, y, z); vy = 0; body.setTranslation({ x, y: y + CENTER, z }, true); body.setNextKinematicTranslation({ x, y: y + CENTER, z }); },
    setActive: (v) => { active = v; },
  };
}

main().catch((e) => {
  console.error(e);
  $('intro').classList.add('hidden');
  $('error').classList.remove('hidden');
  $('errorText').textContent = `${T.err} ${e.message || e}`;
  window.__tourError = String(e.message || e);
});
