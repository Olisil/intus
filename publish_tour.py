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
SPLAT_TRANSFORM_PKG = "@playcanvas/splat-transform@3"


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
    """Return list of (name, camera_center). Skips 2D points without parsing them."""
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
            out.append((name.decode("utf-8", "replace"), -R.T @ np.array([tx, ty, tz])))
    return out


def read_images_txt(path: Path):
    out = []
    lines = [l for l in path.read_text().splitlines() if l and not l.startswith("#")]
    for i in range(0, len(lines), 2):
        p = lines[i].split()
        q = np.array(list(map(float, p[1:5])))
        t = np.array(list(map(float, p[5:8])))
        R = qvec_to_rotmat(q / np.linalg.norm(q))
        out.append((p[9], -R.T @ t))
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


# --------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--splat", required=True, type=Path, help="trained splat .ply")
    ap.add_argument("--name", required=True, help="tour id, used in the URL (?t=<name>)")
    ap.add_argument("--title", help="tour title shown to visitors")
    ap.add_argument("--subtitle", default="", help="line under the title, e.g. an address")
    ap.add_argument("--eyebrow", default="", help="small label above the title, e.g. the broker")
    ap.add_argument("--lang", default="sv", choices=["sv", "en"], help="viewer language (default sv)")
    ap.add_argument("--sparse", type=Path, help="COLMAP sparse folder (auto-detected)")
    ap.add_argument("--site", type=Path, default=HERE / "site", help="site folder (viewer + tours)")
    ap.add_argument("--up", choices=["auto", "+x", "-x", "+y", "-y", "+z", "-z"], default="auto")
    ap.add_argument("--crop", type=float, default=5.0, help="keep splats within this many metres of the walked path")
    ap.add_argument("--max-size", type=float, default=1.5, help="drop haze blobs larger than this (metres)")
    ap.add_argument("--min-opacity", type=float, default=0.01)
    ap.add_argument("--spawn", type=int, default=0, help="index along the path to start from (0 = first frame)")
    ap.add_argument("--eye-height", type=float, default=1.6)
    ap.add_argument("--no-collision", action="store_true")
    ap.add_argument("--no-sog", action="store_true", help="skip SOG compression (write a PLY instead, for testing)")
    ap.add_argument("--keep", action="store_true", help="keep intermediate files")
    a = ap.parse_args()

    t0 = time.time()
    splat_path = a.splat.resolve()
    out = (a.site / "tours" / a.name).resolve()
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
    nums = [frame_no(n) for n, _ in imgs]
    s, Rst, tst, stp = load_scene_transform(splat_path)
    to_train = lambda c: s * (Rst @ c) + tst  # into the splat's training frame
    if all(v is not None for v in nums):
        groups = {}
        for v, (_, c) in zip(nums, imgs):
            groups.setdefault(v, []).append(c)
        path_pts = np.array([to_train(np.mean(groups[v], 0)) for v in sorted(groups)])
    else:
        imgs.sort(key=lambda x: x[0])
        path_pts = np.array([to_train(c) for _, c in imgs])
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

    # ---- 3. up direction and floor
    solid = (opacity > 0.35) & (size < 0.3)
    if a.up == "auto":
        # Candidates: the six axes (Spirula/360 Gaussian level the scene with the camera's
        # IMU, so up is normally one of them) plus the flattest direction of the path.
        cands = [np.eye(3)[i] * sgn for i in range(3) for sgn in (1, -1)]
        evals, evecs = np.linalg.eigh(np.cov((path_pts - path_pts.mean(0)).T))
        cands += [evecs[:, 0], -evecs[:, 0]]
        sub = np.flatnonzero(solid)[:: max(1, solid.sum() // 1_500_000)]
        best = None
        for cand in cands:
            h, w = column_heights(xyz[sub], opacity[sub], path_pts, cand)
            fl, fs = peak(h, w, -2.6, -0.4)
            ce, cs = peak(h, w, 0.15, 2.0)
            if fl is None or ce is None or abs(fl) <= abs(ce):
                continue  # need a floor below that is further away than the ceiling above
            score = fs + cs
            if best is None or score > best[0]:
                best = (score, cand, fl, ce)
        if best is None:
            sys.exit("Could not tell which way is up. Re-run with --up (try -y, +y or +z).")
        _, up, floor_h, ceil_h = best
    else:
        up = np.zeros(3); up["xyz".index(a.up[1])] = 1.0 if a.up[0] == "+" else -1.0
        h, w = column_heights(xyz[solid], opacity[solid], path_pts, up)
        floor_h, _ = peak(h, w, -2.6, -0.4)
        ceil_h, _ = peak(h, w, 0.15, 2.0)
        if floor_h is None:
            sys.exit("No floor found below the camera path with that --up.")
    cam_height = -floor_h
    log(f"Up axis       {np.round(up, 3).tolist()}")
    log(f"Camera height {cam_height:.2f} m above the floor" + (f", ceiling {ceil_h + cam_height:.2f} m" if ceil_h else ""))
    if not 0.9 < cam_height < 2.4:
        log("  ! unusual camera height - check the scale/up axis in the viewer (?edit)")

    # ---- 4. spawn + facing
    i0 = min(max(a.spawn, 0), len(path_pts) - 1)
    spawn_cam = path_pts[i0]
    near = path_pts[np.linalg.norm(path_pts - spawn_cam, axis=1) < 1.5]
    h_local, w_local = column_heights(xyz[solid], opacity[solid], near, up, radius=0.8)
    fl_local, _ = peak(h_local, w_local, -2.6, -0.4)
    spawn_floor = spawn_cam + (fl_local if fl_local is not None else floor_h) * up
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

    # ---- 5. crop
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
        if not run_st([aligned, out / "tour.sog"], "SOG"):
            log("  retrying on the CPU (slower)")
            if not run_st(["-g", "cpu", aligned, out / "tour.sog"], "SOG (CPU)"):
                sys.exit(1)
        files["splat"] = "tour.sog"
    if not a.no_collision:
        log("Collision")
        seed = f"0,{min(1.0, cam_height * 0.6):.2f},0"
        ok = run_st([aligned, "--seed-pos", seed, "--voxel-external-fill", "--voxel-carve", "1.6,0.2",
                     "--collision-mesh", "smooth", work / "collision.voxel.json"], "collision mesh")
        glbs = sorted(work.glob("*.glb"))
        if ok and glbs:
            shutil.move(str(glbs[0]), out / "collision.glb"); files["collision"] = "collision.glb"
        else:
            log("  ! no collision mesh - the tour will walk on a flat floor at y = 0")
            files["collision"] = None
    else:
        files["collision"] = None

    # ---- 8. tour.json
    tour_path, last = [], None
    for p in to_tour(path_pts):
        f = p - np.array([0, cam_height, 0])
        if last is None or np.linalg.norm(f - last) > 0.5:
            tour_path.append([round(float(v), 3) for v in f]); last = f
    bxyz = to_tour(xyz[keep][:: max(1, keep.sum() // 200000)])
    tour = {
        "title": a.title or a.name.replace("-", " ").title(),
        "eyebrow": a.eyebrow, "subtitle": a.subtitle, "lang": a.lang,
        "splat": files["splat"], "collision": files["collision"],
        "spawn": {"position": [0, 0, 0], "yaw": 0},
        "eyeHeight": a.eye_height,
        "bounds": {"min": np.percentile(bxyz, 0.5, 0).round(2).tolist(), "max": np.percentile(bxyz, 99.5, 0).round(2).tolist()},
        "captured": {"cameraHeight": round(cam_height, 3), "source": str(splat_path), "positions": len(path_pts),
                     "tourFromSplat": np.vstack([np.hstack([R_out, t_out[:, None]]), [0, 0, 0, 1]]).round(6).tolist()},
        "path": tour_path,
        "created": time.strftime("%Y-%m-%d %H:%M"),
    }
    old = out / "tour.json"
    if old.exists():  # re-publishing: keep anything edited by hand unless overridden now
        prev = json.loads(old.read_text())
        given = {"title": a.title, "eyebrow": a.eyebrow, "subtitle": a.subtitle}
        for k in ("title", "eyebrow", "subtitle"):
            if not given[k] and prev.get(k):
                tour[k] = prev[k]
        for k in ("spawn", "eyeHeight", "walkSpeed", "runSpeed", "fov", "background"):
            if k in prev and k not in ("spawn",) or (k == "spawn" and a.spawn == 0 and k in prev):
                tour[k] = prev[k]
    old.write_text(json.dumps(tour, indent=2, ensure_ascii=False))

    # ---- 9. site: viewer + index
    site = a.site.resolve()
    viewer_src = HERE / "viewer"
    if viewer_src.exists():
        for f in viewer_src.rglob("*"):
            if f.is_file() and "tours" not in f.relative_to(viewer_src).parts:
                dst = site / f.relative_to(viewer_src)
                dst.parent.mkdir(parents=True, exist_ok=True)
                if not dst.exists() or dst.stat().st_mtime < f.stat().st_mtime:
                    shutil.copy2(f, dst)
    idx_path = site / "tours" / "index.json"
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
    log(f"\nTry it locally:  python -m http.server 8000 --directory \"{site}\"")
    log(f"then open        http://localhost:8000/?t={a.name}   (add &edit for dev keys)")


if __name__ == "__main__":
    main()
