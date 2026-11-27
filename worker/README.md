# Intus GPU worker

Turns uploaded 360 video or photos into a published walkable tour, for **Intus admin** (in the Probe app).
One image per Spirula version: `ghcr.io/olisil/intus-worker:spirula-<tag>`.

```
Intus admin ──queue──▶ worker (GPU)
                        1. downloads the uploads           GET  /api/intus-worker/input
                        2. Spirula: frames → masks → camera positions → depth → training   (recipes/<tag>.json)
                        3. tools/publish_tour.py: crop, level, SOG + phone version, collision, rooms
                        4. uploads the tour files          PUT  /api/intus-worker/output…
                        5. reports done                    POST /api/intus-worker/done
```

The worker only needs `INTUS_WORKER_KEY` (same value as the secret on Probe); it never holds storage keys.

## Build the image
GitHub → Actions → **Build Intus worker** → Run workflow → type the Spirula release tag (e.g. `v2026.11.12`).
`worker/recipes/<tag>.json` must exist. The image downloads that Spirula release (Linux, Vulkan), the SAM 2.1 Base+ and
Grounding DINO Tiny weights (both Apache-2.0), and `@playcanvas/splat-transform`.

## Run on the GPU cloud (RunPod serverless, EU)
1. New serverless endpoint from the image, in an EU region, 24 GB+ GPU (e.g. L4 / A5000 / 4090), container disk ~80 GB.
2. Environment: `INTUS_WORKER_KEY`, `INTUS_API=https://probe.nassau.se/app/api/intus-worker`.
3. Max workers 1–2, idle timeout short (it scales to zero between jobs). Execution timeout: 3 hours.
4. Put the endpoint id on the version under Probe → Admin → Intus, and the RunPod API key as Probe's secret `RUNPOD_API_KEY`.
   From then on, **Start processing** starts a GPU for that job.

## Run anywhere else (any machine with an NVIDIA GPU)
```
docker run --gpus all -e INTUS_WORKER_KEY=… -v /scratch:/work ghcr.io/olisil/intus-worker:spirula-v2026.11.12 poll
```
`poll` keeps claiming jobs for its version; `once --job <id>` does one.

## A new Spirula version
1. Copy `recipes/<old>.json` to `recipes/<new>.json` and check each command against `spirula <tool> --help` of the new release.
2. Build the image for the new tag (above), make an endpoint for it.
3. In Probe → Admin → Intus: add the version as *testing*, try it on a tour, then make it *active* or the default.
   People keep the versions they were given; old ones can be retired.

## First run of v2026.11.12 — to check
The recipe was written from Spirula's command-line help and has only been run against a stand-in, not a real GPU yet.
Check on the first real job (the log is visible in Intus admin):
- `sam extract --sync` on an .OSV puts each lens in its own folder under `images/v1/`.
- `sam track` finds the cached SAM 2.1 / Grounding DINO weights, and the masks land beside `images/` with matching names.
- `geometry` downloads its default depth model on the first run (cached afterwards if the endpoint has a network volume).
- `train` writes `outputs/run/step-*.ckpt/splat.ply`.
