# Nassau Tours — walkable splat tours

Two pieces:

- **`publish_tour.py`** turns a trained splat + its COLMAP camera path into a web tour:
  `tour.sog` (compressed splat), `collision.glb` (walls, floors, stairs) and `tour.json`.
- **`viewer/`** is a static web page that walks the tour: WASD + mouse look, wall collision,
  automatic stair stepping, touch joystick on phones. No server code — any static host works.

```
tourkit/
  publish_tour.py
  requirements.txt
  viewer/                 index.html, viewer.js, style.css, lib/ (PlayCanvas + Rapier)
  site/                   created by the script: viewer + tours/<name>/  ← this folder is what you upload
```

## One-time setup (Windows)

1. **Python 3.10+** from python.org (tick "Add python.exe to PATH").
2. **Node.js LTS** from nodejs.org (the script runs PlayCanvas `splat-transform` through `npx`).
3. In this folder:
   ```
   pip install -r requirements.txt
   ```

## Publish a tour

Spirula Studio output (the COLMAP folder is found automatically):

```
python publish_tour.py --name villa-ekbacken --title "Villa Ekbacken" --subtitle "Ekbacksvägen 12, Bromma" ^
  --splat "E:\Videos\ForSplatting\CAM_20261020164841_0001_D_dataset\outputs\CAM_20261020164841_0001_D_dataset_20261025-234944\step-000030000.ckpt\splat.ply"
```

It prints the up axis it found, the camera height it measured (should be about how high you
held the camera), how much it cropped, then the output sizes.

Look at it locally:

```
python -m http.server 8000 --directory site
```
→ open `http://localhost:8000/?t=villa-ekbacken`

### Useful options

| Option | Default | What it does |
|---|---|---|
| `--crop 5` | 5 m | keep everything within this distance of where you walked; raise for big rooms, lower to cut more garden |
| `--max-size 1.5` | 1.5 m | drop haze blobs larger than this |
| `--spawn 0` | first frame | start at a later point of the walk (index along the path) |
| `--eye-height 1.6` | 1.6 m | visitor eye height |
| `--lang sv\|en` | sv | viewer language |
| `--eyebrow "Mäklarfirman"` | – | small label above the title |
| `--up -y` | auto | force the up axis if auto-detection ever guesses wrong |
| `--no-collision` | – | skip the collision mesh (visitors walk on a flat floor at the start level) |

Re-running for the same `--name` keeps what you edited by hand in `tour.json` (spawn, texts).

## Developer mode in the viewer

Add `&edit` to the URL:

- **F** — fly (no collision), **E/Space** up, **Q/C** down
- **G** — show the collision mesh as a wireframe
- **P** — copy the current position as a `"spawn"` line; paste it into `tour.json` to change the start point
- the top-right box shows position and direction

Everyone gets **R** = back to start, **Shift** = walk faster.

## tour.json

```json
{
  "title": "Villa Ekbacken",
  "eyebrow": "Mäklarfirman",
  "subtitle": "Ekbacksvägen 12, Bromma",
  "lang": "sv",
  "splat": "tour.sog",
  "collision": "collision.glb",
  "spawn": { "position": [0, 0, 0], "yaw": 0 },
  "eyeHeight": 1.6
}
```
Also accepted: `walkSpeed` (1.4), `runSpeed` (2.8), `fov` (75), `background`, `stepHeight` (0.28).
Positions are metres, Y up, origin = floor under the first camera position.

## Hosting

Upload the whole `site/` folder. Each tour is `https://<host>/?t=<name>`.
Cheapest good option: a Cloudflare R2 bucket on a custom domain (e.g. `tours.nassau.se`) — free egress,
10 GB free storage. (Cloudflare Pages also works, but caps files at 25 MB, which a large `tour.sog` can exceed.)
