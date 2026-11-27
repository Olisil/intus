"""
Floor plan for a walkable splat tour: storeys, a top-down picture of each storey, and a first guess
at the rooms. Everything is in tour space (metres, +Y up).

The plan frame is the tour frame turned about +Y so the house's walls run along the axes:
    u = cos(a) * x - sin(a) * z
    v = sin(a) * x + cos(a) * z          (a = map["angle"], radians)
Rooms are unions of axis-aligned rectangles [u0, v0, u1, v1] in that frame, so they are easy to
draw, edit and test ("which room am I in") anywhere: converter, studio and viewer.
"""
from __future__ import annotations

import heapq
import io
import math

import numpy as np
from scipy import ndimage

C0 = 0.28209479177387814  # SH band-0 constant


def _quat_to_mats(q):
    w, x, y, z = (q / np.linalg.norm(q, axis=1, keepdims=True)).T
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1),
    ], 1)


def storey_levels(feet):
    """Floor heights shared by many path positions (same rule as the collision builder)."""
    fy = np.asarray(feet)[:, 1]
    vals, counts = np.unique(np.round(fy / 0.05) * 0.05, return_counts=True)
    levels = []
    for v, c in sorted(zip(vals, counts), key=lambda t: -t[1]):
        if c >= max(5, 0.05 * len(fy)) and all(abs(v - L) > 0.5 for L in levels):
            levels.append(float(v))
    return sorted(levels)


class Splats:
    """The splat cloud, reduced to what the plan needs, with a cached per-splat orientation."""

    def __init__(self, xyz, opacity, scales, quats, dc=None):
        m = (opacity > 0.2) & (scales.max(1) < 2.5)
        self.xyz, self.op, self.sc, self.q = xyz[m], opacity[m], scales[m], quats[m]
        self.R = _quat_to_mats(self.q)
        ax = np.argmin(self.sc, 1)
        self.normal = self.R[np.arange(len(self.sc)), :, ax]
        self.color = None
        if dc is not None:
            self.color = np.clip(0.5 + C0 * dc[m], 0, 1)

    def samples(self, n=6, seed=0):
        """n random points inside each splat (1-sigma box), with the splat's index."""
        rng = np.random.default_rng(seed)
        for _ in range(n):
            local = rng.uniform(-1, 1, (len(self.xyz), 3)) * self.sc
            yield self.xyz + np.einsum("nij,nj->ni", self.R, local)


def wall_angle(spl: Splats, levels, cell=0.05):
    """Direction the walls run (radians, 0..pi/2), from where vertical surfaces are."""
    pts = spl.xyz
    vert = np.abs(spl.normal[:, 1]) < 0.35
    hist = np.zeros(90)
    for L in levels:
        m = vert & (pts[:, 1] > L + 0.8) & (pts[:, 1] < L + 2.0) & (spl.op > 0.3)
        if m.sum() < 50:
            continue
        n = spl.normal[m][:, [0, 2]]
        a = np.arctan2(n[:, 1], n[:, 0]) % (math.pi / 2)
        w = spl.op[m] * np.prod(np.sort(spl.sc[m], 1)[:, 1:], 1)  # surface area
        h, _ = np.histogram(a, bins=90, range=(0, math.pi / 2), weights=w)
        hist += h
    if not hist.any():
        return 0.0
    k = np.r_[hist[-3:], hist, hist[:3]]
    k = np.convolve(k, np.ones(5) / 5, "same")[3:-3]
    i = int(np.argmax(k))
    # rotate the dominant wall normal onto the u axis (to_plan turns by -angle)
    return -((i + 0.5) * (math.pi / 2) / 90)


def to_plan(a, x, z):
    c, s = math.cos(a), math.sin(a)
    return c * x - s * z, s * x + c * z


def from_plan(a, u, v):
    c, s = math.cos(a), math.sin(a)
    return c * u + s * v, -s * u + c * v


class Grid:
    def __init__(self, u0, v0, u1, v1, cell):
        self.u0, self.v0, self.cell = u0, v0, cell
        self.shape = (int(math.ceil((u1 - u0) / cell)), int(math.ceil((v1 - v0) / cell)))

    def idx(self, u, v):
        i = np.floor((np.asarray(u) - self.u0) / self.cell).astype(int)
        k = np.floor((np.asarray(v) - self.v0) / self.cell).astype(int)
        ok = (i >= 0) & (i < self.shape[0]) & (k >= 0) & (k < self.shape[1])
        return i, k, ok

    def center(self, i, k):
        return self.u0 + (i + 0.5) * self.cell, self.v0 + (k + 0.5) * self.cell


def band_density(spl: Splats, a, grid: Grid, y0, y1, vertical_weight=1.0, other_weight=0.25):
    dens = np.zeros(grid.shape)
    w = np.where(np.abs(spl.normal[:, 1]) < 0.4, vertical_weight, other_weight) * spl.op
    sel = (spl.xyz[:, 1] > y0 - 1.0) & (spl.xyz[:, 1] < y1 + 1.0)
    for p in spl.samples():
        ok = sel & (p[:, 1] > y0) & (p[:, 1] < y1)
        u, v = to_plan(a, p[ok, 0], p[ok, 2])
        i, k, g = grid.idx(u, v)
        np.add.at(dens, (i[g], k[g]), w[ok][g])
    return dens / 6 / max(0.1, y1 - y0)


def floor_evidence(spl: Splats, a, grid: Grid, L):
    """Cells with a floor surface at height L (flat splats spread over their footprint)."""
    has = np.zeros(grid.shape, bool)
    flat = (np.abs(spl.normal[:, 1]) > 0.7) & (np.abs(spl.xyz[:, 1] - L) < 0.25)
    if not flat.any():
        return has
    sel = np.nonzero(flat)[0]
    rng = np.random.default_rng(5)
    for _ in range(8):
        local = rng.uniform(-1, 1, (len(sel), 3)) * spl.sc[sel]
        p = spl.xyz[sel] + np.einsum("nij,nj->ni", spl.R[sel], local)
        ok = np.abs(p[:, 1] - L) < 0.12
        u, v = to_plan(a, p[ok, 0], p[ok, 2])
        i, k, g = grid.idx(u, v)
        has[i[g], k[g]] = True
    return ndimage.binary_closing(has, structure=np.ones((3, 3)), iterations=4, border_value=1)


def render_plan(spl: Splats, a, grid: Grid, L, top):
    """Top-down picture of one storey (floor up to `top`), as RGBA uint8 (u along x, v along y)."""
    if spl.color is None:
        return None
    sel = np.nonzero((spl.xyz[:, 1] > L - 0.15) & (spl.xyz[:, 1] < top) & (spl.op > 0.3))[0]
    if not len(sel):
        return None
    img = np.zeros(grid.shape + (3,), np.float32)
    zbuf = np.full(grid.shape, -1e9)
    # big splats need many samples to cover their footprint, small ones a few
    sc = np.sort(spl.sc[sel], 1)
    need = np.clip((sc[:, 1] * sc[:, 2] * 9) / (grid.cell ** 2), 4, 256)
    rng = np.random.default_rng(3)
    for lo_n, hi_n in ((0, 8), (8, 32), (32, 96), (96, 1e9)):
        part = sel[(need > lo_n) & (need <= hi_n)]
        if not len(part):
            continue
        n = int(min(256, max(4, need[(need > lo_n) & (need <= hi_n)].max())))
        P, S, R, col = spl.xyz[part], spl.sc[part], spl.R[part], spl.color[part]
        for _ in range(n):
            local = np.clip(rng.standard_normal((len(part), 3)), -1.6, 1.6) * S
            p = P + np.einsum("nij,nj->ni", R, local)
            ok = (p[:, 1] > L - 0.15) & (p[:, 1] < top)
            u, v = to_plan(a, p[ok, 0], p[ok, 2])
            i, k, g = grid.idx(u, v)
            ii, kk, y, c = i[g], k[g], p[ok, 1][g], col[ok][g]
            o = np.argsort(y, kind="stable")  # numpy keeps the last write: highest wins
            ii, kk, y, c = ii[o], kk[o], y[o], c[o]
            better = y > zbuf[ii, kk]
            zbuf[ii[better], kk[better]] = y[better]
            img[ii[better], kk[better]] = c[better]
    alpha = (zbuf > -1e8).astype(np.float32)
    holes = ndimage.binary_closing(alpha > 0, iterations=3) & ~(alpha > 0)
    if holes.any():  # fill pinholes with the neighbourhood colour
        den = ndimage.uniform_filter(alpha, 7)
        for c in range(3):
            num = ndimage.uniform_filter(img[..., c] * alpha, 7)
            img[..., c][holes] = (num / np.maximum(den, 1e-6))[holes]
        alpha[holes] = 1
    # light shading by height gives the picture depth (floors a bit darker than table tops)
    h = np.clip((zbuf - L) / max(0.5, top - L), 0, 1)
    img *= (0.8 + 0.2 * h)[..., None]
    out = np.concatenate([img, alpha[..., None]], -1)
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


def encode_image(rgba):
    """WebP if Pillow can, else PNG. Returns (bytes, extension)."""
    try:
        from PIL import Image
        im = Image.fromarray(np.ascontiguousarray(np.transpose(rgba, (1, 0, 2))), "RGBA")
        buf = io.BytesIO()
        try:
            im.save(buf, "WEBP", quality=82, method=5)
            return buf.getvalue(), "webp"
        except Exception:
            buf = io.BytesIO()
            im.save(buf, "PNG", optimize=True)
            return buf.getvalue(), "png"
    except ImportError:
        import struct
        import zlib
        a = np.ascontiguousarray(np.transpose(rgba, (1, 0, 2)))
        raw = b"".join(b"\0" + a[r].tobytes() for r in range(a.shape[0]))

        def chunk(t, d):
            return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", a.shape[1], a.shape[0], 8, 6, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
        return png, "png"


# ------------------------------------------------------------------ rooms
def _watershed(cost, markers, mask):
    """Grow labelled markers over `mask` in order of increasing cost (4-neighbour priority flood)."""
    lab = markers.copy()
    h = []
    nx, nz = mask.shape
    for i, k in zip(*np.nonzero(lab)):
        heapq.heappush(h, (cost[i, k], i, k))
    while h:
        c, i, k = heapq.heappop(h)
        l = lab[i, k]
        for di, dk in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = i + di, k + dk
            if 0 <= a < nx and 0 <= b < nz and mask[a, b] and not lab[a, b]:
                lab[a, b] = l
                heapq.heappush(h, (max(c, cost[a, b]), a, b))
    return lab


def _largest_rect(left):
    """Largest all-true rectangle in a boolean grid: (area, (i0, k0, i1, k1))."""
    best, bbox = 0, None
    hgt = np.zeros(left.shape[1], int)
    for i in range(left.shape[0]):
        hgt = np.where(left[i], hgt + 1, 0)
        st = []
        for k in range(len(hgt) + 1):
            cur = hgt[k] if k < len(hgt) else 0
            start = k
            while st and st[-1][1] >= cur:
                s0, h0 = st.pop()
                if h0 * (k - s0) > best:
                    best, bbox = h0 * (k - s0), (i - h0 + 1, s0, i + 1, k)
                start = s0
            st.append((start, cur))
    return best, bbox


def _rects(mask, cell, min_side=0.5, cover=0.94, max_rects=6):
    """Cover a region with a few axis-aligned rectangles (largest first). Returns grid boxes."""
    ii, kk = np.nonzero(mask)
    if not len(ii):
        return []
    oi, ok_ = ii.min(), kk.min()
    left = mask[oi:ii.max() + 1, ok_:kk.max() + 1].copy()
    total = left.sum()
    out = []
    while left.sum() > (1 - cover) * total and len(out) < max_rects:
        area, bbox = _largest_rect(left)
        if not bbox:
            break
        i0, k0, i1, k1 = bbox
        if out and (min(i1 - i0, k1 - k0) * cell < min_side or area * cell * cell < 0.6):
            break
        out.append((i0 + oi, k0 + ok_, i1 + oi, k1 + ok_))
        left[i0:i1, k0:k1] = False
    return out


def detect_rooms(spl: Splats, a, grid: Grid, L, feet_level, log=print):
    """Label map of rooms on one storey (0 = not a room)."""
    cell = grid.cell
    walls = band_density(spl, a, grid, L + 1.2, L + 1.95)        # above furniture, below door heads
    low = band_density(spl, a, grid, L + 0.25, L + 2.1)          # anything you'd bump into
    nz_ = walls[walls > 0]
    t_wall = max(np.percentile(nz_, 90) * 0.35, 1e-3) if len(nz_) else 1.0
    nl = low[low > 0]
    t_low = max(np.percentile(nl, 90) * 0.35, 1e-3) if len(nl) else 1.0
    W = walls > t_wall
    W = ndimage.binary_opening(W, structure=np.ones((2, 2)))  # drop single specks
    # walls run along the axes in this frame: keep straight pieces (>= 30 cm) and close the gaps
    # between pieces in line with each other up to a door's width, so doorways (and glass doors
    # to a terrace) separate rooms on the map. Walking is not affected - this is only the plan.
    seg = int(round(0.3 / cell))
    door = int(round(1.0 / cell))
    lines = np.zeros_like(W)
    for st_open, st_close in ((np.ones((seg, 1)), np.ones((door, 1))), (np.ones((1, seg)), np.ones((1, door)))):
        piece = ndimage.binary_opening(W, structure=st_open)
        lines |= ndimage.binary_closing(piece, structure=st_close)
    W = W | lines
    B = low > t_low
    # where you walked
    walked = np.zeros(grid.shape, bool)
    u, v = to_plan(a, feet_level[:, 0], feet_level[:, 2])
    i, k, ok = grid.idx(u, v)
    walked[i[ok], k[ok]] = True
    near = ndimage.distance_transform_edt(~walked) * cell
    walked = near < 0.35
    # footprint: flood from the path through free space, not too far from where you walked
    floor = floor_evidence(spl, a, grid, L) | walked
    floor = ndimage.binary_fill_holes(ndimage.binary_closing(floor, structure=np.ones((5, 5)), iterations=3))
    free = (~B | walked) & floor
    fp = ndimage.binary_propagation(walked, mask=free & (near < 3.0))
    fp = ndimage.binary_fill_holes(fp | (B & floor & (near < 3.0) & ndimage.binary_dilation(fp, iterations=6)))
    fp &= ~ndimage.binary_dilation(W, iterations=1) | walked
    fp = ndimage.binary_opening(fp, structure=np.ones((5, 5)))
    lab_fp, n = ndimage.label(fp)
    if n:  # keep the parts you actually walked in
        keep = np.unique(lab_fp[walked & fp])
        fp = np.isin(lab_fp, keep[keep > 0])
    space = fp & ~W
    D = ndimage.distance_transform_edt(space) * cell
    # one seed per "room centre": local maxima of clearance, far enough apart
    Ds = ndimage.gaussian_filter(D, 2)
    peak = (Ds == ndimage.maximum_filter(Ds, size=int(2.0 / cell))) & (Ds > 0.5)
    seeds, ns = ndimage.label(ndimage.binary_dilation(peak, iterations=2) & space)
    if not ns:
        return np.zeros(grid.shape, np.int32), W, fp
    lab = _watershed(-Ds, seeds, space)
    DEBUG.update(raw=lab.copy(), Ds=Ds, W=W, fp=fp, u=u, v=v, grid=grid)
    lab = merge_regions(lab, cell, u, v, grid, Ds=Ds, log=log)
    # nothing more than ~1 m beyond the outermost places you walked (terraces behind closed glass
    # doors and the like), and only the connected part of each room that you walked through
    if len(u):
        m_ = 1.1
        ci, ck = np.meshgrid(*[np.arange(n_) for n_ in grid.shape], indexing="ij")
        cu, cv = grid.center(ci, ck)
        lab[(cu < u.min() - m_) | (cu > u.max() + m_) | (cv < v.min() - m_) | (cv > v.max() + m_)] = 0
        ii_, kk_, ok_ = grid.idx(u, v)
        # trim door-wide tongues (a doorway the region leaked through) off rooms that are wider than that
        sq = np.ones((int(round(1.0 / cell)),) * 2)
        for x in [x for x in np.unique(lab) if x]:
            m = lab == x
            opened = ndimage.binary_opening(m, structure=sq)
            if opened.sum() > 0.5 * m.sum():
                lab[m & ~opened] = 0
        for x in [x for x in np.unique(lab) if x]:
            comp, nc = ndimage.label(lab == x)
            if nc > 1:
                hit = np.unique(comp[ii_[ok_], kk_[ok_]])
                lab[(comp > 0) & ~np.isin(comp, hit[hit > 0])] = 0
    # give back the wall/furniture margins inside each room's bounding region
    lab_full = lab.copy()
    rest = fp & (lab == 0)
    if rest.any():
        dist, (ii, kk) = ndimage.distance_transform_edt(lab == 0, return_indices=True)
        lab_full[rest & (dist < 8)] = lab[ii, kk][rest & (dist < 8)]
    return lab_full, W, fp


DEBUG = {}


def merge_regions(lab, cell, pu, pv, grid, Ds=None, open_width=1.1, small_area=3.0, door_width=0.9, log=print):
    """Turn watershed regions into rooms: drop parts nobody walked into (outside closed doors, say),
    join regions that meet along a wide opening (open plan, not a doorway), and fold small pieces
    into the room they open onto."""
    lab = lab.copy()
    i, k, ok = grid.idx(pu, pv)

    def stats():
        ids = [x for x in np.unique(lab) if x]
        area = {x: int((lab == x).sum()) * cell * cell for x in ids}
        visits = {x: 0 for x in ids}
        for x in lab[i[ok], k[ok]]:
            if x:
                visits[x] = visits.get(x, 0) + 1
        border, saddle = {}, {}
        for sl_a, sl_b in (((slice(None, -1), slice(None)), (slice(1, None), slice(None))),
                           ((slice(None), slice(None, -1)), (slice(None), slice(1, None)))):
            A, Bq = lab[sl_a], lab[sl_b]
            m = (A != Bq) & (A > 0) & (Bq > 0)
            dd = np.minimum(Ds[sl_a], Ds[sl_b])[m] if Ds is not None else np.zeros(m.sum())
            for a_, b_, d_ in zip(A[m], Bq[m], dd):
                key = (min(a_, b_), max(a_, b_))
                border[key] = border.get(key, 0) + cell
                saddle[key] = max(saddle.get(key, 0), d_)
        peak = {x: (Ds[lab == x].max() if Ds is not None else 1) for x in ids}
        return ids, area, visits, border, saddle, peak

    for _ in range(200):
        ids, area, visits, border, saddle, peak = stats()
        nb = {x: [] for x in ids}
        for (a_, b_), L in border.items():
            nb[a_].append((L, b_)); nb[b_].append((L, a_))
        # 1. parts nobody walked into: a sliver joins its neighbour, anything bigger goes
        dead = [x for x in ids if visits[x] == 0]
        if dead:
            x = min(dead, key=lambda q: area[q])
            best = max(nb[x], default=(0, None))
            lab[lab == x] = best[1] if (area[x] < 1.5 and best[0] >= 0.3 and best[1]) else 0
            continue
        # 2. wide openings and small pieces: merge the pair with the longest shared border first
        cand = []
        for (a_, b_), L in border.items():
            sad = saddle.get((a_, b_), 0)
            wide = Ds is not None and (2 * sad >= open_width or sad > 0.75 * min(peak[a_], peak[b_]))
            if wide or (min(area[a_], area[b_]) < small_area and L >= door_width):
                cand.append((L, a_, b_))
        if not cand:
            break
        _, a_, b_ = max(cand)
        keep, drop = (a_, b_) if area[a_] >= area[b_] else (b_, a_)
        lab[lab == drop] = keep
    return lab


def default_start(a, grid: Grid, mask, L, feet_level, space):
    """Where to stand and which way to look when jumping to a room."""
    D = ndimage.distance_transform_edt(mask)
    ci, ck = np.unravel_index(np.argmax(D), D.shape)
    cu, cv = grid.center(ci, ck)
    pu, pv = to_plan(a, feet_level[:, 0], feet_level[:, 2])
    i, k, ok = grid.idx(pu, pv)
    inside = np.zeros(len(pu), bool)
    inside[ok] = mask[i[ok], k[ok]]
    if inside.any():
        d = np.hypot(pu - cu, pv - cv)
        d[~inside] = np.inf
        j = int(np.argmin(d))
        su, sv = pu[j], pv[j]
        y = float(feet_level[j, 1])
    else:
        su, sv, y = cu, cv, L
    # face the longest free view across the room
    best, yaw = -1, 0.0
    for t in range(16):
        ang = t * math.pi / 8
        du, dv = math.cos(ang), math.sin(ang)
        r = 0.0
        while r < 12:
            r += grid.cell
            ii, kk, ok2 = grid.idx(su + du * r, sv + dv * r)
            if not ok2 or not space[ii, kk]:
                break
        if r > best:
            best, dir_uv = r, (du, dv)
    x, z = from_plan(a, su, sv)
    dx, dz = from_plan(a, *dir_uv)
    yaw = math.degrees(math.atan2(-dx, -dz))  # viewer: forward = (-sin yaw, 0, -cos yaw)
    return {"position": [round(x, 3), round(y, 3), round(z, 3)], "yaw": round(yaw, 1)}


def build_map(xyz, opacity, scales, quats, feet, dc=None, *, lang="sv", cell=0.05, img_cell=0.025, angle=None,
              log=print):
    """Returns (map dict for tour.json, {filename: bytes} plan images)."""
    feet = np.asarray(feet, float)
    spl = Splats(xyz, opacity, scales, quats, dc)
    levels = storey_levels(feet)
    if not levels:
        return None, {}
    a = wall_angle(spl, levels) if angle is None else float(angle)
    log(f"  walls run at {math.degrees(a):.0f}° in the tour frame")
    fu, fv = to_plan(a, feet[:, 0], feet[:, 2])
    pad = 3.5
    u0, v0, u1, v1 = fu.min() - pad, fv.min() - pad, fu.max() + pad, fv.max() + pad
    out = {"version": 1, "angle": round(a, 5), "levels": [], "rooms": []}
    files = {}
    near_level = np.array([min(levels, key=lambda L: abs(L - y)) for y in feet[:, 1]])
    on_level = np.abs(feet[:, 1] - near_level) < 0.08
    names = {"sv": ("Rum", "Trappa"), "en": ("Room", "Stairs")}.get(lang, ("Room", "Stairs"))
    rid = 0
    for li, L in enumerate(levels):
        top_next = levels[li + 1] if li + 1 < len(levels) else None
        ceiling = estimate_ceiling(spl, feet[on_level & (near_level == L)], L, top_next)
        grid = Grid(u0, v0, u1, v1, cell)
        fl = feet[on_level & (near_level == L)]
        lab, W, fp = detect_rooms(spl, a, grid, L, fl, log=log)
        # plan picture, cut just under the ceiling so you see into the rooms
        ig = Grid(u0, v0, u1, v1, img_cell)
        rgba = render_plan(spl, a, ig, L, L + min(1.9, ceiling - 0.3))
        if rgba is not None:  # keep the house, fade out the garden and floaters around it
            dist = ndimage.distance_transform_edt(~fp) * cell
            f = int(round(cell / img_cell))
            fade = np.clip(1 - (dist - 0.25) / 0.5, 0, 1)
            fade = np.kron(fade, np.ones((f, f)))[:rgba.shape[0], :rgba.shape[1]]
            pad_ = [(0, rgba.shape[0] - fade.shape[0]), (0, rgba.shape[1] - fade.shape[1])]
            fade = np.pad(fade, pad_, constant_values=0)
            rgba[..., 3] = (rgba[..., 3] * fade).astype(np.uint8)
        lv = {"y": round(L, 3), "height": round(ceiling, 2), "bounds": [round(u0, 3), round(v0, 3), round(u1, 3), round(v1, 3)]}
        if rgba is not None:
            data, ext = encode_image(rgba)
            name = f"plan-{li}.{ext}"
            files[name] = data
            lv["image"] = name
        out["levels"].append(lv)
        space = fp & ~W
        ids = [x for x in np.unique(lab) if x]
        ids.sort(key=lambda x: -(lab == x).sum())
        for x in ids:
            m = ndimage.binary_fill_holes(lab == x)
            if m.sum() * cell * cell < 1.0:
                continue
            boxes = _rects(m, cell)
            rects = [[round(u0 + b[0] * cell, 2), round(v0 + b[1] * cell, 2),
                      round(u0 + b[2] * cell, 2), round(v0 + b[3] * cell, 2)] for b in boxes]
            rid += 1
            out["rooms"].append({"id": f"r{rid}", "name": f"{names[0]} {rid}", "level": li, "kind": "room",
                                 "rects": rects, "start": default_start(a, grid, m, L, fl, space)})
        log(f"  storey {li + 1}: {sum(1 for r in out['rooms'] if r['level'] == li)} rooms, ceiling {ceiling:.2f} m")
    # stairs: path stretches between storeys
    for li in range(len(levels) - 1):
        L0, L1 = levels[li], levels[li + 1]
        st = feet[(feet[:, 1] > L0 + 0.1) & (feet[:, 1] < L1 - 0.1)]
        if len(st) < 2:
            continue
        su, sv = to_plan(a, st[:, 0], st[:, 2])
        r = 0.55
        rects = [[round(su.min() - r, 2), round(sv.min() - r, 2), round(su.max() + r, 2), round(sv.max() + r, 2)]]
        low = st[np.argmin(st[:, 1])]
        hi = st[np.argmax(st[:, 1])]
        x, z = low[0], low[2]
        yaw = math.degrees(math.atan2(-(hi[0] - low[0]), -(hi[2] - low[2])))
        rid += 1
        # stand on the floor at the foot of the stairs
        fl = feet[on_level & (near_level == L0)]
        if len(fl):
            j = int(np.argmin(np.hypot(fl[:, 0] - x, fl[:, 2] - z)))
            x, z = fl[j, 0], fl[j, 2]
        out["rooms"].append({"id": f"r{rid}", "name": names[1], "level": li, "kind": "stairs", "rects": rects,
                             "top": li + 1, "start": {"position": [round(float(x), 3), round(L0, 3), round(float(z), 3)],
                                                      "yaw": round(yaw, 1)}})
    return out, files


def estimate_ceiling(spl: Splats, fl, L, next_level):
    """Ceiling height above floor L: lowest dense horizontal layer above head height."""
    if next_level is not None:
        guess = next_level - L - 0.25
    else:
        guess = 2.5
    flat = (np.abs(spl.normal[:, 1]) > 0.8) & (spl.op > 0.3)
    if len(fl):
        c = fl[:, [0, 2]].mean(0)
        r = np.hypot(spl.xyz[:, 0] - c[0], spl.xyz[:, 2] - c[1]) < 6
        flat &= r
    y = spl.xyz[flat, 1] - L
    y = y[(y > 2.0) & (y < (guess + 0.4 if next_level is not None else 4.0))]
    if len(y) < 200:
        return round(guess, 2)
    h, e = np.histogram(y, bins=np.arange(2.0, y.max() + 0.05, 0.05))
    j = int(np.argmax(h > 0.25 * h.max()))
    return float(round(e[j] + 0.025, 2))


# ------------------------------------------------------------------ keeping edits across re-publishing
def carry_over(new_map, old_map):
    """Keep names, start points and hand-drawn rooms from an earlier version of the same tour."""
    if not old_map or not old_map.get("rooms"):
        return new_map
    if old_map.get("edited"):
        # rooms were edited by hand: keep them as they are, only refresh pictures and storeys
        new_map["rooms"] = old_map["rooms"]
        for k in ("startRoom", "edited", "angle"):
            if k in old_map:
                new_map[k] = old_map[k]
        return new_map
    return new_map
