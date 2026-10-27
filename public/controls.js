// On-screen movement controls: WASD keys with arrows (desktop) and a joystick with arrows (touch).
// Outline drawings; each direction lights up while you move that way (class "on" on [data-dir]).

const NS = 'http://www.w3.org/2000/svg';
const f = (n) => +n.toFixed(2);

// A rounded key with a hollow arrow growing out of one side, as one outline.
function keyPath(x, y, w, h, r, dir, { s = 9, l1 = 12, hw = 22, l2 = 20 } = {}) {
  // corners clockwise from top-left; the arrow is inserted on its side
  const cx = x + w / 2, cy = y + h / 2;
  const P = [];
  const M = (a, b) => P.push(`M${f(a)} ${f(b)}`), L = (a, b) => P.push(`L${f(a)} ${f(b)}`);
  const Q = (a, b, c, d) => P.push(`Q${f(a)} ${f(b)} ${f(c)} ${f(d)}`);
  M(x + r, y);
  if (dir === 'f') { L(cx - s, y); L(cx - s, y - l1); L(cx - hw, y - l1); L(cx, y - l1 - l2); L(cx + hw, y - l1); L(cx + s, y - l1); L(cx + s, y); }
  L(x + w - r, y); Q(x + w, y, x + w, y + r);
  if (dir === 'r') { L(x + w, cy - s); L(x + w + l1, cy - s); L(x + w + l1, cy - hw); L(x + w + l1 + l2, cy); L(x + w + l1, cy + hw); L(x + w + l1, cy + s); L(x + w, cy + s); }
  L(x + w, y + h - r); Q(x + w, y + h, x + w - r, y + h);
  if (dir === 'b') { L(cx + s, y + h); L(cx + s, y + h + l1); L(cx + hw, y + h + l1); L(cx, y + h + l1 + l2); L(cx - hw, y + h + l1); L(cx - s, y + h + l1); L(cx - s, y + h); }
  L(x + r, y + h); Q(x, y + h, x, y + h - r);
  if (dir === 'l') { L(x, cy + s); L(x - l1, cy + s); L(x - l1, cy + hw); L(x - l1 - l2, cy); L(x - l1, cy - hw); L(x - l1, cy - s); L(x, cy - s); }
  L(x, y + r); Q(x, y, x + r, y);
  P.push('Z');
  return P.join(' ');
}

const tri = (cx, cy, dir, k = 5.5) => {
  const pts = { f: [[0, -k], [k, k * 0.8], [-k, k * 0.8]], b: [[0, k], [k, -k * 0.8], [-k, -k * 0.8]],
    l: [[-k, 0], [k * 0.8, -k], [k * 0.8, k]], r: [[k, 0], [-k * 0.8, -k], [-k * 0.8, k]] }[dir];
  return `M${pts.map(([a, b]) => `${f(cx + a)} ${f(cy + b)}`).join(' L')} Z`;
};

export function buildKeypad(el) {
  const W = 84, H = 70, G = 12, A = 34;           // key size, gap, arrow reach
  const keys = [
    { dir: 'f', key: 'W', x: A + W + G, y: A },
    { dir: 'l', key: 'A', x: A, y: A + H + G },
    { dir: 'b', key: 'S', x: A + W + G, y: A + H + G },
    { dir: 'r', key: 'D', x: A + 2 * (W + G), y: A + H + G },
  ];
  const vw = 3 * W + 2 * G + 2 * A, vh = 2 * H + G + 2 * A;
  el.innerHTML = `<svg viewBox="0 0 ${vw} ${vh}" xmlns="${NS}">${keys.map((k) => {
    const cy = k.y + H / 2 + 1;
    return `<g class="key" data-dir="${k.dir}">
      <path class="shape" d="${keyPath(k.x, k.y, W, H, 13, k.dir)}"/>
      <text x="${f(k.x + W / 2 - 9)}" y="${f(cy)}" text-anchor="middle" dominant-baseline="central">${k.key} /</text>
      <path class="tri" d="${tri(k.x + W / 2 + 15, cy, k.dir)}"/>
    </g>`;
  }).join('')}</svg>`;
}

// Joystick: a ring with four hollow arrows, drawn as one outline; arrow fills light up.
export function buildStick(el, size = 132) {
  const c = size / 2, R = 25, s = 6, hw = 14, tipR = c - 3, headR = tipR - 15;
  const ang = { f: -Math.PI / 2, r: 0, b: Math.PI / 2, l: Math.PI };
  const order = ['f', 'r', 'b', 'l'];
  // point at distance d along direction a, offset o sideways
  const pt = (a, d, o) => [c + Math.cos(a) * d - Math.sin(a) * o, c + Math.sin(a) * d + Math.cos(a) * o];
  const yIn = Math.sqrt(R * R - s * s);
  let d = '';
  order.forEach((k, i) => {
    const a = ang[k];
    const p = [pt(a, yIn, -s), pt(a, headR, -s), pt(a, headR, -hw), pt(a, tipR, 0), pt(a, headR, hw), pt(a, headR, s), pt(a, yIn, s)];
    d += (i ? 'L' : 'M') + p.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L');
    // arc along the ring to the next arrow
    const n = ang[order[(i + 1) % 4]];
    const [ex, ey] = pt(n, yIn, -s);
    d += ` A${R} ${R} 0 0 1 ${f(ex)} ${f(ey)} `;
  });
  d += 'Z';
  const fills = order.map((k) => {
    const a = ang[k];
    const p = [pt(a, R - 2, -s), pt(a, headR, -s), pt(a, headR, -hw), pt(a, tipR, 0), pt(a, headR, hw), pt(a, headR, s), pt(a, R - 2, s)];
    return `<path class="fill" data-dir="${k}" d="M${p.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z"/>`;
  }).join('');
  const svg = `<svg class="stick-art" viewBox="0 0 ${size} ${size}" xmlns="${NS}">
    <circle class="ring-bg" cx="${c}" cy="${c}" r="${R}"/>${fills}<path class="outline" d="${d}"/></svg>`;
  el.insertAdjacentHTML('afterbegin', svg);
}
