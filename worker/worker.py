#!/usr/bin/env python3
"""
Intus GPU worker: turns uploaded 360 video / photos into a published walkable tour.

It talks only to Intus admin (Probe) over HTTPS with the worker key; it never needs storage keys.
  1. claims a queued job (or the job it was started for)
  2. downloads the uploaded files
  3. runs the Spirula steps from recipes/<version>.json: frames, masks, cameras, depth, training
  4. runs tools/publish_tour.py (crop, level, SOG, collision, rooms)
  5. uploads the tour files and reports done
Along the way it sends a preview picture per step (previews.py), shown on the tour page.

A finished splat can be published as it is: upload its splat.ply with the images.bin of its dataset
(sparse/0) and, when Spirula wrote one, scene_transform.json. Steps 3 is then skipped.

Modes
  python worker.py poll              keep claiming jobs for this image's Spirula version (any machine with a GPU)
  python worker.py once [--job ID]   one job, then exit
  (handler.py runs `once` for a GPU-cloud request; see README.md)

Environment
  INTUS_API          https://probe.nassau.se/app/api/intus-worker
  INTUS_WORKER_KEY   the same value as the secret INTUS_WORKER_KEY on Probe
  SPIRULA_VERSION    e.g. v2026.11.12 (set in the image)
  SPIRULA            path to the spirula binary (default /opt/spirula/spirula)
  SPIRULA_MODELS     folder with the SAM / Grounding DINO weights (default: Spirula's cache)
  WORKER_NAME        shown in Intus admin (default: host name)
  WORK_DIR           scratch space (default /work); needs room for the video plus ~3x for frames
  KEEP_WORK=1        keep the scratch folder after a job (for debugging)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests

import previews

HERE = Path(__file__).resolve().parent
TOOLS = Path(os.environ["INTUS_TOOLS"]) if os.environ.get("INTUS_TOOLS") else HERE.parent / "tools"
sys.path.insert(0, str(TOOLS))
import publish_tour as pt  # noqa: E402  (camera and PLY readers for the previews)
API = os.environ.get("INTUS_API", "https://probe.nassau.se/app/api/intus-worker").rstrip("/")
KEY = os.environ.get("INTUS_WORKER_KEY", "")
VERSION = os.environ.get("SPIRULA_VERSION", "")
SPIRULA = os.environ.get("SPIRULA", "/opt/spirula/spirula")
# Model weights Spirula fetches into its cache; the image downloads them ahead (see Dockerfile).
MODELS = os.environ.get("SPIRULA_MODELS") or str(Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "spirula-studio" / "models")
NAME = os.environ.get("WORKER_NAME") or f"{socket.gethostname()}-{os.getpid()}"
WORK = Path(os.environ.get("WORK_DIR", "/work"))
PART = 32 * 1024 * 1024          # output parts (Probe accepts single files up to 90 MB)
SINGLE_MAX = 80 * 1024 * 1024
SPLAT = re.compile(r"\.ply$", re.I)
CAMERA_FILES = {"images.bin", "images.txt", "cameras.bin", "cameras.txt", "points3D.bin", "points3D.txt", "scene_transform.json"}
VIDEO = re.compile(r"\.(osv|insv|360|mp4|mov|m4v|mkv|avi|lrv)$", re.I)
PHOTO = re.compile(r"\.(jpe?g|png|tiff?|heic|dng|webp)$", re.I)
# Share of the whole job each step stands for, for one progress bar.
WEIGHTS = {"frames": 0.08, "masks": 0.12, "cameras": 0.15, "depth": 0.08, "training": 0.47, "tour": 0.07, "upload": 0.03}

S = requests.Session()
S.headers["authorization"] = f"Bearer {KEY}"


class Cancelled(Exception):
    pass


def api(method: str, op: str, **kw):
    for attempt in range(6):
        try:
            r = S.request(method, f"{API}/{op}", timeout=kw.pop("timeout", 120), **kw)
            if r.status_code >= 500:
                raise requests.HTTPError(f"{r.status_code} {r.text[:200]}")
            return r
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            if attempt == 5:
                raise
            time.sleep(3 * (attempt + 1))
            print(f"  retrying {op}: {e}", flush=True)


# ------------------------------------------------------------------ reporting

class Reporter:
    """Sends progress and the newest log lines every 15 s; learns whether the job was cancelled."""

    def __init__(self, job: dict):
        self.job, self.step, self.frac, self.lines = job, "frames", 0.0, []
        self.cancelled = False
        self.lock = threading.Lock()
        self.stop = threading.Event()
        threading.Thread(target=self._loop, daemon=True).start()

    def overall(self) -> float:
        done = 0.0
        for k, w in WEIGHTS.items():
            if k == self.step:
                return min(0.99, done + w * max(0.0, min(1.0, self.frac)))
            done += w
        return 0.99

    def log(self, line: str):
        line = line.rstrip()
        if not line:
            return
        print(line, flush=True)
        with self.lock:
            self.lines.append(line[-400:])

    def set(self, step: str, frac: float = 0.0):
        self.step, self.frac = step, frac
        self.log(f"== {step}")
        self.flush()

    def flush(self):
        with self.lock:
            text, self.lines = "\n".join(self.lines[-60:]), []
        try:
            r = api("POST", "progress", json={"job": self.job["id"], "worker": NAME, "step": self.step, "progress": self.overall(), "log": text})
            if r.ok and r.json().get("cancel"):
                self.cancelled = True
        except Exception as e:  # progress is best effort
            print(f"  progress not sent: {e}", flush=True)

    def _loop(self):
        while not self.stop.wait(15):
            self.flush()

    def check(self):
        if self.cancelled:
            raise Cancelled()


def run(argv: list[str], rep: Reporter, cwd: Path | None = None, total: int | None = None):
    """Runs a command, streams its output to the log, reads 'n/total' progress and stops it when the job is cancelled."""
    rep.log("$ " + " ".join(argv))
    p = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                         start_new_session=True, errors="replace")
    frac_re = re.compile(r"(\d+)\s*/\s*(\d+)")
    for line in p.stdout:  # type: ignore[union-attr]
        rep.log(line)
        for a, b in frac_re.findall(line.replace(",", "")):
            a, b = int(a), int(b)
            if b > 0 and a <= b and (total is None or b == total):
                rep.frac = a / b
        if rep.cancelled:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(30)
            raise Cancelled()
    code = p.wait()
    if code != 0:
        raise RuntimeError(f"{Path(argv[0]).name} {argv[1] if len(argv) > 1 else ''} stopped with code {code}")


# ------------------------------------------------------------------ recipe

def fill(template: list, v: dict) -> list[str]:
    """{name} is replaced; an item '{?flag:text}' is kept only when v[flag] is true (or non-empty);
    an item '{@name}' becomes the list v[name] (several arguments, or none)."""
    out = []
    for item in template:
        m = re.fullmatch(r"\{@(\w+)\}", item)
        if m:
            out.extend(str(x) for x in v.get(m.group(1), []))
            continue
        m = re.fullmatch(r"\{\?(\w+):(.*)\}", item)
        if m:
            if not v.get(m.group(1)):
                continue
            item = m.group(2)
        out.append(item.format(**v))
    return out


def video_fps(path: Path) -> float:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate",
                            "-of", "csv=p=0", str(path)], capture_output=True, text=True, timeout=60)
        a, b = r.stdout.strip().split("/")
        return float(a) / float(b) if float(b) else 30.0
    except Exception:
        return 30.0


def image_dirs(root: Path) -> list[Path]:
    """Every folder under root that holds images directly (one per camera / lens)."""
    dirs = sorted({p.parent for p in root.rglob("*") if p.is_file() and PHOTO.search(p.name)})
    return dirs


def summary(root: Path) -> list[str]:
    """One line per folder: how many files of each kind, for the log."""
    out = []
    if not root.exists():
        return [f"{root.name}/: missing"]
    for d in sorted({p.parent for p in root.rglob("*") if p.is_file()}):
        kinds: dict[str, int] = {}
        for f in d.iterdir():
            if f.is_file():
                kinds[f.suffix.lower() or "(none)"] = kinds.get(f.suffix.lower() or "(none)", 0) + 1
        out.append(f"  {d.relative_to(root.parent)}: " + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items())))
    return out or [f"  {root.name}/: empty"]


def flatten_lenses(images: Path, n_videos: int, rep: "Reporter"):
    """images/v1/cam0 -> images/cam0 (one video) or images/v1-cam0 (several), as Spirula Studio lays out a dataset:
    one folder per lens directly under images/, so rigs and masks are named cam0, cam1."""
    for i in range(1, n_videos + 1):
        stem = images / f"v{i}"
        if not stem.is_dir():
            continue
        for lens in sorted(d for d in stem.iterdir() if d.is_dir()):
            dest = images / (lens.name if n_videos == 1 else f"v{i}-{lens.name}")
            if dest.exists():
                raise RuntimeError(f"{dest.name} exists twice in the frames")
            lens.rename(dest)
        if not any(stem.iterdir()):
            stem.rmdir()
        else:
            rep.log(f"  ! left in {stem.name}: {[x.name for x in stem.iterdir()][:5]}")


def name_masks(images: Path, masks: Path, rep: "Reporter"):
    """`sam track` numbers its masks (frame_00000.png …) in the order it read the frames (sorted by name);
    the reconstruction and training look for <frame name>.png. Renames them to match."""
    for d in image_dirs(images):
        md = masks / d.relative_to(images)
        numbered = sorted((f for f in md.glob("frame_*.png") if re.fullmatch(r"frame_\d+\.png", f.name)),
                          key=lambda f: int(f.stem.split("_")[1])) if md.is_dir() else []
        if not numbered:
            continue
        frames = sorted(f for f in d.iterdir() if f.is_file() and PHOTO.search(f.name))
        if len(numbered) != len(frames):
            rep.log(f"  ! {md.name}: {len(numbered)} masks for {len(frames)} frames; left as they are")
            continue
        tmp = [f.rename(f.with_name(f"_{f.name}")) for f in numbered]  # two passes: a new name may be an old one
        for f, img in zip(tmp, frames):
            f.rename(md / f"{img.stem}.png")
        rep.log(f"  {md.name}: {len(frames)} masks named after their frames")


def separate_masks(images: Path, masks: Path, rep: "Reporter"):
    """If masks landed next to the frames (frame_1.jpg + frame_1.png), move them to masks/<lens>/,
    or the reconstruction would take them for photos."""
    moved = 0
    for d in image_dirs(images):
        stems = {f.stem for f in d.iterdir() if f.suffix.lower() in (".jpg", ".jpeg")}
        for f in list(d.iterdir()):
            if f.suffix.lower() == ".png" and f.stem in stems:
                dest = masks / d.relative_to(images) / f.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                f.rename(dest)
                moved += 1
    if moved:
        rep.log(f"  moved {moved} masks out of the frame folders")


# ------------------------------------------------------------------ one job

def download(job: dict, f: dict, dest: Path, rep: Reporter):
    dest.parent.mkdir(parents=True, exist_ok=True)
    have = dest.stat().st_size if dest.exists() else 0
    if have == f["size"]:
        return
    url = f"{API}/input?job={job['id']}&worker={NAME}&file={f['id']}"
    for attempt in range(8):
        try:
            headers = {"range": f"bytes={have}-"} if have else {}
            with S.get(url, headers=headers, stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(dest, "ab" if have else "wb") as out:
                    for chunk in r.iter_content(8 * 1024 * 1024):
                        out.write(chunk)
                        have += len(chunk)
                        rep.frac = 0.3 * have / max(1, f["size"])
                        rep.check()
            if have == f["size"]:
                return
        except Cancelled:
            raise
        except Exception as e:
            rep.log(f"  download interrupted at {have / 1e6:.0f} MB ({e}); resuming")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Could not download {f['name']}")


def upload_output(job: dict, path: Path, rep: Reporter):
    name, size = path.name, path.stat().st_size
    q = f"job={job['id']}&worker={NAME}&name={name}"
    if size <= SINGLE_MAX:
        with open(path, "rb") as fh:
            r = api("PUT", f"output?{q}", data=fh, headers={"content-length": str(size)}, timeout=600)
        r.raise_for_status()
        return
    up = api("POST", "output-start", json={"job": job["id"], "worker": NAME, "name": name}).json()["upload"]
    parts = []
    with open(path, "rb") as fh:
        n = 0
        while chunk := fh.read(PART):
            n += 1
            r = api("PUT", f"output-part?{q}&upload={up}&n={n}", data=chunk, timeout=600)
            r.raise_for_status()
            parts.append(r.json())
    api("POST", "output-complete", json={"job": job["id"], "worker": NAME, "name": name, "upload": up, "parts": parts}).raise_for_status()


def send_preview(job: dict, step: str, make, rep: Reporter):
    """Makes and sends one preview picture. Never stops the job."""
    try:
        out = make()
        note = None
        if isinstance(out, tuple):
            out, note = out
        if note:
            rep.log(f"  {note}")
        if out:
            api("PUT", f"preview?job={job['id']}&worker={NAME}&step={step}", data=out,
                headers={"content-type": "image/jpeg", "content-length": str(len(out))}, timeout=120).raise_for_status()
    except Exception as e:
        print(f"  preview {step} skipped: {e}", flush=True)


def read_cams(sparse: Path):
    return pt.read_images_bin(sparse / "images.bin") if (sparse / "images.bin").exists() else pt.read_images_txt(sparse / "images.txt")


def find_sparse(dataset: Path) -> Path | None:
    return next((c for c in (dataset / "sparse" / "0", dataset / "sparse") if (c / "images.bin").exists() or (c / "images.txt").exists()), None)


class TrainingPreviews:
    """While training runs, sends the newest checkpoint seen from above, at most every few minutes."""

    def __init__(self, job: dict, outputs: Path, sparse: Path | None, rep: Reporter, every: float = 180):
        self.job, self.outputs, self.sparse, self.rep, self.every = job, outputs, sparse, rep, every
        self.stop = threading.Event()
        self.last_path, self.last_time = None, 0.0
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while not self.stop.wait(30):
            try:
                plys = [p for p in self.outputs.rglob("splat.ply") if time.time() - p.stat().st_mtime > 15]
            except Exception:
                continue
            if not plys:
                continue
            newest = max(plys, key=lambda p: p.stat().st_mtime)
            if newest != self.last_path and time.time() - self.last_time > self.every:
                self.last_path, self.last_time = newest, time.time()
                send_preview(self.job, "training", lambda: previews.splat(newest, self.sparse, read_cams, pt.read_ply, pt.load_scene_transform), self.rep)


def process(job: dict, rep: Reporter) -> dict:
    s, tour, q = job["settings"], job["tour"], job["quality"]
    recipe_path = HERE / "recipes" / f"{job['version']}.json"
    if not recipe_path.exists():
        raise RuntimeError(f"This worker has no recipe for Spirula {job['version']}")
    recipe = json.loads(recipe_path.read_text())
    work = WORK / job["id"]
    inputs, dataset, outputs, site = work / "input", work / "dataset", work / "outputs", work / "site"
    for d in (inputs, dataset / "images", outputs, site):
        d.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    # 1. the uploaded files
    rep.set("frames")
    files = []
    for f in job["inputs"]:
        dest = inputs / f"{f['id']}-{re.sub(r'[^A-Za-z0-9._-]', '_', f['name'])}"
        rep.log(f"Downloading {f['name']} ({f['size'] / 1e9:.2f} GB)")
        download(job, f, dest, rep)
        files.append(dest)
    original = lambda p: p.name.split("-", 1)[1] if "-" in p.name else p.name
    splats = [p for p in files if SPLAT.search(p.name)]
    if splats:
        return publish(job, rep, files, splats, original, work, site, t0)
    videos = [p for p in files if VIDEO.search(p.name)]
    photos = [p for p in files if PHOTO.search(p.name)]
    if not videos and not photos:
        raise RuntimeError("No video or photos among the uploaded files")

    base = {
        "spirula": SPIRULA, "models": MODELS, "dataset": str(dataset), "images": str(dataset / "images"), "masks": str(dataset / "masks"),
        "outputs": str(outputs), "removeText": s["removeText"], "floaters": s["floaters"],
        "splats": str(q["splats"]), "steps": str(q["steps"]), "adaptive": s["adaptive"], "skipBlurry": s["skipBlurry"],
        "start": s.get("start") or "", "end": s.get("end") or "", "depth": s["depth"], "removePeople": s["removePeople"],
        # model licences accepted for the service (the cloud has no window to click Accept in); see the recipe
        "licences": recipe.get("licences", ""),
    }
    # Photos go straight into the dataset, one camera folder.
    if photos:
        (dataset / "images" / "photos").mkdir(parents=True, exist_ok=True)
        for p in photos:
            shutil.copy2(p, dataset / "images" / "photos" / original(p))

    def video_rigs() -> list[str]:
        """As Spirula Studio sets up a 360 video: the two lenses (cam0, cam1) are one dual-fisheye rig,
        and every lens is a thin-prism fisheye. Photos keep the default lens model."""
        images = dataset / "images"
        lenses = sorted(d.name for d in images.iterdir() if d.is_dir() and d.name != "photos") if images.exists() else []
        args = []
        for i in range(1, len(videos) + 1):
            pre = "" if len(videos) == 1 else f"v{i}-"
            if f"{pre}cam0" in lenses and f"{pre}cam1" in lenses:
                args += ["--rig", f"dual-fisheye={pre}cam0,{pre}cam1"]
        if lenses and not photos:
            args += ["--camera-model", "thin-prism-fisheye"]
        else:
            for lens in lenses:
                args += ["--camera-model", f"{lens}=thin-prism-fisheye"]
        return args

    base["hasVideo"] = bool(videos)
    for st in recipe["steps"]:
        base["videoRigs"] = video_rigs()
        when = st.get("when")
        if when and not base.get(when):
            continue
        rep.set(st["step"], 0.3 if st["step"] == "frames" else 0.0)
        began = time.time()
        watcher = TrainingPreviews(job, outputs, find_sparse(dataset), rep) if st["step"] == "training" else None
        try:
            run_step(st, base, videos, dataset, s, q, rep)
        finally:
            if watcher:
                watcher.stop.set()
        rep.check()
        if st["step"] == "frames":
            flatten_lenses(dataset / "images", len(videos), rep)
        if st["step"] == "masks":
            separate_masks(dataset / "images", dataset / "masks", rep)
            name_masks(dataset / "images", dataset / "masks", rep)
        if st["step"] in ("frames", "masks"):
            for line in summary(dataset / "images") + (summary(dataset / "masks") if st["step"] == "masks" else []):
                rep.log(line)
        dirs = image_dirs(dataset / "images")
        if st["step"] == "frames":
            send_preview(job, "frames", lambda: previews.frames(dirs), rep)
        elif st["step"] == "masks":
            send_preview(job, "masks", lambda: previews.masks(dataset / "images", dataset / "masks", dirs), rep)
        elif st["step"] == "cameras" and find_sparse(dataset):
            send_preview(job, "cameras", lambda: previews.cameras(find_sparse(dataset), read_cams), rep)
        elif st["step"] == "depth":
            send_preview(job, "depth", lambda: previews.depth(dataset, began), rep)

    # 2. the trained splat: the newest checkpoint's splat.ply
    plys = sorted(outputs.rglob("splat.ply"), key=lambda p: p.stat().st_mtime)
    if not plys:
        raise RuntimeError("Training finished without a splat.ply")
    splat = plys[-1]
    sparse = find_sparse(dataset)
    if not sparse:
        raise RuntimeError("No camera positions (sparse/0) in the dataset")
    send_preview(job, "training", lambda: previews.splat(splat, sparse, read_cams, pt.read_ply, pt.load_scene_transform), rep)
    return build_and_upload(job, rep, splat, sparse, site, t0)


def run_step(st: dict, base: dict, videos: list[Path], dataset: Path, s: dict, q: dict, rep: Reporter):
    if st.get("for_each") == "video":
        for i, v in enumerate(videos):
            skip = max(1, round(video_fps(v) / max(0.5, float(s["fps"]))))
            run(fill(st["argv"], {**base, "input": str(v), "stem": f"v{i + 1}", "skip": str(skip)}), rep)
    elif st.get("for_each") == "image_dir":
        for d in image_dirs(dataset / "images"):
            rel = d.relative_to(dataset / "images")
            (dataset / "masks" / rel).mkdir(parents=True, exist_ok=True)
            run(fill(st["argv"], {**base, "dir": str(d), "rel": str(rel)}), rep)
    else:
        run(fill(st["argv"], base), rep, total=q["steps"] if st["step"] == "training" else None)


def publish(job: dict, rep: Reporter, files: list[Path], splats: list[Path], original, work: Path, site: Path, t0: float) -> dict:
    """A finished splat (e.g. trained in Spirula Studio): lay it out as Spirula does and publish it, no training."""
    rep.log("A finished splat was uploaded: publishing it as it is (no frames, masks or training).")
    run_dir = work / "manual" / "outputs" / "run"
    (run_dir / "step.ckpt").mkdir(parents=True, exist_ok=True)
    sparse = work / "manual" / "sparse" / "0"
    sparse.mkdir(parents=True, exist_ok=True)
    splat = run_dir / "step.ckpt" / "splat.ply"
    shutil.move(str(max(splats, key=lambda p: p.stat().st_size)), splat)
    for p in files:
        name = original(p)
        if name == "scene_transform.json":
            shutil.move(str(p), run_dir / name)
        elif name in CAMERA_FILES:
            shutil.move(str(p), sparse / name)
    if not ((sparse / "images.bin").exists() or (sparse / "images.txt").exists()):
        raise RuntimeError("Upload the images.bin of the splat's dataset (sparse/0) with it: the tour needs the walked path.")
    if not (run_dir / "scene_transform.json").exists():
        rep.log("  no scene_transform.json uploaded; assuming the splat is in the cameras' own frame")
    send_preview(job, "tour", lambda: previews.splat(splat, sparse, read_cams, pt.read_ply, pt.load_scene_transform), rep)
    return build_and_upload(job, rep, splat, sparse, site, t0)


def build_and_upload(job: dict, rep: Reporter, splat: Path, sparse: Path, site: Path, t0: float) -> dict:
    s, tour = job["settings"], job["tour"]
    # 3. the walkable tour; an earlier tour.json keeps its rooms and hand edits
    rep.set("tour")
    tour_dir = site / "tours" / tour["id"]
    tour_dir.mkdir(parents=True, exist_ok=True)
    r = api("GET", f"existing?job={job['id']}&worker={NAME}")
    if r.status_code == 200:
        (tour_dir / "tour.json").write_bytes(r.content)
    run([sys.executable, "-u", str(TOOLS / "publish_tour.py"), f"--splat={splat}", f"--sparse={sparse}", f"--name={tour['id']}",
         f"--title={tour['title']}", f"--subtitle={tour['subtitle']}", f"--eyebrow={tour['eyebrow']}", f"--lang={tour['lang']}",
         f"--site={site}", "--max-mb=0", f"--lite={s['lite']}", f"--crop={s['crop']}", f"--eye-height={s['eyeHeight']}"], rep)
    rep.check()

    # 4. publish: tour.json last, so the tour only changes once its files are in place
    rep.set("upload")
    names = sorted((p for p in tour_dir.iterdir() if p.is_file()), key=lambda p: (p.name == "tour.json", p.name))
    for i, p in enumerate(names):
        rep.log(f"Uploading {p.name} ({p.stat().st_size / 1e6:.1f} MB)")
        upload_output(job, p, rep)
        rep.frac = (i + 1) / len(names)
    return {"files": [p.name for p in names], "splat_mb": round(splat.stat().st_size / 1e6, 1), "minutes": round((time.time() - t0) / 60, 1),
            "sizes": {p.name: p.stat().st_size for p in names}, "worker": NAME, "version": job["version"]}


def run_job(job_id: str | None = None) -> str:
    """Claims and processes one job. Returns 'done', 'failed', 'cancelled' or 'none'."""
    r = api("POST", "claim", json={"worker": NAME, "versions": [VERSION] if VERSION else [], **({"job": job_id} if job_id else {})})
    if r.status_code == 204:
        return "none"
    r.raise_for_status()
    job = r.json()
    print(f"Job {job['id']}: tour {job['tour']['id']} with Spirula {job['version']}", flush=True)
    rep = Reporter(job)
    try:
        result = process(job, rep)
        rep.flush()
        api("POST", "done", json={"job": job["id"], "worker": NAME, "ok": True, "result": result}).raise_for_status()
        return "done"
    except Cancelled:
        rep.log("Cancelled from Intus admin.")
        return "cancelled"
    except Exception as e:
        rep.log(f"FAILED: {e}")
        rep.flush()
        api("POST", "done", json={"job": job["id"], "worker": NAME, "ok": False, "error": str(e)[:900]})
        return "failed"
    finally:
        rep.stop.set()
        if not os.environ.get("KEEP_WORK"):
            shutil.rmtree(WORK / job["id"], ignore_errors=True)


def main():
    if len(KEY) < 24:
        sys.exit("Set INTUS_WORKER_KEY (the same value as on Probe).")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["poll", "once"])
    ap.add_argument("--job", help="process this job (once)")
    a = ap.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    if a.mode == "once":
        print(run_job(a.job))
        return
    print(f"{NAME}: waiting for jobs for Spirula {VERSION or '(any)'} at {API}", flush=True)
    while True:
        try:
            if run_job() == "none":
                time.sleep(30)
        except Exception as e:
            print(f"worker error: {e}", flush=True)
            time.sleep(60)


if __name__ == "__main__":
    main()
