"""
CPU collision builder for walkable splat tours.

Builds the walkable space as a voxel volume around the path you actually walked:
  1. Voxelise the solid gaussians (walls, floors, furniture); drop small floating specks.
  2. Allow only space near the walked path: within `reach` metres sideways, from just
     below the floor you walked on up to ceiling height. This closes holes in the floor
     (glass, dark or shiny floors reconstruct badly), keeps visitors from wandering out
     through windows into the void, and is why this works on any capture without a GPU.
  3. Flood-fill the free, allowed space from the path itself.
  4. Emit the boundary of that space as a triangle mesh (greedy-merged quads) -> GLB.

All coordinates are tour space: metres, +Y up.
"""
from __future__ import annotations

import json
import struct

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree


def _quat_to_mats(q):
    w, x, y, z = (q / np.linalg.norm(q, axis=1, keepdims=True)).T
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1),
    ], 1)


def build(xyz, opacity, scales, quats, feet, *, voxel=0.05, reach=2.5, headroom=2.3,
          below=0.05, min_opacity=0.3, max_size=0.3, density=0.6, speck=40, tunnel=0.45, wall=6,
          stair_reach=0.5, riser=0.18, log=print, debug=None):
    """xyz (N,3), opacity (N,), scales (N,3) linear, quats (N,4) wxyz, all in tour space.
    feet (M,3): floor points under the walked path. Returns (vertices, triangle indices)."""
    feet = np.asarray(feet, float)
    lo = feet.min(0) - [reach + 0.3, below + 0.3, reach + 0.3]
    hi = feet.max(0) + [reach + 0.3, headroom + 0.3, reach + 0.3]
    shape = np.ceil((hi - lo) / voxel).astype(int) + 1
    log(f"  grid {shape[0]}x{shape[1]}x{shape[2]} at {voxel * 100:.0f} cm")

    # 1. solid occupancy -------------------------------------------------------
    sel = (opacity >= min_opacity) & (scales.max(1) <= max_size)
    inside = np.all((xyz >= lo) & (xyz <= hi), 1)
    sel &= inside
    P, O, S, Q = xyz[sel], opacity[sel], scales[sel], quats[sel]
    grid = np.zeros(shape, np.float32)

    def stamp(points, w):
        ijk = np.floor((points - lo) / voxel).astype(int)
        ok = np.all((ijk >= 0) & (ijk < shape), 1)
        np.add.at(grid, tuple(ijk[ok].T), w[ok])

    stamp(P, O)
    big = S.max(1) > voxel * 0.75  # spread larger splats over the voxels they cover
    if big.any():
        R = _quat_to_mats(Q[big])
        rng = np.random.default_rng(0)
        n = 6
        for _ in range(n):
            local = rng.standard_normal((big.sum(), 3)) * S[big]
            stamp(P[big] + np.einsum("nij,nj->ni", R, local), O[big])
    solid = grid >= density
    lab, nlab = ndimage.label(solid, structure=np.ones((3, 3, 3)))
    if nlab:
        sizes = np.bincount(lab.ravel())
        keep = sizes >= speck
        keep[0] = False
        solid = keep[lab]
    # the person carrying the camera was always within ~0.5 m of it, and leaves a faint "ghost"
    # along the whole path. That space is also, by definition, space a person fits through: clear it.
    dense, last = [], None
    for a_, b_ in zip(feet[:-1], feet[1:]):
        n = max(1, int(np.linalg.norm(b_ - a_) / 0.1))
        for t in np.linspace(0, 1, n, endpoint=False):
            dense.append(a_ + (b_ - a_) * t)
    dense.append(feet[-1])
    rt = int(np.ceil(tunnel / voxel))
    ti, tk = np.mgrid[-rt:rt + 1, -rt:rt + 1]
    tdisk = (ti ** 2 + tk ** 2) * voxel ** 2 <= tunnel ** 2
    for f in dense:
        ci, cj, ck = np.floor((f - lo) / voxel).astype(int)
        j0 = max(0, int(np.floor((f[1] + 0.12 - lo[1]) / voxel)))
        j1 = min(shape[1], int(np.ceil((f[1] + 2.0 - lo[1]) / voxel)))
        i0, k0 = ci - rt, ck - rt
        i0c, i1c = max(i0, 0), min(ci + rt + 1, shape[0])
        k0c, k1c = max(k0, 0), min(ck + rt + 1, shape[2])
        sub = tdisk[i0c - i0:i1c - i0, k0c - k0:k1c - k0]
        solid[i0c:i1c, j0:j1, k0c:k1c] &= ~sub[:, None, :]
    log(f"  solid voxels {int(solid.sum()):,} (after clearing your walking tunnel)")

    # 2. floors from the walked path -------------------------------------------------
    # Storey levels are foot heights shared by many path positions. Positions between levels
    # are on stairs. Floor plates are laid around level positions; stairs follow the steps taken.
    nx, ny, nz = shape
    fy = feet[:, 1]
    vals, counts = np.unique(np.round(fy / 0.05) * 0.05, return_counts=True)
    levels = []
    for v_, c_ in sorted(zip(vals, counts), key=lambda t: -t[1]):
        if c_ >= max(5, 0.05 * len(feet)) and all(abs(v_ - L) > 0.5 for L in levels):
            levels.append(float(v_))
    levels.sort()
    near_level = np.array([min(levels, key=lambda L: abs(L - y)) for y in fy])
    on_level = np.abs(fy - near_level) < 0.08
    log(f"  storey floors at {', '.join(f'{L:+.2f}' for L in levels)} m; "
        f"{int((~on_level).sum())} path positions on stairs")

    gx = lo[0] + (np.arange(nx) + 0.5) * voxel
    gz = lo[2] + (np.arange(nz) + 0.5) * voxel
    GX, GZ = np.meshgrid(gx, gz, indexing="ij")
    cols = np.c_[GX.ravel(), GZ.ravel()]

    # stairs: stretches where the path leaves a level, from the floor position before to the one
    # after. Each staircase is built from the first pass only - a later pass over the same stairs
    # (going back down, say) gives slightly different heights and would turn the ramp into a sawtooth.
    stair, kept = [], []
    i = 0
    while i < len(feet) - 1:
        if on_level[i] and on_level[i + 1] and near_level[i] == near_level[i + 1]:
            i += 1
            continue
        j = i + 1
        while j < len(feet) - 1 and not on_level[j]:
            j += 1
        run = feet[i:j + 1]
        if not any(np.min(np.linalg.norm(run[:, None, [0, 2]] - k[None, :, [0, 2]], axis=2)) < 0.8 for k in kept):
            kept.append(run)
            for a_, b_ in zip(run[:-1], run[1:]):
                n = max(1, int(np.linalg.norm(b_ - a_) / 0.1))
                for t in np.linspace(0, 1, n + 1):
                    stair.append(a_ + (b_ - a_) * t)
        i = j
    stair = np.array(stair) if stair else np.zeros((0, 3))
    stair_y = np.full(nx * nz, np.nan)
    if len(stair):
        d, i = cKDTree(stair[:, [0, 2]]).query(cols, distance_upper_bound=stair_reach)
        ok = np.isfinite(d)
        stair_y[ok] = stair[i[ok], 1]
    stair_y = stair_y.reshape(nx, nz)
    is_stair = np.isfinite(stair_y)
    # flat treads with ~18 cm risers spaced evenly between the floors: climbable at any steepness
    q = stair_y.copy()
    for L0, L1 in zip(levels[:-1], levels[1:]):
        r = (L1 - L0) / max(1, round((L1 - L0) / riser))
        m = is_stair & (stair_y >= L0 - 0.1) & (stair_y <= L1 + 0.1)
        q[m] = L0 + np.round((stair_y[m] - L0) / r) * r
    stair_y = q

    H = int(round(2.0 / voxel))            # walkable height above each floor
    b0, b1 = int(round(0.3 / voxel)), int(round(1.9 / voxel))  # body band that decides "wall"
    csum = np.concatenate([np.zeros((nx, 1, nz), np.int32), np.cumsum(solid, axis=1, dtype=np.int32)], 1)

    def body_solid(jf):
        """solid voxel count in the body band above floor index jf (2D: per column)."""
        lo_j, hi_j = np.clip(jf + b0, 0, ny), np.clip(jf + b1, 0, ny)
        if np.ndim(jf) == 0:
            return csum[:, hi_j, :] - csum[:, lo_j, :]
        ii, kk = np.indices((nx, nz))
        return csum[ii, hi_j, kk] - csum[ii, lo_j, kk]

    walk = np.zeros(shape, bool)
    level_pts = feet[on_level]
    for L in levels:
        pts = level_pts[np.abs(level_pts[:, 1] - L) < 0.08]
        if not len(pts):
            continue
        d, _ = cKDTree(pts[:, [0, 2]]).query(cols, distance_upper_bound=reach)
        plate = np.isfinite(d).reshape(nx, nz)
        jf = int(round((L - lo[1]) / voxel))
        # real floor evidence near this level (keeps plates indoors). Smooth floors are made of
        # large flat splats, so every splat near the level counts, spread over its footprint.
        near = (np.abs(xyz[:, 1] - L) < 0.2) & (opacity > 0.2) & (scales.max(1) < 2.0)
        has = np.zeros((nx, nz), bool)
        if near.any():
            Rn = _quat_to_mats(quats[near])
            rng = np.random.default_rng(1)
            for _ in range(8):
                pts_ = xyz[near] + np.einsum("nij,nj->ni", Rn, rng.uniform(-1, 1, (near.sum(), 3)) * scales[near])
                ii = np.floor((pts_[:, 0] - lo[0]) / voxel).astype(int)
                kk = np.floor((pts_[:, 2] - lo[2]) / voxel).astype(int)
                ok = (ii >= 0) & (ii < nx) & (kk >= 0) & (kk < nz)
                has[ii[ok], kk[ok]] = True
        has = ndimage.binary_closing(has, structure=np.ones((3, 3)), iterations=6, border_value=1)
        # wherever you walked there is floor, whatever the reconstruction says
        dw, _ = cKDTree(pts[:, [0, 2]]).query(cols, distance_upper_bound=0.8)
        has |= np.isfinite(dw).reshape(nx, nz)
        plate &= has
        rel = np.nan_to_num(stair_y, nan=L) - L
        # treads within body height above this floor replace it; treads 2 m+ overhead leave room
        # to walk underneath; stairs going down from this floor open a stairwell in it
        plate &= ~(is_stair & (((rel > 0.05) & (rel < 2.0)) | (rel < -0.05)))
        plate &= body_solid(jf) < wall
        walk[:, jf:jf + H, :] |= plate[:, None, :]
    if is_stair.any():
        jfs = np.where(is_stair, np.round((np.nan_to_num(stair_y) - lo[1]) / voxel), -1).astype(int)
        ok = is_stair & (body_solid(np.clip(jfs, 0, ny - 1)) < wall)
        top = min(ny, int(round((max(levels) + 2.0 - lo[1]) / voxel)))  # open stairwell above
        for jf in np.unique(jfs[ok]):
            m = ok & (jfs == jf)
            walk[:, jf:max(jf + H, top), :] |= m[:, None, :]
    log(f"  walkable floor {walk.any(1).sum() * voxel ** 2:.0f} m²")

    # 4. boundary of the walkable space -> greedy quads ---------------------------
    verts, tris = [], []
    vmap = {}

    def vid(p):
        k = tuple(np.round(p, 4))
        if k not in vmap:
            vmap[k] = len(verts)
            verts.append(k)
        return vmap[k]

    for axis in range(3):
        for sgn in (1, -1):
            nb = np.roll(walk, -sgn, axis=axis)
            edge = [slice(None)] * 3
            edge[axis] = -1 if sgn == 1 else 0
            nb[tuple(edge)] = False
            face = walk & ~nb  # walkable cell whose neighbour in this direction is not
            u, v = [a for a in range(3) if a != axis]
            for k in range(shape[axis]):
                sl = [slice(None)] * 3
                sl[axis] = k
                m = face[tuple(sl)].copy()
                if not m.any():
                    continue
                plane = lo[axis] + (k + (1 if sgn == 1 else 0)) * voxel
                # greedy rectangles over the 2D mask
                for a in range(m.shape[0]):
                    b = 0
                    while b < m.shape[1]:
                        if not m[a, b]:
                            b += 1
                            continue
                        b1 = b
                        while b1 < m.shape[1] and m[a, b1]:
                            b1 += 1
                        a1 = a + 1
                        while a1 < m.shape[0] and m[a1, b:b1].all():
                            a1 += 1
                        m[a:a1, b:b1] = False
                        c = []
                        for (ua, vb) in ((a, b), (a1, b), (a1, b1), (a, b1)):
                            p = np.zeros(3)
                            p[axis] = plane
                            p[u] = lo[u] + ua * voxel
                            p[v] = lo[v] + vb * voxel
                            c.append(vid(p))
                        # face the inside of the walkable space (both windings work for Rapier)
                        if sgn == 1:
                            tris += [(c[0], c[1], c[2]), (c[0], c[2], c[3])]
                        else:
                            tris += [(c[0], c[2], c[1]), (c[0], c[3], c[2])]
                        b = b1
    if debug is not None:
        debug.update(walk=walk, solid=solid, allowed=walk, lo=lo, voxel=voxel, grid=grid)
    V = np.array(verts, np.float32)
    T = np.array(tris, np.uint32)
    log(f"  collision mesh {len(T):,} triangles")
    return V, T


def write_glb(path, V, T):
    pos = np.ascontiguousarray(V, np.float32).tobytes()
    idx = np.ascontiguousarray(T, np.uint32).ravel().tobytes()
    gltf = {
        "asset": {"version": "2.0", "generator": "intus collision"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "collision"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(pos) + len(idx)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos)},
                        {"buffer": 0, "byteOffset": len(pos), "byteLength": len(idx)}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(V), "type": "VEC3",
                       "min": V.min(0).tolist(), "max": V.max(0).tolist()},
                      {"bufferView": 1, "componentType": 5125, "count": T.size, "type": "SCALAR"}],
    }
    js = json.dumps(gltf).encode()
    js += b" " * (-len(js) % 4)
    bn = pos + idx
    bn += b"\0" * (-len(bn) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bn)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(bn), 0x004E4942) + bn)
