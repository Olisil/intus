#!/usr/bin/env python3
"""
publish_tour.py - turn a trained Gaussian splat + its COLMAP camera path into a
walkable web tour (tour.sog + collision.glb + tour.json) for the Nassau viewer.

Typical use (Spirula Studio output):

    python publish_tour.py --name villa-ekbacken --title "Villa Ekbacken" ^
        --splat "E:\\...\\_dataset\\outputs\\<run>\\step-000030000.ckpt\\splat.ply"

The COLMAP folder (sparse\\0) is found automatically by walking up from the
splat to the dataset folder. Pass --sparse to point at it explicitly.

What it does
  1. Reads the camera path from COLMAP (images.bin / images.txt).
  2. Finds which way is up and how high the camera was held (from the path and
     the splat itself), and where the floor is under the first camera.
  3. Crops away everything far from where you walked (garden, street, haze).
  4. Levels the scene: Y up, metres, floor under the start point at y = 0,
     facing the direction you first walked.
  5. Compresses to SOG and builds a collision mesh with PlayCanvas splat-transform.
  6. Writes tour.json and registers the tour in <site>/tours/index.json.

Requirements: Python 3.9+, numpy, scipy, Node.js (for npx @playcanvas/splat-transform).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

HERE = Path(__file__).resolve().parent
# Pinned: the viewer's PlayCanvas engine (public/lib/playcanvas.mjs, 2.23) reads SOG format version 2.
# splat-transform 3.12 writes version 3, which that engine draws wrongly; a 1.2M-splat tour froze the whole
# computer. Move this only together with the engine in the viewer, and test a published tour before and after.
SPLAT_TRANSFORM_PKG = "@playcanvas/splat-transform@3.10.3"
SOG_VERSION = 2  # what the viewer reads


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------- COLMAP
def qvec_to_rotmat(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
    ])


def read_images_bin(path: Path):
    """Return list of (name, camera_center, camera_down_in_world). Skips 2D points without parsing them."""
    out = []
    with open(path, "rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        for _ in range(n):
            _image_id, qw, qx, qy, qz, tx, ty, tz, _cam_id = struct.unpack("<i7di", f.read(64))
            name = bytearray()
            while True:
                c = f.read(1)
                if c in (b"\x00", b""):
                    break
                name += c
            (npts,) = struct.unpack("<Q", f.read(8))
            f.seek(npts * 24, os.SEEK_CUR)
            q = np.array([qw, qx, qy, qz])
            if abs(np.linalg.norm(q) - 1) > 1e-3:
                raise ValueError("images.bin does not look like a COLMAP images file")
            R = qvec_to_rotmat(q / np.linalg.norm(q))
            out.append((name.decode("utf-8", "replace"), -R.T @ np.array([tx, ty, tz]), R[1].copy()))
    return out


def read_images_txt(path: Path):
    out = []
    lines = [l for l in path.read_text().splitlines() if l and not l.startswith("#")]
    for i in range(0, len(lines), 2):
        p = lines[i].split()
        q = np.array(list(map(float, p[1:5])))
        t = np.array(list(map(float, p[5:8])))
        R = qvec_to_rotmat(q / np.linalg.norm(q))
        out.append((p[9], -R.T @ t, R[1].copy()))
    return out


def find_sparse(splat: Path) -> Path | None:
    for parent in [splat.parent, *splat.parents]:
        for cand in (parent / "sparse" / "0", parent / "sparse", parent / "0_train_data" / "sparse"):
            if (cand / "images.bin").exists() or (cand / "images.txt").exists():
                return cand
    return None


def load_scene_transform(splat: Path):
    """Spirula writes scene_transform.json next to the checkpoint folder (train_from_world)."""
    for parent in [splat.parent, *list(splat.parents)[:3]]:
        p = parent / "scene_transform.json"
        if p.exists():
            d = json.loads(p.read_text())["train_from_world"]
            return float(d["scale"]), np.array(d["rotation"]["matrix_3x3"], float), np.array(d["translation"], float), p
    return 1.0, np.eye(3), np.zeros(3), None


# --------------------------------------------------------------------- PLY
PLY_TYPES = {"float": "f4", "float32": "f4", "double": "f8", "float64": "f8", "uchar": "u1", "uint8": "u1",
             "char": "i1", "int8": "i1", "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2",
             "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4"}


LITE_MAX = 450_000  # splats in the light version at most


def read_ply(path: Path):
    with open(path, "rb") as f:
        header = b""
        while not header.endswith(b"end_header\n"):
            line = f.readline()
            if not line:
                raise ValueError("bad PLY header")
            header += line.replace(b"\r\n", b"\n")
        offset = f.tell()
    lines = header.decode("ascii").splitlines()
    if "format binary_little_endian 1.0" not in lines:
        raise ValueError(f"{path.name}: only binary little-endian PLY is supported (got a compressed or ascii PLY?)")
    count, props, in_vertex = 0, [], False
    for l in lines:
        p = l.split()
        if p[:2] == ["element", "vertex"]:
            count, in_vertex = int(p[2]), True
        elif p and p[0] == "element":
            if in_vertex and count:
                raise ValueError("PLY has extra elements after vertex; not a plain splat PLY")
            in_vertex = False
        elif p and p[0] == "property" and in_vertex:
            props.append((p[2], "<" + PLY_TYPES[p[1]]))
    dtype = np.dtype(props)
    data = np.memmap(path, dtype=dtype, mode="r", offset=offset, shape=(count,))
    return data, lines


def write_ply(path: Path, data: np.ndarray, header_lines):
    out = []
    for l in header_lines:
        if l.startswith("element vertex"):
            l = f"element vertex {len(data)}"
        out.append(l)
    with open(path, "wb") as f:
        f.write(("\n".join(out) + "\n").encode("ascii"))
        np.ascontiguousarray(data).tofile(f)


# --------------------------------------------------------------------- geometry helpers
def basis_for(up):
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)
    return e1, e2


def column_heights(points, weights, centers, up, radius=0.6, max_cams=400):
    """Signed heights (along up) of splats in a vertical column around each camera."""
    e1, e2 = basis_for(up)
    p2 = np.stack([points @ e1, points @ e2], 1)
    tree = cKDTree(p2)
    step = max(1, len(centers) // max_cams)
    hs, ws = [], []
    for c in centers[::step]:
        idx = tree.query_ball_point([c @ e1, c @ e2], radius)
        if not idx:
            continue
        idx = np.asarray(idx)
        h = (points[idx] - c) @ up
        keep = np.abs(h) < 4.0
        hs.append(h[keep]); ws.append(weights[idx][keep])
    if not hs:
        return np.zeros(0), np.zeros(0)
    return np.concatenate(hs), np.concatenate(ws)


def peak(h, w, lo, hi, bin_size=0.02):
    sel = (h > lo) & (h < hi)
    if sel.sum() < 50:
        return None, 0.0
    bins = np.arange(lo, hi + bin_size, bin_size)
    hist, edges = np.histogram(h[sel], bins=bins, weights=w[sel])
    hist = np.convolve(hist, np.ones(5) / 5, mode="same")
    i = int(np.argmax(hist))
    return 0.5 * (edges[i] + edges[i + 1]), float(hist[i] / (hist.mean() + 1e-9))


def floor_under_path(path_pts, xyz, opacity, scales_lin, quats_wxyz, up, log=print):
    """Height of the floor under every camera position (distance along `up`, positive).

    Floors are found as horizontal planes made of flat, horizontal splats. Under each camera
    we take the LOWEST such plane 0.7-2.4 m below it that is actually present there - table
    and counter tops are planes too, but they are never the lowest. Positions without a
    clear floor (stairs, holes) are interpolated along the walk."""
    q = quats_wxyz / np.linalg.norm(quats_wxyz, axis=1, keepdims=True)
    w, x, y, z = q.T
    thin = np.argmin(scales_lin, 1)
    R = np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
                  np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
                  np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1)], 1)
    normal = R[np.arange(len(q)), :, thin]
    smax = scales_lin.max(1)
    flat = (opacity > 0.4) & (np.abs(normal @ up) > 0.9) & (smax < 0.3) & (scales_lin.min(1) < 0.35 * smax)
    F, W = xyz[flat], opacity[flat]
    hF = F @ up
    # candidate planes: peaks of the height histogram of horizontal splats
    bins = np.arange(hF.min(), hF.max() + 0.05, 0.05)
    hist, edges = np.histogram(hF, bins=bins, weights=W)
    sm = np.convolve(hist, [0.25, 0.5, 0.25], "same")
    peaks = [i for i in range(1, len(sm) - 1) if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] >= 0.25 * sm.max()]
    planes = np.array(sorted(0.5 * (edges[i] + edges[i + 1]) for i in peaks))
    e1, e2 = basis_for(up)
    tree = cKDTree(np.stack([F @ e1, F @ e2], 1))
    hc = path_pts @ up
    dist = np.full(len(path_pts), np.nan)
    for i, c in enumerate(path_pts):
        idx = tree.query_ball_point([c @ e1, c @ e2], 1.0)
        if len(idx) < 5:
            continue
        hh, ww = hF[idx], W[idx]
        present = [pl for pl in planes if hc[i] - 2.4 <= pl <= hc[i] - 0.25 and ww[np.abs(hh - pl) < 0.1].sum() >= 1.0]
        cand = [pl for pl in present if pl <= hc[i] - 0.7]
        if cand:
            dist[i] = hc[i] - cand[0]  # lowest: table, sofa and counter tops are never the lowest
    known = np.isfinite(dist)
    if known.sum() < 5:
        return None
    # pass 2: the real floor levels are the planes chosen under many positions
    chosen = hc[known] - dist[known]
    floors = [pl for pl in planes if np.mean(np.abs(chosen - pl) < 0.05) >= 0.1] or list(planes)
    on_floor = np.any(np.abs((hc - dist)[:, None] - np.array(floors)[None, :]) < 0.05, 1) & known
    carry0 = float(np.median(dist[on_floor])) if on_floor.any() else float(np.nanmedian(dist))
    # each position stands on the nearest of those floors that is really there underneath;
    # none within carry height (0.25-2.4 m) means stairs or a void
    d2 = np.full(len(path_pts), np.nan)
    for i, c in enumerate(path_pts):
        idx_ = tree.query_ball_point([c @ e1, c @ e2], 0.6)
        if not idx_:
            continue
        hh, ww = hF[idx_], W[idx_]
        for pl in sorted((f for f in floors if f < hc[i] - 0.25), reverse=True):
            if ww[np.abs(hh - pl) < 0.1].sum() >= 1.0:
                # only if the camera is about your usual carry height above it (not halfway up a stair)
                if abs((hc[i] - pl) - carry0) <= 0.5:
                    d2[i] = hc[i] - pl
                break
    known = np.isfinite(d2)
    if known.sum() < 5:
        return None
    idx = np.arange(len(path_pts))
    raw = np.interp(idx, idx[known], d2[known])
    k = 7  # carry height changes slowly: smooth it for the positions in between (stairs)
    pad = np.r_[np.full(k, raw[0]), raw, np.full(k, raw[-1])]
    carry = np.array([np.median(pad[i:i + 2 * k + 1]) for i in range(len(raw))])
    feet_h = np.where(known, hc - d2, hc - carry)
    for i in np.flatnonzero(~known):
        pl = min(floors, key=lambda f: abs(f - feet_h[i]))
        if abs(pl - feet_h[i]) < 0.25:
            feet_h[i] = pl
    # stairs have a constant slope: between the last floor position below and the first one above,
    # lay the feet on a straight ramp measured along the walk (camera heights there are noisy)
    on = np.array([min(abs(f - x) for x in floors) < 0.06 for f in feet_h])
    horiz = np.c_[path_pts @ e1, path_pts @ e2]
    n, i = len(feet_h), 0
    while i < n:
        if on[i]:
            i += 1
            continue
        j = i
        while j < n and not on[j]:
            j += 1
        a, b = i - 1, j
        if a >= 0 and b < n:
            if abs(feet_h[a] - feet_h[b]) < 0.1:
                feet_h[i:j] = feet_h[a]                     # a detour on one floor
            else:
                seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(horiz[a:b + 1], axis=0), axis=1))]
                feet_h[a:b + 1] = feet_h[a] + (feet_h[b] - feet_h[a]) * seg / max(seg[-1], 1e-6)
        i = j
    dist = hc - feet_h
    log(f"              floors at {', '.join(f'{p:+.2f}' for p in floors)} m; "
        f"floor found under {100 * known.mean():.0f}% of positions")
    return dist


def pc_euler_matrix(ex, ey, ez):
    """Rotation matrix used by PlayCanvas setFromEulerAngles (degrees), acting on column vectors."""
    ex, ey, ez = (math.radians(v) for v in (ex, ey, ez))
    s1, c1 = math.sin(-ex), math.cos(-ex)
    s2, c2 = math.sin(-ey), math.cos(-ey)
    s3, c3 = math.sin(-ez), math.cos(-ez)
    m = [c2 * c3, -c2 * s3, s2, 0, c1 * s3 + c3 * s1 * s2, c1 * c3 - s1 * s2 * s3, -c2 * s1, 0,
         s1 * s3 - c1 * c3 * s2, c3 * s1 + c1 * s2 * s3, c1 * c2]
    return np.array([[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]])


def euler_for(R):
    rot = Rotation.from_matrix(R)
    for seq in ("ZYX", "XYZ", "zyx", "xyz", "YXZ", "yxz", "ZXY", "zxy"):
        for e in (rot.as_euler(seq, degrees=True), rot.inv().as_euler(seq, degrees=True)):
            for cand in (e, e[::-1], -e, -e[::-1]):
                if np.abs(pc_euler_matrix(*cand) - R).max() < 1e-6:
                    return [float(v) for v in cand]
    raise RuntimeError("could not express rotation as PlayCanvas Euler angles")


# --------------------------------------------------------------------- keeping hand edits across reconstructions
# Each reconstruction of the same walk gets its own tour frame (origin and heading come from its first
# frames), a few degrees and decimetres off the last one. Rooms and start points drawn in the old frame
# must be moved, or a start lands inside a wall.

def _dense(p, step=0.05):
    p = np.asarray(p, float)
    out = []
    for a_, b_ in zip(p[:-1], p[1:]):
        n = max(1, int(np.linalg.norm(b_ - a_) / step))
        out += [a_ + (b_ - a_) * t for t in np.linspace(0, 1, n, endpoint=False)]
    return np.array(out + [p[-1]])


def fit_frames(old_path, new_path):
    """Rigid move in the floor plane (turn about Y + shift) that lays the old walked path on the new one.
    Returns (M 2x2, t 2, median distance in metres) acting on (x, z), or None."""
    if not old_path or not new_path or len(old_path) < 10 or len(new_path) < 10:
        return None
    A, B = _dense(old_path), _dense(new_path)
    # match in the floor plane; heights only keep the storeys apart (floor heights differ a little between
    # reconstructions, so they count for less)
    W = 0.3
    tree = cKDTree(np.c_[B[:, [0, 2]], B[:, 1] * W])
    M, t = np.eye(2), np.zeros(2)
    for _ in range(60):
        X = A[:, [0, 2]] @ M.T + t
        d, i = tree.query(np.c_[X, A[:, 1] * W])
        ok = d <= np.percentile(d, 90)
        P, Q = A[ok][:, [0, 2]], B[i[ok]][:, [0, 2]]
        cp, cq = P.mean(0), Q.mean(0)
        U, _, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
        D = np.diag([1, np.sign(np.linalg.det(Vt.T @ U.T))])
        M = Vt.T @ D @ U.T
        t = cq - M @ cp
    X = A[:, [0, 2]] @ M.T + t
    _, i = tree.query(np.c_[X, A[:, 1] * W])
    return M, t, float(np.median(np.hypot(*(X - B[i][:, [0, 2]]).T)))


def move_start(st, M, t):
    """A {position, yaw} start point moved into the new frame (height is set from the storey later)."""
    if not st or "position" not in st:
        return st
    x, y, z = st["position"]
    nx, nz = M @ [x, z] + t
    yaw = math.radians(st.get("yaw") or 0)
    dx, dz = M @ [-math.sin(yaw), -math.cos(yaw)]
    return {**st, "position": [round(float(nx), 3), y, round(float(nz), 3)], "yaw": round(math.degrees(math.atan2(-dx, -dz)), 1)}


def move_map(old_map, M, t):
    """A hand-edited map moved into the new frame. Room rectangles live in plan coordinates (the tour's x, z
    turned by map.angle), so the turn goes into the angle and the rectangles only shift."""
    theta = math.atan2(M[1, 0], M[0, 0])
    a2 = old_map.get("angle", 0.0) - theta
    c, s_ = math.cos(a2), math.sin(a2)
    cu, cv = c * t[0] - s_ * t[1], s_ * t[0] + c * t[1]
    m = json.loads(json.dumps(old_map))
    m["angle"] = round(a2, 5)
    for r in m.get("rooms", []):
        r["rects"] = [[round(u0 + cu, 3), round(v0 + cv, 3), round(u1 + cu, 3), round(v1 + cv, 3)] for u0, v0, u1, v1 in r.get("rects", [])]
        if r.get("start"):
            r["start"] = move_start(r["start"], M, t)
    return m


def match_storeys(plan, old_levels, pics, log=print):
    """After hand-drawn rooms were carried over: point them at the new storeys (nearest height), keep only
    the storeys they use (the drawn map decides which storeys exist) and stand each start on its floor."""
    new_y = [l["y"] for l in plan["levels"]]
    near = lambda y: int(np.argmin([abs(v - y) for v in new_y]))
    old_y = [l.get("y", 0) for l in old_levels]
    to_new = {i: near(y) for i, y in enumerate(old_y)}
    used = sorted({to_new.get(r.get(k), 0) for r in plan["rooms"] for k in ("level", "top") if k in r})
    for i, l in enumerate(plan["levels"]):
        if i not in used:
            log(f"  storey at {l['y']:+.2f} m left out: no drawn room is on it")
            pics.pop(l.get("image"), None)
    idx = {old: new for new, old in enumerate(used)}
    plan["levels"] = [plan["levels"][i] for i in used]
    for r in plan["rooms"]:
        for k in ("level", "top"):
            if k in r:
                r[k] = idx[to_new.get(r[k], 0)]
        if r.get("start", {}).get("position"):
            r["start"]["position"][1] = plan["levels"][r["level"]]["y"]
    return plan


def segment_hits(V, T, p, q):
    """Does the segment p-q cross any triangle of the collision mesh (Moller-Trumbore, all at once)?"""
    V = np.asarray(V, float).reshape(-1, 3); T = np.asarray(T).reshape(-1, 3)
    d = np.asarray(q, float) - np.asarray(p, float)
    v0, e1, e2 = V[T[:, 0]], V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]]
    h = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, h)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s_ = np.asarray(p, float) - v0
    u = np.einsum("ij,ij->i", s_, h) * inv
    qv = np.cross(s_, e1)
    v = (qv @ d) * inv
    tt = np.einsum("ij,ij->i", e2, qv) * inv
    return bool(np.any(ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (tt >= 0) & (tt <= 1)))


def free_start(pos, path, V, T, radius=0.3):
    """A start point you can actually stand on and walk away from: nothing between it and the nearest walked
    position on that floor, and room for the body around it. Otherwise the nearest spot towards the walk
    that is free; the walked position itself always is."""
    pos = np.asarray(pos, float)
    path = np.asarray(path, float)
    same = path[np.abs(path[:, 1] - pos[1]) < 0.3]
    if not len(same):
        same = path
    anchor = same[np.argmin(np.hypot(same[:, 0] - pos[0], same[:, 2] - pos[2]))]
    up_ = lambda p, h: np.array([p[0], p[1] + h, p[2]])
    ring = [np.array([math.cos(k * math.pi / 4), 0, math.sin(k * math.pi / 4)]) * radius for k in range(8)]

    def free(p):
        if any(segment_hits(V, T, up_(anchor, h), up_(p, h)) for h in (0.5, 1.0, 1.4)):
            return False
        return not any(segment_hits(V, T, up_(p, h), up_(p, h) + r) for h in (0.6, 1.3) for r in ring)
    for f in (0.0, 0.25, 0.5, 0.75, 0.9):
        cand = pos + (anchor - pos) * f
        if free(cand):
            return [round(float(cand[0]), 3), round(float(pos[1]), 3), round(float(cand[2]), 3)], f > 0
    return [round(float(anchor[0]), 3), round(float(anchor[1]), 3), round(float(anchor[2]), 3)], True


# --------------------------------------------------------------------- splat-transform
def splat_transform_cmd():
    exe = shutil.which("splat-transform")
    if exe:
        return [exe]
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        sys.exit("Node.js is required (npx not found). Install from https://nodejs.org and re-run.")
    return [npx, "-y", SPLAT_TRANSFORM_PKG]


def run_st(args, desc):
    cmd = splat_transform_cmd() + ["-w", "--no-tty"] + [str(a) for a in args]
    log(f"  $ splat-transform {' '.join(str(a) for a in args)}")
    t = time.time()
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail = "\n".join(r.stdout.strip().splitlines()[-6:])
    if r.returncode != 0:
        log(f"  ! {desc} failed:\n{tail}")
        return False
    log(f"  ✓ {desc} ({time.time() - t:.0f}s)")
    return True


def list_gpus(backend="auto"):
    """Graphics cards splat-transform can use, as [(index, name)]."""
    cmd = splat_transform_cmd() + ["--list-gpus"] + (["--gpu-backend", backend] if backend != "auto" else [])
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120,
                           encoding="utf-8", errors="replace")
    except Exception:
        return []
    return [(int(m.group(1)), m.group(2).strip()) for m in re.finditer(r"^\[(\d+)\]\s+(.+)$", r.stdout, re.M)]


def gpu_attempts(gpu: str, backend: str):
    """Ordered list of (label, extra splat-transform args) to try for SOG compression."""
    cpu = ("CPU", ["-g", "cpu"])
    if str(gpu).lower() == "cpu":
        log("Compute       CPU (as chosen)")
        return [cpu]
    gpus = list_gpus(backend)
    if not gpus:
        log("Compute       no usable graphics card found - using the CPU")
        return [cpu]
    idx = int(gpu) if str(gpu).isdigit() else None
    name = dict(gpus).get(idx, gpus[0][1]) if idx is not None else gpus[0][1]
    base = ["-g", str(idx)] if idx is not None else []
    log(f"Compute       {name}" + (f" (adapter {idx})" if idx is not None else ""))
    out = []
    if backend != "auto":
        out.append((f"GPU, {backend}", base + ["--gpu-backend", backend]))
    else:
        out.append(("GPU", base))
        if os.name == "nt":  # Dawn's D3D12 path has known bugs; Vulkan often works when it doesn't
            out.append(("GPU, Vulkan", base + ["--gpu-backend", "vulkan"]))
    return out + [cpu]


# --------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    listing = "--list-gpus" in sys.argv
    ap.add_argument("--splat", required=not listing, type=Path, help="trained splat .ply")
    ap.add_argument("--name", required=not listing, help="tour id, used in the URL (?t=<name>)")
    ap.add_argument("--title", help="tour title shown to visitors")
    ap.add_argument("--subtitle", default="", help="line under the title, e.g. an address")
    ap.add_argument("--eyebrow", default="", help="small label above the title, e.g. the broker")
    ap.add_argument("--lang", default="sv", choices=["sv", "en"], help="viewer language (default sv)")
    ap.add_argument("--sparse", type=Path, help="COLMAP sparse folder (auto-detected)")
    ap.add_argument("--site", type=Path, default=HERE / "site",
                    help="where to publish: a plain site folder (viewer is copied in), or your Astro/Webflow Cloud "
                         "repo folder (tours go to public/tours, the viewer is left alone)")
    ap.add_argument("--max-mb", type=float, default=19.0,
                    help="largest tour.sog allowed (Webflow Cloud caps static files at 20 MB); thins the splat to fit")
    ap.add_argument("--up", choices=["auto", "+x", "-x", "+y", "-y", "+z", "-z"], default="auto")
    ap.add_argument("--crop", type=float, default=5.0, help="keep splats within this many metres of the walked path")
    ap.add_argument("--max-size", type=float, default=1.5, help="drop haze blobs larger than this (metres)")
    ap.add_argument("--min-opacity", type=float, default=0.01)
    ap.add_argument("--spawn", type=int, default=0, help="index along the path to start from (0 = first frame)")
    ap.add_argument("--eye-height", type=float, default=1.6)
    ap.add_argument("--no-collision", action="store_true", help="skip building collision.glb")
    ap.add_argument("--no-map", action="store_true", help="skip the floor plan (rooms and plan pictures)")
    ap.add_argument("--fresh-rooms", action="store_true", help="detect the rooms again, even if they were edited in the studio")
    ap.add_argument("--lite", type=float, default=40,
                    help="also write tour-lite.sog with this %% of the splats for phones and slower computers (0 = off)")
    ap.add_argument("--no-sog", action="store_true", help="skip SOG compression (write a PLY instead, for testing)")
    ap.add_argument("--keep", action="store_true", help="keep intermediate files")
    ap.add_argument("--gpu", default="auto",
                    help="where to run SOG compression: auto (graphics card, CPU if that fails), "
                         "an adapter number from --list-gpus, or cpu")
    ap.add_argument("--gpu-backend", default="auto", choices=["auto", "d3d12", "vulkan", "metal"],
                    help="WebGPU backend for the graphics card (auto tries the default, then Vulkan on Windows)")
    ap.add_argument("--list-gpus", action="store_true", help="list graphics cards that can be used and exit")
    a = ap.parse_args()
    if a.list_gpus:
        gpus = list_gpus()
        for i, n in gpus:
            log(f"[{i}] {n}")
        if not gpus:
            log("No graphics card usable for WebGPU found - compression will run on the CPU.")
        return

    t0 = time.time()
    splat_path = a.splat.resolve()
    site = a.site.resolve()
    is_repo = (site / "package.json").exists() and (site / "public").is_dir()
    tours_root = (site / "public" / "tours") if is_repo else (site / "tours")
    out = tours_root / a.name
    work = out / "_work"
    work.mkdir(parents=True, exist_ok=True)

    # ---- 1. camera path
    sparse = a.sparse or find_sparse(splat_path)
    if not sparse:
        sys.exit("Could not find the COLMAP sparse folder; pass --sparse <dataset>\\sparse\\0")
    log(f"Camera path   {sparse}")
    imgs = read_images_bin(sparse / "images.bin") if (sparse / "images.bin").exists() else read_images_txt(sparse / "images.txt")
    # order by frame number and merge the lenses of a 360 rig into one point per moment
    def frame_no(name):
        stem = Path(name).stem
        m = re.search(r"frame[_-]?(\d+)", stem, re.I) or (re.findall(r"(\d+)", stem) or [None])[-1]
        return int(m.group(1)) if hasattr(m, "group") else (int(m) if m else None)
    nums = [frame_no(n) for n, _, _ in imgs]
    s, Rst, tst, stp = load_scene_transform(splat_path)
    to_train = lambda c: s * (Rst @ c) + tst  # into the splat's training frame
    downs = np.array([Rst @ d for _, _, d in imgs])
    if all(v is not None for v in nums):
        groups = {}
        for v, (_, c, _) in zip(nums, imgs):
            groups.setdefault(v, []).append(c)
        path_pts = np.array([to_train(np.mean(groups[v], 0)) for v in sorted(groups)])
    else:
        imgs.sort(key=lambda x: x[0])
        path_pts = np.array([to_train(c) for _, c, _ in imgs])
    if stp:
        log(f"Scene frame   {stp.name} (scale {s:g})")
    log(f"              {len(imgs)} images -> {len(path_pts)} positions")

    # ---- 2. splat
    log(f"Splat         {splat_path}")
    data, header = read_ply(splat_path)
    xyz = np.stack([data["x"], data["y"], data["z"]], 1).astype(np.float64)
    opacity = 1 / (1 + np.exp(-np.asarray(data["opacity"], np.float64)))
    size = np.exp(np.max(np.stack([data["scale_0"], data["scale_1"], data["scale_2"]], 1), 1).astype(np.float64))
    log(f"              {len(data):,} gaussians")

    # ---- 3. up direction
    solid = (opacity > 0.35) & (size < 0.3)
    if a.up != "auto":
        up = np.zeros(3); up["xyz".index(a.up[1])] = 1.0 if a.up[0] == "+" else -1.0
        how = "--up"
    else:
        # A handheld 360 camera is held upright, so the image "down" of the frames points at the
        # floor. This works for any number of storeys (floor/ceiling heuristics get fooled there).
        mdown = downs.mean(0)
        if np.linalg.norm(mdown) > 0.4:
            up = -mdown / np.linalg.norm(mdown)
            how = f"camera orientation ({100 * np.mean(downs @ -up > 0.5):.0f}% of frames agree)"
        else:  # fallback: flattest direction of the path, sign from floor-vs-ceiling distance
            evals, evecs = np.linalg.eigh(np.cov((path_pts - path_pts.mean(0)).T))
            up = evecs[:, 0]
            h, w = column_heights(xyz[solid], opacity[solid], path_pts, up)
            fl, _ = peak(h, w, -2.6, -0.4); ce, _ = peak(h, w, 0.15, 2.0)
            if fl is not None and ce is not None and abs(ce) > abs(fl):
                up = -up
            how = "path shape (camera orientation unclear)"
        k = int(np.argmax(np.abs(up)))
        axis = np.zeros(3); axis[k] = np.sign(up[k])
        if math.degrees(math.acos(min(1.0, abs(up @ axis)))) < 12:
            up = axis  # the scene is sensor-levelled; snap to the exact axis
    log(f"Up axis       {np.round(up, 3).tolist()}  from {how}")

    # ---- 4. floor under every path position (handles several storeys)
    quats = np.stack([data["rot_0"], data["rot_1"], data["rot_2"], data["rot_3"]], 1).astype(np.float64)
    scales_lin = np.exp(np.stack([data["scale_0"], data["scale_1"], data["scale_2"]], 1).astype(np.float64))
    floor_d = floor_under_path(path_pts, xyz, opacity, scales_lin, quats, up, log=log)
    if floor_d is None:
        sys.exit("No floor found below the camera path. Re-run with --up (try +z, -z, +y or -y).")
    cam_height = float(np.median(floor_d))
    feet_w = path_pts - floor_d[:, None] * up
    log(f"Camera height {cam_height:.2f} m above the floor (median; {floor_d.min():.2f}-{floor_d.max():.2f})")
    if not 0.9 < cam_height < 2.4:
        log("  ! unusual camera height - check the scale/up axis in the viewer (?edit)")

    # ---- 5. spawn + facing
    i0 = min(max(a.spawn, 0), len(path_pts) - 1)
    spawn_cam = path_pts[i0]
    spawn_floor = feet_w[i0]
    fwd = None
    for j in range(i0 + 1, len(path_pts)):
        d = path_pts[j] - spawn_cam
        d -= (d @ up) * up
        if np.linalg.norm(d) > 1.0:
            fwd = d / np.linalg.norm(d)
            break
    if fwd is None:
        fwd = basis_for(up)[0]

    # world -> tour frame: +Y up, -Z = first walking direction, origin = floor at spawn
    y_ax = up
    z_ax = -fwd
    x_ax = np.cross(y_ax, z_ax); x_ax /= np.linalg.norm(x_ax)
    z_ax = np.cross(x_ax, y_ax)
    R_out = np.stack([x_ax, y_ax, z_ax])
    t_out = -R_out @ spawn_floor
    to_tour = lambda p: (R_out @ np.asarray(p).T).T + t_out

    # ---- 6. crop
    tree = cKDTree(path_pts)
    dist, _ = tree.query(xyz, k=1, distance_upper_bound=a.crop + 1e-3)
    keep = np.isfinite(dist) & (size <= a.max_size) & (opacity >= a.min_opacity)
    log(f"Crop          keep {keep.sum():,} of {len(keep):,} "
        f"(path radius {a.crop} m, max blob {a.max_size} m) - removed {100 * (1 - keep.mean()):.0f}%")
    cropped = work / "cropped.ply"
    write_ply(cropped, data[keep], header)

    # ---- 6. level with splat-transform (rotates spherical harmonics correctly)
    # Frames: splat-transform (and the PlayCanvas engine) work in "engine space", which is the
    # PLY file frame turned 180 degrees about Z (F). The tour is authored in engine space, so
    # the aligned file must hold F @ tour; -r/-t act in engine space, hence A = R_out @ F.
    F = np.diag([-1.0, -1.0, 1.0])
    eul = euler_for(R_out @ F)
    aligned = work / "aligned.ply"
    log("Aligning")
    if not run_st([cropped, "-r", ",".join(f"{v:.6f}" for v in eul), "-t", ",".join(f"{v:.6f}" for v in t_out), aligned], "level + move to origin"):
        sys.exit(1)
    # verify the transform landed where we expected
    chk, _ = read_ply(aligned)
    got = np.stack([chk["x"], chk["y"], chk["z"]], 1)[:: max(1, len(chk) // 3000)]
    exp = to_tour(xyz[keep]) @ F
    err = cKDTree(exp).query(got)[0]
    if np.median(err) > 1e-3:
        sys.exit(f"Alignment check failed (median error {np.median(err):.3f}); please report this.")

    # ---- 7. compress + collision
    files = {}
    if a.no_sog:
        shutil.copy(aligned, out / "tour.ply"); files["splat"] = "tour.ply"
    else:
        log("Compressing")
        attempts = gpu_attempts(a.gpu, a.gpu_backend)

        def run_gpu(args, desc):
            """Run a splat-transform step on the first device that works (graphics card first)."""
            while attempts:
                label, extra = attempts[0]
                if run_st(extra + [str(x) for x in args], f"{desc} on {label}"):
                    return
                attempts.pop(0)  # don't retry a device that failed for the rest of this run
                if attempts:
                    log(f"  retrying on {attempts[0][0]}" + (" (slower)" if attempts[0][0] == "CPU" else ""))
            sys.exit(1)

        def to_sog(src, desc, dst=None, extra=()):
            dst = dst or out / "tour.sog"
            run_gpu([src, *extra, dst], desc)
            import zipfile
            ver = json.loads(zipfile.ZipFile(dst).read("meta.json")).get("version")
            if ver != SOG_VERSION:
                dst.unlink()
                sys.exit(f"{dst.name} was written as SOG version {ver}; the viewer reads version {SOG_VERSION}. "
                         f"Nothing was published. Use {SPLAT_TRANSFORM_PKG} (a newer splat-transform is installed).")
        to_sog(aligned, "SOG")
        mb = (out / "tour.sog").stat().st_size / 1e6
        pct = 100.0
        for _ in range(4):  # thin until it fits under the per-file limit
            if not a.max_mb or mb <= a.max_mb:
                break
            pct = max(5.0, pct * a.max_mb / mb * 0.9)
            log(f"  tour.sog is {mb:.1f} MB (limit {a.max_mb:g} MB) - keeping the {pct:.0f}% most important splats")
            thin = work / "thinned.ply"
            run_gpu([aligned, "-d", f"{pct:.0f}%", thin], "thin")
            to_sog(thin, "SOG")
            mb = (out / "tour.sog").stat().st_size / 1e6
            log(f"  tour.sog is now {mb:.1f} MB")
        lite = out / "tour-lite.sog"
        # --lite is a share of the published tour (after the size limit thinned it), not of the trained splat,
        # and a phone gets at most LITE_MAX splats: a 3M-splat training once gave a 900k light version that
        # phones could not draw.
        n_all = int(np.count_nonzero(keep)) if getattr(keep, "dtype", None) == bool else len(keep)
        lite_pct = min(a.lite * pct / 100, 100.0 * LITE_MAX / max(1, n_all)) if a.lite else 0
        if a.lite and 0 < a.lite < 100:
            log(f"Light version ({a.lite:g}% of the tour's splats, at most {LITE_MAX:,}; {lite_pct:.0f}% of the trained ones, for phones and slower computers)")
            thin = work / "lite.ply"
            run_gpu([aligned, "-d", f"{max(1, round(lite_pct))}%", thin], "thin")
            to_sog(thin, "light SOG", lite, ["-H", "1"])
            files["splatLite"] = lite.name
        elif lite.exists():
            lite.unlink()
        files["splat"] = "tour.sog"
    k2 = keep  # same splats as the tour, in tour space
    sc = scales_lin[k2]
    # rotate splat orientations into tour space: q_tour = q(R_out) * q
    q_t = (Rotation.from_matrix(R_out) * Rotation.from_quat(quats[k2][:, [1, 2, 3, 0]])).as_quat()[:, [3, 0, 1, 2]]
    xyz_t, feet_t = to_tour(xyz[k2]), to_tour(feet_w)
    if not a.no_collision:
        log("Collision (walkable space around your path)")
        import collision as col
        V, T = col.build(xyz_t, opacity[k2], sc, q_t, feet_t, log=lambda m: log(m))
        col.write_glb(out / "collision.glb", V, T)
        files["collision"] = "collision.glb"
        mesh = (V, T)
    else:
        mesh = None
        files["collision"] = "collision.glb" if (out / "collision.glb").exists() else None

    prev = json.loads((out / "tour.json").read_text(encoding="utf-8")) if (out / "tour.json").exists() else {}
    tour_path, last = [], None
    for f in to_tour(feet_w):
        if last is None or np.linalg.norm(f - last) > 0.5:
            tour_path.append([round(float(v), 3) for v in f]); last = f
    # an earlier version of this tour: lay its frame on this one before keeping what was drawn by hand
    fit, moved = None, False
    if prev.get("path") and (prev.get("map") or prev.get("spawn")):
        fit = fit_frames(prev["path"], tour_path)
        if fit and fit[2] <= 0.35:
            M_, t_, err = fit
            turn = math.degrees(math.atan2(M_[1, 0], M_[0, 0]))
            moved = abs(turn) > 0.3 or np.hypot(*t_) > 0.05
            log(f"Earlier tour  its walk matches this one to {err * 100:.0f} cm" + (f"; rooms and start points moved {np.hypot(*t_):.2f} m and turned {turn:+.1f}°" if moved else ""))
            if moved:
                if prev.get("map"):
                    prev["map"] = move_map(prev["map"], M_, t_)
                if prev.get("spawn"):
                    prev["spawn"] = move_start(prev["spawn"], M_, t_)
        else:
            log("Earlier tour  its walk does not match this one" + (f" ({fit[2]:.2f} m apart)" if fit else "") + "; rooms and start points are made new")
            prev.pop("map", None); prev.pop("spawn", None)
    plan = prev.get("map") if a.no_map else None
    if not a.no_map:
        log("Floor plan (storeys, rooms, plan pictures)")
        try:
            import rooms
            old_map = None if a.fresh_rooms else (prev.get("map") or None)
            angle = old_map.get("angle") if old_map and old_map.get("edited") else None
            dc = np.stack([data["f_dc_0"], data["f_dc_1"], data["f_dc_2"]], 1)[k2].astype(np.float64) if "f_dc_0" in data.dtype.names else None
            plan, pics = rooms.build_map(xyz_t, opacity[k2], sc, q_t, feet_t, dc, lang=a.lang, angle=angle, log=log)
            plan = rooms.carry_over(plan, old_map)
            if old_map and old_map.get("edited") and plan.get("rooms") is old_map.get("rooms"):
                plan = match_storeys(plan, old_map.get("levels") or [], pics, log=log)
            for old_pic in out.glob("plan-*.*"):
                old_pic.unlink()
            for n, b in pics.items():
                (out / n).write_bytes(b)
        except Exception as e:  # the tour still works without a plan
            log(f"  ! floor plan skipped: {e}")
            plan = prev.get("map")

    # ---- 8. tour.json
    bxyz = to_tour(xyz[keep][:: max(1, keep.sum() // 200000)])
    tour = {
        "title": a.title or a.name.replace("-", " ").title(),
        "eyebrow": a.eyebrow, "subtitle": a.subtitle, "lang": a.lang,
        "splat": files["splat"], "collision": files["collision"],
        **({"splatLite": files["splatLite"]} if files.get("splatLite") else {}),
        **({"map": plan} if plan else {}),
        "spawn": {"position": [0, 0, 0], "yaw": 0},
        "eyeHeight": a.eye_height,
        "bounds": {"min": np.percentile(bxyz, 0.5, 0).round(2).tolist(), "max": np.percentile(bxyz, 99.5, 0).round(2).tolist()},
        "captured": {"cameraHeight": round(cam_height, 3), "source": str(splat_path), "positions": len(path_pts),
                     "tourFromSplat": np.vstack([np.hstack([R_out, t_out[:, None]]), [0, 0, 0, 1]]).round(6).tolist()},
        "path": tour_path,
        "created": time.strftime("%Y-%m-%d %H:%M"),
    }
    old = out / "tour.json"
    if prev:  # re-publishing: keep anything edited by hand unless overridden now
        given = {"title": a.title, "eyebrow": a.eyebrow, "subtitle": a.subtitle}
        for k in ("title", "eyebrow", "subtitle"):
            if not given[k] and prev.get(k):
                tour[k] = prev[k]
        for k in ("spawn", "eyeHeight", "walkSpeed", "runSpeed", "fov", "background"):
            if k in prev and k not in ("spawn",) or (k == "spawn" and a.spawn == 0 and k in prev):
                tour[k] = prev[k]
    # every start point must be a place you can stand and walk away from
    if mesh is not None:
        starts = [("start", tour["spawn"])] + [(r.get("name") or r.get("id"), r["start"]) for r in (tour.get("map") or {}).get("rooms", []) if r.get("start")]
        for name, st in starts:
            pos, changed = free_start(st["position"], tour_path, *mesh)
            if changed:
                log(f"  start point '{name}' was inside or behind a wall; moved {np.hypot(pos[0] - st['position'][0], pos[2] - st['position'][2]):.2f} m towards the walk")
                st["position"] = pos
    old.write_text(json.dumps(tour, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- 9. site: viewer + index
    viewer_src = HERE / "viewer"
    if viewer_src.exists() and not is_repo:
        for f in viewer_src.rglob("*"):
            if f.is_file() and "tours" not in f.relative_to(viewer_src).parts:
                dst = site / f.relative_to(viewer_src)
                dst.parent.mkdir(parents=True, exist_ok=True)
                if not dst.exists() or dst.stat().st_mtime < f.stat().st_mtime:
                    shutil.copy2(f, dst)
    idx_path = tours_root / "index.json"
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else {"tours": []}
    idx["tours"] = [t for t in idx["tours"] if t["id"] != a.name] + [{"id": a.name, "title": tour["title"]}]
    idx.setdefault("default", a.name)
    idx_path.write_text(json.dumps(idx, indent=2, ensure_ascii=False))

    if not a.keep:
        shutil.rmtree(work, ignore_errors=True)

    sizes = {p.name: p.stat().st_size / 1e6 for p in out.iterdir() if p.is_file()}
    log("")
    log(f"Done in {time.time() - t0:.0f}s -> {out}")
    for n, mb in sorted(sizes.items()):
        log(f"  {n:16s} {mb:8.1f} MB")
    big = [n for n, mb in sizes.items() if mb > 20]
    if big:
        log(f"\n  ! {', '.join(big)} is over 20 MB - Webflow Cloud will refuse it. Lower --max-mb or --crop.")
    if is_repo:
        log(f"\nCommit and push the repo; the tour will be at  <your site>/intus?t={a.name}")
        log(f"Make it the start page by setting \"default\": \"{a.name}\" in {idx_path}")
    else:
        log(f"\nTry it locally:  python -m http.server 8000 --directory \"{site}\"")
        log(f"then open        http://localhost:8000/?t={a.name}   (add &edit for dev keys)")


if __name__ == "__main__":
    main()
