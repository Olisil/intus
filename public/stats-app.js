// intus statistics page (hidden, sign-in required). Data: the intus-stats Worker. Tours: the R2 bucket.
import { api, statsUrl, getToken, setToken, loadSessions, aggregate, median, fmtDur, ramp, scaleOf, CELL } from './heat.js';
import { unionOutline, toPlan, fromPlan, tightenRooms } from './map.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOURS_BASE = (document.querySelector('meta[name="intus-tours"]')?.content || 'tours').replace(/\/+$/, '');
const store = { get: (k) => { try { return localStorage.getItem('intus.stats.' + k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('intus.stats.' + k, v); } catch { /* */ } } };
let toastT;
const toast = (m) => { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); };
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

let me = null, tours = [], tourId = null, tourJson = null, days = Number(store.get('days') ?? 30), A = null, level = 0, rooms = [];
const titles = {};

// ------------------------------------------------------------------ sign in
async function boot() {
  if (!statsUrl()) { show('auth'); show('loginForm', false); show('noConfig'); return; }
  if (getToken()) {
    try { me = (await api('/api/me')).user; return enter(); } catch { setToken(''); }
  }
  show('auth');
  try {
    const st = await api('/auth/status', { token: '' });
    if (st.setup) { show('loginForm', false); show('setupForm'); }
  } catch (e) { $('lMsg').textContent = `Kan inte nå statistiktjänsten (${e.message}).`; }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lMsg').textContent = '';
  try {
    const r = await api('/auth/login', { method: 'POST', body: { email: $('lEmail').value, password: $('lPass').value }, token: '' });
    setToken(r.token); me = r.user; enter();
  } catch (err) { $('lMsg').textContent = err.message; }
});
$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('sMsg').textContent = '';
  try {
    const r = await api('/auth/setup', { method: 'POST', token: '', body: { code: $('sCode').value, name: $('sName').value, email: $('sEmail').value, password: $('sPass').value } });
    setToken(r.token); me = r.user; enter();
  } catch (err) { $('sMsg').textContent = err.message; }
});
$('logout').onclick = () => { setToken(''); location.reload(); };

async function enter() {
  show('auth', false); show('top'); show('dash');
  $('who').textContent = me.name || me.email;
  show('usersBtn', me.role === 'admin');
  show('clearBtn', me.role === 'admin');
  [...$('period').children].forEach((b) => b.classList.toggle('on', Number(b.dataset.d) === days));
  await loadTours();
}

// ------------------------------------------------------------------ tours
async function tourTitle(id) {
  if (titles[id]) return titles[id];
  try {
    const t = await (await fetch(`${TOURS_BASE}/${encodeURIComponent(id)}/tour.json`, { cache: 'no-cache' })).json();
    titles[id] = t.title || id;
  } catch { titles[id] = id; }
  return titles[id];
}

async function loadTours() {
  tours = (await api('/api/tours')).tours;
  if (!tours.length) {
    $('tourSel').innerHTML = '<option>Inga besök än</option>';
    show('empty'); $('empty').textContent = 'Inga besök registrerade än. Statistiken börjar samlas när någon öppnar en visning.';
    ['kpis', 'heatWrap'].forEach((id) => $(id).closest('section').classList.add('hidden'));
    return;
  }
  await Promise.all(tours.map((t) => tourTitle(t.tour)));
  $('tourSel').innerHTML = tours.map((t) => `<option value="${esc(t.tour)}">${esc(titles[t.tour])} · ${t.visits} besök</option>`).join('');
  const want = new URLSearchParams(location.search).get('t') || store.get('tour');
  tourId = tours.some((t) => t.tour === want) ? want : tours[0].tour;
  $('tourSel').value = tourId;
  await loadTour();
}
$('tourSel').onchange = () => { tourId = $('tourSel').value; store.set('tour', tourId); loadTour(); };
$('period').onclick = (e) => {
  const b = e.target.closest('[data-d]'); if (!b) return;
  days = Number(b.dataset.d); store.set('days', days);
  [...$('period').children].forEach((x) => x.classList.toggle('on', x === b));
  loadTour();
};

async function loadTour() {
  stopReplay();
  try { tourJson = await (await fetch(`${TOURS_BASE}/${encodeURIComponent(tourId)}/tour.json`, { cache: 'no-cache' })).json(); } catch { tourJson = {}; }
  $('tEyebrow').textContent = tourJson.eyebrow || '';
  $('tTitle').textContent = tourJson.title || tourId;
  $('tSub').textContent = tourJson.subtitle || '';
  const viewer = new URL(`./?t=${encodeURIComponent(tourId)}`, document.baseURI);
  $('openTour').href = viewer.href;
  $('open3d').href = `${viewer.href}&heat&days=${days}`;
  const map = tourJson.map;
  rooms = map ? tightenRooms((map.rooms || []).filter((r) => !r.hidden)).map((r) => ({ ...r, loops: unionOutline(r.rects || []) })) : [];
  const from = days ? Date.now() - days * 864e5 : 0;
  A = aggregate(await loadSessions(tourId, from));
  renderAll();
}

// ------------------------------------------------------------------ numbers
function renderAll() {
  const none = !A.visits;
  show('empty', none);
  $('empty').textContent = 'Inga besök i den här perioden än.';
  document.querySelectorAll('.dash > section').forEach((s) => s.classList.toggle('hidden', none && !s.classList.contains('hero')));
  if (none) return;
  const avg = A.seconds.reduce((a, b) => a + b, 0) / A.visits;
  const k = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
  $('kpis').innerHTML =
    k(A.visits, 'besök') + k(fmtDur(median(A.seconds)), 'mediantid') + k(fmtDur(avg), 'snittid') +
    k(`${Math.round((100 * A.touch) / A.visits)} %`, 'på mobil') + k(A.roomsPerVisit.toFixed(1), 'rum per besök') +
    (A.touch ? k(`${Math.round((100 * A.gyro) / A.touch)} %`, 'av mobilerna vred telefonen') : '');
  renderDaily(); renderRooms(); renderLevels(); renderVisits();
}

function renderDaily() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let n = days || 0;
  if (!n) { const first = Math.min(...A.list.map((v) => v.started)); n = Math.min(365, Math.ceil((Date.now() - first) / 864e5) + 1); }
  n = Math.max(7, n);
  const bars = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 864e5);
    const key = d.toISOString().slice(0, 10);
    bars.push({ d, v: A.daily.get(key) || 0 });
  }
  const max = Math.max(1, ...bars.map((b) => b.v));
  const fmt = (d) => d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  $('daily').innerHTML = bars.map((b) => `<div class="bar" style="height:${Math.max(2, (100 * b.v) / max)}%" data-t="${fmt(b.d)}: ${b.v}"></div>`).join('') ;
  $('daily').insertAdjacentHTML('afterend', '');
  const axis = $('daily').nextElementSibling?.classList.contains('daily-axis') ? $('daily').nextElementSibling : null;
  const html = `<div class="daily-axis"><span>${fmt(bars[0].d)}</span><span>${fmt(bars.at(-1).d)}</span></div>`;
  if (axis) axis.outerHTML = html; else $('daily').insertAdjacentHTML('afterend', html);
}

function renderRooms() {
  const list = rooms.length ? rooms : Object.keys(A.rooms).map((id) => ({ id, name: id, level: 0 }));
  const levels = tourJson.map?.levels || [];
  $('rooms').innerHTML = list.map((r) => {
    const s = A.rooms[r.id] || { visits: 0, secs: 0 };
    const share = s.visits / A.visits;
    return `<div class="room"><span class="name">${esc(r.name)}${levels.length > 1 ? `<small>vån ${r.level + 1}</small>` : ''}</span>
      <span class="track"><i style="width:${(100 * share).toFixed(1)}%"></i></span>
      <span class="val"><b>${Math.round(100 * share)} %</b> · ${s.visits ? fmtDur(s.secs / s.visits) : '–'}</span></div>`;
  }).join('') || '<p class="hint">Visningen har inga rum än.</p>';
}

let showAll = false;
function renderVisits() {
  const name = (id) => rooms.find((r) => r.id === id)?.name || '';
  const fmt = (t) => new Date(t).toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const all = [...A.list].sort((a, b) => b.started - a.started);
  const list = all.slice(0, showAll ? 500 : 15);
  $('visits').innerHTML = list.map((v, i) => `<div class="visit" data-i="${i}">
      <span>${fmt(v.started)}</span><span>${fmtDur(v.dur)}</span><span>${v.device === 'touch' ? 'Mobil' : 'Dator'}</span>
      <span class="r">${esc(v.order.map(name).filter(Boolean).slice(0, 6).join(' → '))}</span><span>${esc(v.country || '')}</span>
      ${me.role === 'admin' ? `<span class="x" data-del="${esc(v.sid)}" title="Ta bort besöket">×</span>` : '<span></span>'}</div>`).join('')
    + (all.length > list.length ? `<button class="btn small ghost more" id="moreVisits">Visa alla ${all.length} besök</button>` : '');
  if ($('moreVisits')) $('moreVisits').onclick = (e) => { e.stopPropagation(); showAll = true; renderVisits(); };
  $('visits').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (!confirm('Ta bort det här besöket från statistiken?')) return;
      await api(`/api/sessions?tour=${encodeURIComponent(tourId)}&sid=${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      return loadTour();
    }
    const row = e.target.closest('[data-i]'); if (!row) return;
    document.querySelectorAll('.visit').forEach((x) => x.classList.toggle('on', x === row));
    $('heatWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    replay(list[Number(row.dataset.i)]);
  };
}
$('clearBtn').onclick = async () => {
  if (!confirm(`Rensa all statistik för ${titles[tourId] || tourId}? Det går inte att ångra.`)) return;
  const r = await api(`/api/sessions?tour=${encodeURIComponent(tourId)}`, { method: 'DELETE' });
  toast(`${r.removed} besök borttagna`); loadTours();
};

// ------------------------------------------------------------------ floor heat map
const layers = { walk: true, look: true, path: false };
$('layers').onchange = (e) => { const c = e.target.closest('[data-l]'); if (c) { layers[c.dataset.l] = c.checked; drawHeat(); } };

function renderLevels() {
  const lv = tourJson.map?.levels || [{ y: 0, height: 2.5 }];
  level = Math.min(level, lv.length - 1);
  $('levels').innerHTML = lv.length > 1 ? lv.map((_, i) => `<button data-l="${i}" class="${i === level ? 'on' : ''}">Våning ${i + 1}</button>`).join('') : '';
  $('levels').classList.toggle('hidden', lv.length < 2);
  drawHeat();
}
$('levels').onclick = (e) => { const b = e.target.closest('[data-l]'); if (!b) return; level = Number(b.dataset.l); renderLevels(); };

const imgs = {};
function planImage(file) {
  if (!file) return null;
  if (!imgs[file]) { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => drawHeat(); im.src = `${TOURS_BASE}/${encodeURIComponent(tourId)}/${file}`; imgs[file] = im; }
  return imgs[file];
}

let view = null;
function fitView(w, h) {
  const map = tourJson.map;
  const a = map?.angle || 0;
  let pts = [];
  for (const r of rooms) if (r.level === level) for (const q of r.rects) pts.push([q[0], q[1]], [q[2], q[3]]);
  if (!pts.length) {  // no rooms: fit what visitors did
    for (const k of A.walk.keys()) { const [li, ix, iz] = k.split(':').map(Number); if (li === level) pts.push(toPlan(a, (ix + 0.5) * CELL, (iz + 0.5) * CELL)); }
  }
  if (!pts.length) pts = [[-5, -5], [5, 5]];
  const u0 = Math.min(...pts.map((p) => p[0])) - 1, u1 = Math.max(...pts.map((p) => p[0])) + 1;
  const v0 = Math.min(...pts.map((p) => p[1])) - 1, v1 = Math.max(...pts.map((p) => p[1])) + 1;
  const s = Math.min(w / (u1 - u0), h / (v1 - v0));
  return { a, s, ox: w / 2 - s * (u0 + u1) / 2, oy: h / 2 - s * (v0 + v1) / 2 };
}
const toScreen = (x, z) => { const [u, v] = toPlan(view.a, x, z); return [view.ox + u * view.s, view.oy + v * view.s]; };

function sizeCanvas(c) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return ctx;
}

function drawHeat() {
  if (!A || !A.visits) return;
  const bg = $('heatBg'), hc = $('heat');
  const w = bg.clientWidth, h = bg.clientHeight;
  view = fitView(w, h);
  const ctx = sizeCanvas(bg);
  // plan picture, faint
  const lv = tourJson.map?.levels?.[level];
  const im = lv && planImage(lv.image);
  if (im && im.complete && im.naturalWidth) {
    const [b0, b1, b2, b3] = lv.bounds;
    ctx.globalAlpha = 0.28;
    ctx.drawImage(im, view.ox + b0 * view.s, view.oy + b1 * view.s, (b2 - b0) * view.s, (b3 - b1) * view.s);
    ctx.globalAlpha = 1;
  }
  // rooms
  ctx.lineJoin = 'round';
  for (const r of rooms) {
    if (r.level !== level) continue;
    ctx.beginPath();
    for (const loop of r.loops) { loop.forEach(([u, v], i) => { const x = view.ox + u * view.s, y = view.oy + v * view.s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
    ctx.strokeStyle = 'rgba(244,241,236,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // heat
  const hctx = sizeCanvas(hc);
  const lvY = lv ? [lv.y - 0.3, lv.y + (lv.height || 2.5) + 0.3] : [-1e9, 1e9];
  const blobs = (entries, name, strength = 0.55) => {
    if (!entries.length) return;
    const max = scaleOf(entries.map((e) => e[2]));
    const off = document.createElement('canvas'); off.width = hc.width; off.height = hc.height;
    const o = off.getContext('2d'); const dpr = hc.width / w; o.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = Math.max(6, view.s * CELL * 1.6);
    for (const [x, z, v] of entries) {
      const [sx, sy] = toScreen(x, z);
      const g = o.createRadialGradient(sx, sy, 0, sx, sy, r);
      const a = Math.min(1, v / max) * strength;
      g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      o.fillStyle = g; o.fillRect(sx - r, sy - r, 2 * r, 2 * r);
    }
    const img = o.getImageData(0, 0, off.width, off.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const t = d[i + 3] / 255;
      if (!t) continue;
      const [cr, cg, cb] = ramp(name, Math.min(1, t * 1.25));
      d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = Math.min(255, t * 1.6 * 255) * 0.9;
    }
    o.putImageData(img, 0, 0);
    hctx.save(); hctx.setTransform(1, 0, 0, 1, 0, 0); hctx.drawImage(off, 0, 0); hctx.restore();
  };
  if (layers.look) {
    const e = [];
    for (const [k, v] of A.look) {
      const [ix, iy, iz] = k.split(':').map(Number); const y = (iy + 0.5) * CELL;
      if (y >= lvY[0] && y <= lvY[1]) e.push([(ix + 0.5) * CELL, (iz + 0.5) * CELL, v]);
    }
    blobs(e, 'look', 0.32);
  }
  if (layers.walk) {
    const e = [];
    for (const [k, v] of A.walk) { const [li, ix, iz] = k.split(':').map(Number); if (li === level) e.push([(ix + 0.5) * CELL, (iz + 0.5) * CELL, v]); }
    blobs(e, 'walk');
  }
  if (layers.path) {
    hctx.lineWidth = 1.2; hctx.strokeStyle = 'rgba(244,241,236,.22)'; hctx.lineJoin = 'round';
    for (const v of A.list) {
      hctx.beginPath(); let on = false;
      for (const [, x, z, li] of v.path) {
        if (li !== level) { on = false; continue; }
        const [sx, sy] = toScreen(x, z); on ? hctx.lineTo(sx, sy) : hctx.moveTo(sx, sy); on = true;
      }
      hctx.stroke();
    }
  }
  // room names on top
  hctx.font = '500 12px Inter, system-ui, sans-serif'; hctx.textAlign = 'center'; hctx.textBaseline = 'middle';
  for (const r of rooms) {
    if (r.level !== level || !r.rects.length) continue;
    const big = [...r.rects].sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]))[0];
    const x = view.ox + ((big[0] + big[2]) / 2) * view.s, y = view.oy + ((big[1] + big[3]) / 2) * view.s;
    const tw = hctx.measureText(r.name).width + 14;
    hctx.fillStyle = 'rgba(13,13,14,.75)'; hctx.beginPath(); hctx.roundRect ? hctx.roundRect(x - tw / 2, y - 10, tw, 20, 10) : hctx.rect(x - tw / 2, y - 10, tw, 20); hctx.fill();
    hctx.fillStyle = '#f4f1ec'; hctx.fillText(r.name, x, y + 0.5);
  }
}
new ResizeObserver(() => drawHeat()).observe($('heatWrap'));

// ------------------------------------------------------------------ replay one visit on the plan
let replayRaf = null;
function stopReplay() {
  cancelAnimationFrame(replayRaf); replayRaf = null;
  show('replayBar', false);
  const c = $('heatTop'); sizeCanvas(c);
  document.querySelectorAll('.visit.on').forEach((x) => x.classList.remove('on'));
}
$('replayStop').onclick = stopReplay;
function replay(v) {
  cancelAnimationFrame(replayRaf);
  if (!v.path.length) { toast('Det här besöket har ingen rutt sparad.'); return; }
  show('replayBar');
  const t0 = performance.now(), speed = 8, total = v.path.at(-1)[0];
  const step = (now) => {
    const t = ((now - t0) / 1000) * speed;
    let i = v.path.findIndex((p) => p[0] > t);
    if (i < 0) i = v.path.length;
    const cur = v.path[Math.max(0, i - 1)];
    if (cur[3] !== level) { level = cur[3]; renderLevels(); }
    $('replayText').textContent = `Spelar upp · ${fmtDur(Math.min(t, total))} av ${fmtDur(v.dur)}`;
    const ctx = sizeCanvas($('heatTop'));
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(232,220,199,.9)'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); let on = false;
    for (const [, x, z, li] of v.path.slice(0, i)) {
      if (li !== level) { on = false; continue; }
      const [sx, sy] = toScreen(x, z); on ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); on = true;
    }
    ctx.stroke();
    if (cur[3] === level) {
      const [sx, sy] = toScreen(cur[1], cur[2]);
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(13,13,14,.85)'; ctx.stroke();
    }
    if (t < total + 1.5) replayRaf = requestAnimationFrame(step);
  };
  replayRaf = requestAnimationFrame(step);
}

// ------------------------------------------------------------------ accounts (admin)
const closeModals = () => document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) closeModals(); }));
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

function showPassword(title, text, pw) {
  $('pwTitle').textContent = title; $('pwText').textContent = text; $('pwValue').textContent = pw;
  show('pwModal');
}
$('pwCopy').onclick = async () => { try { await navigator.clipboard.writeText($('pwValue').textContent); toast('Kopierat'); } catch { /* */ } };

let users = [];
async function loadUsers() {
  users = (await api('/api/users')).users;
  const tourName = (t) => (t === '*' ? 'alla visningar' : titles[t] || t);
  $('userList').innerHTML = users.map((u, i) => `<div class="user">
    <div class="who2">${esc(u.name || u.email)}<small>${esc(u.email)} · ${u.role === 'admin' ? 'administratör' : esc(u.tours.map(tourName).join(', ') || 'inga visningar')}</small></div>
    <button class="btn small ghost" data-edit="${i}">Ändra</button>
    <button class="btn small ghost" data-reset="${i}">Nytt lösenord</button>
    ${u.email === me.email ? '' : `<button class="btn small ghost danger" data-del="${i}">Ta bort</button>`}</div>`).join('');
  fillTourChips([]);
}
function fillTourChips(selected) {
  const ids = [...new Set([...tours.map((t) => t.tour), ...users.flatMap((u) => u.tours).filter((t) => t !== '*')])];
  $('uTours').innerHTML = ids.map((id) => `<label><input type="checkbox" value="${esc(id)}" ${selected.includes(id) ? 'checked' : ''}>${esc(titles[id] || id)}</label>`).join('')
    + '<label><input type="text" id="uTourNew" placeholder="länknamn, t.ex. villa-ekbacken" style="border:0;background:transparent;padding:0;min-width:200px"></label>';
}
$('usersBtn').onclick = async () => { show('users'); resetUserForm(); await loadUsers(); };
$('uRole').onchange = () => show('uToursWrap', $('uRole').value === 'broker');
function resetUserForm() {
  $('userForm').reset(); $('uEmail').readOnly = false; $('uMsg').textContent = '';
  $('userForm').querySelector('h3').textContent = 'Lägg till konto';
  $('userForm').querySelector('button[type=submit]').textContent = 'Skapa konto';
  show('uToursWrap', true);
}
$('userList').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const u = users[Number(b.dataset.edit ?? b.dataset.reset ?? b.dataset.del)];
  if (b.dataset.edit !== undefined) {
    $('uName').value = u.name || ''; $('uEmail').value = u.email; $('uEmail').readOnly = true; $('uRole').value = u.role;
    show('uToursWrap', u.role === 'broker'); fillTourChips(u.tours);
    $('userForm').querySelector('h3').textContent = `Ändra ${u.name || u.email}`;
    $('userForm').querySelector('button[type=submit]').textContent = 'Spara';
  } else if (b.dataset.reset !== undefined) {
    if (!confirm(`Skapa ett nytt lösenord för ${u.email}? Det gamla slutar fungera.`)) return;
    const r = await api('/api/users/reset', { method: 'POST', body: { email: u.email } });
    showPassword('Nytt lösenord', `Skicka det här till ${u.email}. Det visas bara nu.`, r.password);
  } else if (b.dataset.del !== undefined) {
    if (!confirm(`Ta bort kontot ${u.email}?`)) return;
    await api(`/api/users?email=${encodeURIComponent(u.email)}`, { method: 'DELETE' });
    loadUsers();
  }
};
$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('uMsg').textContent = '';
  const picked = [...$('uTours').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
  const typed = ($('uTourNew')?.value || '').trim().toLowerCase();
  if (typed) picked.push(...typed.split(/[\s,]+/).filter(Boolean));
  try {
    const r = await api('/api/users', { method: 'POST', body: { email: $('uEmail').value, name: $('uName').value, role: $('uRole').value, tours: picked } });
    await loadUsers(); resetUserForm();
    if (r.password) showPassword('Konto skapat', 'Skicka e-postadressen, lösenordet och länken till den här sidan. Lösenordet visas bara nu.', r.password);
    else toast('Sparat');
  } catch (err) { $('uMsg').textContent = err.message; }
});

// change my own password
$('who').onclick = () => {
  const pw = prompt('Nytt lösenord (minst 10 tecken):');
  if (!pw) return;
  api('/api/me/password', { method: 'POST', body: { password: pw } })
    .then((r) => { setToken(r.token); toast('Lösenordet är bytt'); })
    .catch((e) => toast(e.message));
};

boot();
