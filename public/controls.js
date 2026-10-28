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

export const PHONE_FLIP = '<svg viewBox="0 0 38 38" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M26.125 2.375H11.875C11.2451 2.375 10.641 2.62522 10.1956 3.07062C9.75022 3.51602 9.5 4.12011 9.5 4.75V19C9.5 19.3149 9.37489 19.617 9.15219 19.8397C8.92949 20.0624 8.62744 20.1875 8.3125 20.1875C7.99756 20.1875 7.69551 20.0624 7.47281 19.8397C7.25011 19.617 7.125 19.3149 7.125 19V4.75C7.125 3.49022 7.62544 2.28204 8.51624 1.39124C9.40704 0.500445 10.6152 0 11.875 0L26.125 0C27.3848 0 28.593 0.500445 29.4838 1.39124C30.3746 2.28204 30.875 3.49022 30.875 4.75V19C30.875 19.3149 30.7499 19.617 30.5272 19.8397C30.3045 20.0624 30.0024 20.1875 29.6875 20.1875C29.3726 20.1875 29.0705 20.0624 28.8478 19.8397C28.6251 19.617 28.5 19.3149 28.5 19V4.75C28.5 4.12011 28.2498 3.51602 27.8044 3.07062C27.359 2.62522 26.7549 2.375 26.125 2.375ZM28.5 33.25C28.5 33.8799 28.2498 34.484 27.8044 34.9294C27.359 35.3748 26.7549 35.625 26.125 35.625H11.875C11.2451 35.625 10.641 35.3748 10.1956 34.9294C9.75022 34.484 9.5 33.8799 9.5 33.25V28.5C9.5 28.1851 9.37489 27.883 9.15219 27.6603C8.92949 27.4376 8.62744 27.3125 8.3125 27.3125C7.99756 27.3125 7.69551 27.4376 7.47281 27.6603C7.25011 27.883 7.125 28.1851 7.125 28.5V33.25C7.125 34.5098 7.62544 35.718 8.51624 36.6088C9.40704 37.4996 10.6152 38 11.875 38H26.125C27.3848 38 28.593 37.4996 29.4838 36.6088C30.3746 35.718 30.875 34.5098 30.875 33.25V28.5C30.875 28.1851 30.7499 27.883 30.5272 27.6603C30.3045 27.4376 30.0024 27.3125 29.6875 27.3125C29.3726 27.3125 29.0705 27.4376 28.8478 27.6603C28.6251 27.883 28.5 28.1851 28.5 28.5V33.25ZM4.06838 18.8908C4.35434 18.7588 4.57618 18.5186 4.68508 18.2231C4.79398 17.9276 4.78102 17.6009 4.64906 17.3149C4.58372 17.1733 4.49113 17.046 4.37658 16.9402C4.26202 16.8344 4.12775 16.7522 3.98142 16.6982C3.6859 16.5893 3.35922 16.6023 3.07325 16.7342C2.24913 17.1143 1.52 17.5608 0.9785 18.088C0.437 18.6248 0 19.3301 0 20.1875C0 21.4842 0.969 22.42 1.95463 23.0399C2.99962 23.7001 4.43175 24.2511 6.099 24.6929C9.44775 25.5859 14.0077 26.125 19 26.125C19.2343 26.125 19.4671 26.1234 19.6982 26.1203L16.9718 28.8468C16.8613 28.9572 16.7738 29.0882 16.714 29.2325C16.6543 29.3767 16.6235 29.5314 16.6235 29.6875C16.6235 29.8436 16.6543 29.9983 16.714 30.1425C16.7738 30.2868 16.8613 30.4178 16.9718 30.5282C17.1947 30.7512 17.4972 30.8765 17.8125 30.8765C17.9686 30.8765 18.1233 30.8457 18.2675 30.786C18.4118 30.7262 18.5428 30.6387 18.6532 30.5282L23.4032 25.7782C23.5138 25.6679 23.6016 25.5369 23.6614 25.3926C23.7213 25.2484 23.7521 25.0937 23.7521 24.9375C23.7521 24.7813 23.7213 24.6266 23.6614 24.4824C23.6016 24.3381 23.5138 24.2071 23.4032 24.0968L18.6532 19.3468C18.5428 19.2363 18.4118 19.1488 18.2675 19.089C18.1233 19.0293 17.9686 18.9985 17.8125 18.9985C17.6564 18.9985 17.5017 19.0293 17.3575 19.089C17.2132 19.1488 17.0822 19.2363 16.9718 19.3468C16.8613 19.4572 16.7738 19.5882 16.714 19.7325C16.6543 19.8767 16.6235 20.0314 16.6235 20.1875C16.6235 20.3436 16.6543 20.4983 16.714 20.6425C16.7738 20.7868 16.8613 20.9178 16.9718 21.0282L19.6911 23.7453L19 23.75C14.155 23.75 9.80875 23.2251 6.71175 22.3986C5.15375 21.983 3.97812 21.5104 3.2205 21.033C2.4035 20.5176 2.375 20.2017 2.375 20.1875C2.375 20.1804 2.375 20.0474 2.641 19.7838C2.91412 19.5177 3.37725 19.209 4.066 18.8908H4.06838ZM34.9268 16.7342C34.6408 16.6023 34.3141 16.5893 34.0186 16.6982C33.7231 16.8071 33.4829 17.029 33.3509 17.3149C33.219 17.6009 33.206 17.9276 33.3149 18.2231C33.4238 18.5186 33.6457 18.7588 33.9316 18.8908C34.6251 19.209 35.0859 19.5178 35.3566 19.7861C35.625 20.0474 35.625 20.1804 35.625 20.1875C35.625 20.1946 35.625 20.3419 35.3162 20.6316C35.0028 20.9214 34.4803 21.2491 33.7084 21.5816C32.1765 22.2466 29.9179 22.8237 27.1463 23.2133C26.8387 23.2622 26.5627 23.4299 26.3777 23.6804C26.1927 23.9309 26.1135 24.244 26.1571 24.5523C26.2007 24.8606 26.3636 25.1394 26.6108 25.3288C26.858 25.5181 27.1697 25.6028 27.4787 25.5645C30.3573 25.1607 32.8462 24.5432 34.6512 23.7642C35.5537 23.3747 36.3446 22.9164 36.9313 22.3701C37.5155 21.8263 38 21.0947 38 20.1875C38 19.3277 37.563 18.62 37.0215 18.0904C36.48 17.5608 35.7509 17.1143 34.9268 16.7342ZM17.8125 4.75C17.4976 4.75 17.1955 4.87511 16.9728 5.09781C16.7501 5.32051 16.625 5.62256 16.625 5.9375C16.625 6.25244 16.7501 6.55449 16.9728 6.77719C17.1955 6.99989 17.4976 7.125 17.8125 7.125H20.1875C20.5024 7.125 20.8045 6.99989 21.0272 6.77719C21.2499 6.55449 21.375 6.25244 21.375 5.9375C21.375 5.62256 21.2499 5.32051 21.0272 5.09781C20.8045 4.87511 20.5024 4.75 20.1875 4.75H17.8125Z"/></svg>';

export function keypadSVG({ arrows = true } = {}) {
  const W = 84, H = 70, G = 12, A = 34;           // key size, gap, arrow reach
  const keys = [
    { dir: 'f', key: 'W', x: A + W + G, y: A },
    { dir: 'l', key: 'A', x: A, y: A + H + G },
    { dir: 'b', key: 'S', x: A + W + G, y: A + H + G },
    { dir: 'r', key: 'D', x: A + 2 * (W + G), y: A + H + G },
  ];
  const vw = 3 * W + 2 * G + 2 * A, vh = 2 * H + G + 2 * A;
  return `<svg viewBox="0 0 ${vw} ${vh}" xmlns="${NS}">${keys.map((k) => {
    const cy = k.y + H / 2 + 1;
    return `<g class="key" data-dir="${k.dir}">
      <path class="shape" d="${keyPath(k.x, k.y, W, H, 13, k.dir)}"/>
      ${arrows ? `<text x="${f(k.x + W / 2 - 9)}" y="${f(cy)}" text-anchor="middle" dominant-baseline="central">${k.key} /</text>
      <path class="tri" d="${tri(k.x + W / 2 + 15, cy, k.dir)}"/>`
    : `<text x="${f(k.x + W / 2)}" y="${f(cy)}" text-anchor="middle" dominant-baseline="central">${k.key}</text>`}
    </g>`;
  }).join('')}</svg>`;
}

export function buildKeypad(el) { el.innerHTML = keypadSVG(); }

// Joystick: a ring with four hollow arrows, drawn as one outline; arrow fills light up.
export function stickSVG(size = 132, knob = false) {
  const c = size / 2, R = size * 0.19, s = size * 0.045, hw = size * 0.106, tipR = c - 3, headR = tipR - size * 0.114;
  const ang = { f: -Math.PI / 2, r: 0, b: Math.PI / 2, l: Math.PI };
  const order = ['f', 'r', 'b', 'l'];
  const pt = (a, d, o) => [c + Math.cos(a) * d - Math.sin(a) * o, c + Math.sin(a) * d + Math.cos(a) * o];
  const yIn = Math.sqrt(R * R - s * s);
  let d = '';
  order.forEach((k, i) => {
    const a = ang[k];
    const p = [pt(a, yIn, -s), pt(a, headR, -s), pt(a, headR, -hw), pt(a, tipR, 0), pt(a, headR, hw), pt(a, headR, s), pt(a, yIn, s)];
    d += (i ? 'L' : 'M') + p.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L');
    const n = ang[order[(i + 1) % 4]];
    const [ex, ey] = pt(n, yIn, -s);
    d += ` A${f(R)} ${f(R)} 0 0 1 ${f(ex)} ${f(ey)} `;
  });
  d += 'Z';
  const fills = order.map((k) => {
    const a = ang[k];
    const p = [pt(a, R - 2, -s), pt(a, headR, -s), pt(a, headR, -hw), pt(a, tipR, 0), pt(a, headR, hw), pt(a, headR, s), pt(a, R - 2, s)];
    return `<path class="fill" data-dir="${k}" d="M${p.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z"/>`;
  }).join('');
  return `<svg class="stick-art" viewBox="0 0 ${size} ${size}" xmlns="${NS}">
    <circle class="ring-bg" cx="${c}" cy="${c}" r="${f(R)}"/>${fills}<path class="outline" d="${d}"/>
    ${knob ? `<circle class="knob" cx="${c}" cy="${c}" r="${f(R * 0.62)}"/>` : ''}</svg>`;
}

export function buildStick(el, size = 132) { el.insertAdjacentHTML('afterbegin', stickSVG(size)); }

// Start screen: how to move, as pictures with one word each
const MOUSE = `<svg viewBox="0 0 64 64" xmlns="${NS}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="22" y="8" width="20" height="32" rx="10"/><path d="M32 13v6"/>
  <path d="M10 52h44M16 46l-6 6 6 6M48 46l6 6-6 6"/></svg>`;
const SWIPE = `<svg viewBox="0 0 64 64" xmlns="${NS}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="32" cy="24" r="8"/><circle cx="32" cy="24" r="14" stroke-opacity=".35"/>
  <path d="M10 52h44M16 46l-6 6 6 6M48 46l6 6-6 6"/></svg>`;
const ESC = `<svg viewBox="0 0 64 64" xmlns="${NS}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round">
  <rect x="10" y="16" width="44" height="32" rx="9"/><text x="32" y="33" fill="currentColor" stroke="none" text-anchor="middle" dominant-baseline="central"
  font-family="Inter, system-ui, sans-serif" font-weight="500" font-size="15">Esc</text></svg>`;

export function howToHTML({ touch, gyro, T }) {
  const tile = (art, word, cls = '') => `<div class="how-tile ${cls}"><div class="how-art">${art}</div><span>${word}</span></div>`;
  return touch
    ? tile(stickSVG(132, true), T.move, 'stick') + tile(SWIPE, T.lookShort) + (gyro ? tile(PHONE_FLIP, T.tilt, 'flip') : '')
    : tile(keypadSVG({ arrows: false }), T.move, 'wasd') + tile(MOUSE, T.lookShort) + tile(ESC, T.exit);
}
