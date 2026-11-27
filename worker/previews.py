"""
Preview pictures while a tour is processed, so Intus admin can show what each step produced:

  frames    a few frames from each lens, side by side in time
  masks     frames with what will be removed tinted red
  cameras   the camera path and the point cloud seen from above, ceiling cut away
  depth     a few depth and normal maps
  training  the splat seen from above (refreshed while training runs)
  tour      the uploaded splat from above (when a finished splat is published)

Every function returns JPEG bytes, or None when there is nothing to show. Nothing here may stop a job:
callers catch every error.
"""
from __future__ import annotations

import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

IMG = (".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff")
BG = (17, 17, 19)
RED = np.array([235, 64, 52], np.float32)


def _jpeg(im: Image.Image, q: int = 80) -> bytes:
    b = io.BytesIO()
    im.convert("RGB").save(b, "JPEG", quality=q, optimize=True)
    return b.getvalue()


def _thumb(path: Path, side: int) -> Image.Image:
    im = Image.open(path)
    im.draft("RGB", (side * 2, side * 2))  # fast JPEG decode at a lower size
    im = im.convert("RGB")
    im.thumbnail((side, side))
    return im


def _grid(tiles: list[list[Image.Image]], side: int, gap: int = 6) -> Image.Image:
    rows, cols = len(tiles), max(len(r) for r in tiles)
    out = Image.new("RGB", (cols * side + (cols - 1) * gap, rows * side + (rows - 1) * gap), BG)
    for r, row in enumerate(tiles):
        for c, t in enumerate(row):
            out.paste(t, (c * (side + gap) + (side - t.width) // 2, r * (side + gap) + (side - t.height) // 2))
    return out


def _spread(items: list, n: int) -> list:
    if len(items) <= n:
        return items
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]


def images_in(d: Path) -> list[Path]:
    return sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() in IMG) if d.is_dir() else []


# ------------------------------------------------------------------ frames and masks

def frames(image_dirs: list[Path], n: int = 5, side: int = 300) -> bytes | None:
    """One row per lens (camera folder), the same moments in each row."""
    dirs = [d for d in image_dirs if images_in(d)][:4]
    if not dirs:
        return None
    rows = []
    for d in dirs:
        rows.append([_thumb(p, side) for p in _spread(images_in(d), n)])
    return _jpeg(_grid(rows, side))


def _mask_for(img: Path, mask_dir: Path, index: dict) -> Path | None:
    if mask_dir not in index:
        index[mask_dir] = {}
        for p in images_in(mask_dir):
            index[mask_dir].setdefault(p.name.split(".")[0], p)
    return index[mask_dir].get(img.name.split(".")[0])


def _disc(w: int, h: int, r: float = 0.46) -> np.ndarray:
    """The image circle of a fisheye lens (r as a share of the shorter side)."""
    y, x = np.mgrid[0:h, 0:w]
    return (x - (w - 1) / 2) ** 2 + (y - (h - 1) / 2) ** 2 <= (r * min(w, h)) ** 2


def _fisheye(a: np.ndarray) -> bool:
    k = max(2, a.shape[0] // 20)
    return float(np.mean([a[:k, :k].mean(), a[:k, -k:].mean(), a[-k:, :k].mean(), a[-k:, -k:].mean()])) < 12


def masks(images_root: Path, masks_root: Path, image_dirs: list[Path], n: int = 4, side: int = 360) -> tuple[bytes | None, str]:
    """Frames with the removed parts tinted red. Prefers frames where something was found. Also returns a summary line."""
    index: dict = {}
    pairs, found, total = [], 0, 0
    for d in image_dirs:
        md = masks_root / d.relative_to(images_root)
        for img in images_in(d):
            m = _mask_for(img, md, index)
            if not m:
                continue
            total += 1
            small = Image.open(m).convert("L").resize((64, 64))
            hit = ((np.asarray(small) < 128) & _disc(64, 64)).mean() > 0.002  # black = removed (Spirula's default)
            found += hit
            pairs.append((img, m, hit))
    if not pairs:
        return None, "no masks were written"
    hits = [p for p in pairs if p[2]]
    pick = _spread(hits, n) if len(hits) >= n else (hits + _spread([p for p in pairs if not p[2]], n - len(hits)))
    tiles = []
    for img, m, _ in pick:
        im = _thumb(img, side)
        mk = Image.open(m).convert("L").resize(im.size)
        a = np.asarray(im, np.float32)
        removed = np.asarray(mk) < 128
        if _fisheye(a):  # a 360 lens: outside its circle the mask is black too; leave that untinted
            removed &= _disc(im.width, im.height, 0.49)
        removed = removed[..., None]
        a = np.where(removed, a * 0.35 + RED * 0.65, a)
        tiles.append(Image.fromarray(a.clip(0, 255).astype(np.uint8)))
    return _jpeg(_grid([tiles], side)), f"something to remove was found in {found} of {total} frames"


# ------------------------------------------------------------------ depth and normals

_TURBO = np.array([[48, 18, 59], [65, 69, 171], [57, 126, 241], [27, 186, 222], [42, 233, 147], [137, 254, 74],
                   [212, 230, 52], [252, 177, 47], [237, 107, 30], [196, 45, 10], [122, 4, 3]], np.float32)


def _colorize(a: np.ndarray) -> Image.Image:
    a = a.astype(np.float32)
    ok = np.isfinite(a) & (a > 0)
    if not ok.any():
        return Image.fromarray(np.zeros((*a.shape, 3), np.uint8))
    lo, hi = np.percentile(a[ok], [2, 98])
    t = np.clip((a - lo) / max(1e-6, hi - lo), 0, 1) * (len(_TURBO) - 1)
    i = np.floor(t).astype(int).clip(0, len(_TURBO) - 2)
    f = (t - i)[..., None]
    rgb = _TURBO[i] * (1 - f) + _TURBO[i + 1] * f
    rgb[~ok] = 0
    return Image.fromarray(rgb.astype(np.uint8))


def _load_map(p: Path, side: int) -> Image.Image | None:
    if p.suffix.lower() == ".npy":
        a = np.load(p)
        a = a[..., 0] if a.ndim == 3 and a.shape[-1] == 1 else a
        im = _colorize(a) if a.ndim == 2 else Image.fromarray(((a[..., :3] * 0.5 + 0.5).clip(0, 1) * 255).astype(np.uint8))
    else:
        im = Image.open(p)
        if im.mode in ("I;16", "I;16B", "I", "F", "L"):
            im = _colorize(np.asarray(im))
        else:
            im = im.convert("RGB")
    im.thumbnail((side, side))
    return im


def depth(dataset: Path, since: float, n: int = 4, side: int = 300) -> bytes | None:
    """The depth and normal maps written by the geometry step (whatever their folder), newest files only."""
    skip = {"images", "masks", "sparse", "input", "outputs"}
    files = [p for p in dataset.rglob("*") if p.is_file() and p.suffix.lower() in (*IMG, ".npy")
             and not (set(p.relative_to(dataset).parts[:-1]) & skip) and p.stat().st_mtime >= since - 1]
    if not files:
        return None
    files.sort()
    dep = [p for p in files if "depth" in str(p).lower()]
    nor = [p for p in files if "normal" in str(p).lower()]
    pick = (_spread(dep, n // 2) + _spread(nor, n // 2)) if dep and nor else _spread(files, n)
    tiles = [t for t in (_load_map(p, side) for p in pick) if t is not None]
    return _jpeg(_grid([tiles], side)) if tiles else None


# ------------------------------------------------------------------ seen from above

def read_points3d_bin(path: Path, max_points: int = 400_000):
    """COLMAP points3D.bin -> (xyz, rgb)."""
    xyz, rgb = [], []
    with open(path, "rb") as f:
        buf = f.read()
    (n,) = struct.unpack_from("<Q", buf, 0)
    off = 8
    step = max(1, n // max_points)
    for i in range(n):
        x, y, z, r, g, b = struct.unpack_from("<3d3B", buf, off + 8)
        (tl,) = struct.unpack_from("<Q", buf, off + 43)
        if i % step == 0:
            xyz.append((x, y, z)); rgb.append((r, g, b))
        off += 51 + tl * 8
    return np.array(xyz, np.float64).reshape(-1, 3), np.array(rgb, np.uint8).reshape(-1, 3)


def read_points3d_txt(path: Path, max_points: int = 400_000):
    xyz, rgb = [], []
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            p = line.split()
            xyz.append(tuple(map(float, p[1:4]))); rgb.append(tuple(map(int, p[4:7])))
    xyz, rgb = np.array(xyz, np.float64).reshape(-1, 3), np.array(rgb, np.uint8).reshape(-1, 3)
    step = max(1, len(xyz) // max_points)
    return xyz[::step], rgb[::step]


def _basis(up):
    a = np.array([1.0, 0, 0]) if abs(up[0]) < 0.9 else np.array([0, 1.0, 0])
    e1 = np.cross(up, a); e1 /= np.linalg.norm(e1)
    return e1, np.cross(up, e1)


def plan(xyz: np.ndarray, rgb: np.ndarray, cams: np.ndarray, downs: np.ndarray, size: int = 900, dot: int = 1, title: str = "") -> bytes | None:
    """Everything below eye height seen from above, with the walked path in red (green = start)."""
    if len(xyz) < 50 or len(cams) < 2:
        return None
    up = -np.mean(downs, 0)
    up /= np.linalg.norm(up)
    e1, e2 = _basis(up)
    h, ch = xyz @ up, cams @ up
    eye = float(np.median(ch))
    keep = (h < eye + 0.15) & (h > eye - 3.0)
    xyz, rgb, h = xyz[keep], rgb[keep], h[keep]
    if len(xyz) < 50:
        return None
    u, v = xyz @ e1, xyz @ e2
    cu, cv = cams @ e1, cams @ e2
    lo = np.array([cu.min() - 4, cv.min() - 4]); hi = np.array([cu.max() + 4, cv.max() + 4])
    inside = (u > lo[0]) & (u < hi[0]) & (v > lo[1]) & (v < hi[1])
    if inside.sum() > 50:
        plo = np.percentile(np.stack([u[inside], v[inside]], 1), 1, 0)
        phi = np.percentile(np.stack([u[inside], v[inside]], 1), 99, 0)
        lo = np.minimum(np.maximum(lo, plo - 0.5), [cu.min() - 0.5, cv.min() - 0.5])
        hi = np.maximum(np.minimum(hi, phi + 0.5), [cu.max() + 0.5, cv.max() + 0.5])
    scale = (size - 40) / max(1e-6, float(max(hi - lo)))
    W = int((hi[0] - lo[0]) * scale) + 40
    H = int((hi[1] - lo[1]) * scale) + 40
    px = lambda a, b: (((a - lo[0]) * scale + 20).astype(int), ((hi[1] - b) * scale + 20).astype(int))
    x, y = px(u, v)
    ok = (x >= 0) & (x < W - dot + 1) & (y >= 0) & (y < H - dot + 1)
    order = np.argsort(h[ok])  # lowest first, so the highest point below eye height wins each pixel
    x, y, c = x[ok][order], y[ok][order], rgb[ok][order]
    img = np.zeros((H, W, 3), np.uint8); img[:] = BG
    for dx in range(dot):
        for dy in range(dot):
            img[y + dy, x + dx] = c
    im = Image.fromarray(img)
    d = ImageDraw.Draw(im)
    qx, qy = px(cu, cv)
    pts = list(zip(qx.tolist(), qy.tolist()))
    if len(pts) > 1:
        d.line(pts, fill=(235, 64, 52), width=2)
    d.ellipse([pts[0][0] - 5, pts[0][1] - 5, pts[0][0] + 5, pts[0][1] + 5], fill=(60, 200, 90))
    if title:
        d.text((12, 8), title, fill=(220, 220, 220))
    return _jpeg(im, 82)


def path_from_images(imgs) -> tuple[np.ndarray, np.ndarray]:
    """(centers, downs) from publish_tour.read_images_* output, ordered by name."""
    import re
    groups: dict = {}
    for name, c, d in imgs:
        nums = re.findall(r"(\d+)", Path(name).stem)
        key = (int(nums[-1]), "") if nums else (1 << 60, name)
        groups.setdefault(key, []).append((c, d))
    # the lenses of one moment become one point; moments in frame order
    order = sorted(groups)
    return (np.array([np.mean([c for c, _ in groups[k]], 0) for k in order]),
            np.array([np.mean([d for _, d in groups[k]], 0) for k in order]))


def cameras(sparse: Path, read_images) -> bytes | None:
    imgs = read_images(sparse)
    if not imgs:
        return None
    cams, downs = path_from_images(imgs)
    if (sparse / "points3D.bin").exists():
        xyz, rgb = read_points3d_bin(sparse / "points3D.bin")
    elif (sparse / "points3D.txt").exists():
        xyz, rgb = read_points3d_txt(sparse / "points3D.txt")
    else:
        return None
    return plan(xyz, rgb, cams, downs, dot=2, title=f"{len(imgs)} camera positions, {len(xyz):,} points")


def splat(ply: Path, sparse: Path | None, read_images, read_ply, scene_transform, max_points: int = 1_500_000) -> bytes | None:
    """The splat from above. The walked path comes from the cameras, moved into the splat's training frame."""
    data, _ = read_ply(ply)
    n = len(data)
    step = max(1, n // max_points)
    d = data[::step]
    xyz = np.stack([d["x"], d["y"], d["z"]], 1).astype(np.float64)
    op = 1 / (1 + np.exp(-np.asarray(d["opacity"], np.float64)))
    keep = op > 0.5
    if "scale_0" in d.dtype.names:
        keep &= np.exp(np.max(np.stack([d["scale_0"], d["scale_1"], d["scale_2"]], 1), 1)) < 0.25
    if "f_dc_0" in d.dtype.names:
        rgb = (0.5 + 0.2820948 * np.stack([d["f_dc_0"], d["f_dc_1"], d["f_dc_2"]], 1)).clip(0, 1) * 255
    else:
        rgb = np.full((len(d), 3), 200.0)
    xyz, rgb = xyz[keep], rgb[keep].astype(np.uint8)
    if sparse is None:
        return None
    imgs = read_images(sparse)
    if not imgs:
        return None
    cams, downs = path_from_images(imgs)
    s, R, t, _ = scene_transform(ply)
    cams = (s * (R @ cams.T)).T + t
    downs = (R @ downs.T).T
    return plan(xyz, rgb, cams, downs, dot=1, title=f"{n:,} splats")
