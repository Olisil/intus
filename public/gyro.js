// Look around by turning the phone ("magic window"): device orientation -> camera rotation.
// Same maths as three.js DeviceOrientationControls. Camera space: +Y up, looking down -Z.

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisAngle = (x, y, z, ang) => { const s = Math.sin(ang / 2); return [x * s, y * s, z * s, Math.cos(ang / 2)]; };
const Q1 = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];   // look out of the back of the phone, not out of its top

function deviceQuat(alpha, beta, gamma, orient) {
  const x = beta / 2, y = alpha / 2, z = -gamma / 2;   // euler YXZ
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
  q = qmul(q, Q1);
  return qmul(q, axisAngle(0, 0, 1, -orient));
}

// forward (0,0,-1) rotated by q -> viewer yaw/pitch in degrees (forward = (-sin yaw, sin pitch, -cos yaw))
export function yawPitchOf(q) {
  const [x, y, z, w] = q;
  const fx = -(2 * (x * z + w * y)), fy = -(2 * (y * z - w * x)), fz = -(1 - 2 * (x * x + y * y));
  return { yaw: (Math.atan2(-fx, -fz) * 180) / Math.PI, pitch: (Math.asin(Math.max(-1, Math.min(1, fy))) * 180) / Math.PI };
}

export class Gyro {
  constructor() {
    this.on = false; this.raw = null; this.q = null; this.offset = 0; this.last = 0;
    this._h = (e) => {
      if (e.alpha === null || e.beta === null) return;
      const d = Math.PI / 180;
      const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * d;
      this.raw = deviceQuat(e.alpha * d, e.beta * d, e.gamma * d, orient);
      this.last = performance.now();
    };
  }

  static get supported() { return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window; }

  // must run inside a tap on iPhone (permission prompt)
  async enable(currentYaw) {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const r = await DOE.requestPermission().catch(() => 'denied');
      if (r !== 'granted') throw new Error('denied');
    }
    window.addEventListener('deviceorientation', this._h);
    // wait for a first reading, so phones without a gyroscope say so instead of doing nothing
    const t0 = performance.now();
    while (!this.raw && performance.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 50));
    if (!this.raw) { this.disable(); throw new Error('none'); }
    this.q = this.raw.slice();
    // keep looking the way you were looking when you switch it on
    this.offset = ((currentYaw - yawPitchOf(this.q).yaw) * Math.PI) / 180;
    this.on = true;
  }

  disable() {
    window.removeEventListener('deviceorientation', this._h);
    this.on = false; this.raw = null; this.q = null;
  }

  // look this way now (after jumping to a room, say), whichever way the phone points
  setYaw(deg) { if (this.q) this.offset = ((deg - yawPitchOf(this.q).yaw) * Math.PI) / 180; }

  turn(deg) { this.offset += (deg * Math.PI) / 180; }   // swipe sideways still turns you around

  // camera rotation for this frame (smoothed a little against sensor jitter)
  frame(dt) {
    if (!this.on || !this.raw) return null;
    const k = 1 - Math.exp(-dt * 30);
    let r = this.raw;
    if (this.q[0] * r[0] + this.q[1] * r[1] + this.q[2] * r[2] + this.q[3] * r[3] < 0) r = r.map((v) => -v);
    const q = this.q.map((v, i) => v + (r[i] - v) * k);
    const n = Math.hypot(...q);
    this.q = q.map((v) => v / n);
    return qmul(axisAngle(0, 1, 0, this.offset), this.q);
  }
}
