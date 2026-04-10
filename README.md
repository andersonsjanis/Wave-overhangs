# G-code Overhang Viewer

First working version of a browser-based G-code layer viewer focused on simple overhang inspection for sliced FDM toolpaths.

The app is built with Vite, React, and TypeScript, runs entirely client-side, and keeps uploaded files local in the browser.

## Features

- Upload a local `.gcode` file or load a bundled demo file.
- Parse common FDM movement commands (`G0`, `G1`, `G90`, `G91`, `G92`, `M82`, `M83`).
- Group extrusion moves into layers using Z height changes.
- Visualize a selected layer in a top-down 2D canvas view.
- Show the previous layer as a faint ghost for context.
- Optionally show travel moves.
- Highlight candidate overhang segments using a readable MVP heuristic.
- On overhanging layers, generate a first wave-overhang planning overlay that identifies the supported seed edge and exposed boundary.
- Confirm the seed/boundary overlay to preview generated wavefront paths while hiding the original overhanging paths.
- Run a small automated test suite for parser and overhang logic.

## Project structure

```text
src/
  components/   React UI
  lib/          parser, geometry, heuristic logic, config
  types/        shared TypeScript types
public/demo/    bundled sample G-code
tests/          Vitest coverage
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Start the development server:

```bash
npm run dev
```

3. Open the local URL shown by Vite in your browser.

## Available scripts

- `npm run dev` starts the local Vite dev server.
- `npm run build` creates a production build in `dist/`.
- `npm run preview` serves the production build locally.
- `npm test` runs the Vitest test suite.

## Build

```bash
npm run build
```

## GitHub Pages deployment

This project is already set up to work as a static frontend on GitHub Pages:

- Vite is configured with a relative `base` path (`./`) so the built assets can be served from a repository site.
- A GitHub Actions workflow is included at `.github/workflows/deploy-pages.yml` to build and deploy `dist/` whenever you push to `main`.

For the public repository `andersonsjanis/Wave-overhangs`, the published site URL will be:

```text
https://andersonsjanis.github.io/Wave-overhangs/
```

To enable it:

1. Push this project to the repository's `main` branch.
2. On GitHub, open **Settings** -> **Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Wait for the **Deploy GitHub Pages** workflow to finish on the **Actions** tab.
5. Open the Pages URL above once the deployment succeeds.

You can also verify the production build locally before pushing:

```bash
npm run build
npm run preview
```

Static hosting note: the app can always download generated output in the browser, but the optional local-dev convenience endpoint that saves a copy into `public/demo/` is only available when running the Vite dev server locally.

## Overhang heuristic

The current overhang detection is intentionally simple and marked as an MVP. It follows the same outer-footprint idea as the reference Python/Shapely script:

- Each extrusion segment is buffered into a rectangular deposited-track area using the assumed line width.
- Buffered tracks in each layer are unioned into a layer footprint.
- Interior holes are removed so the comparison uses the outer shell / footprint of each layer.
- The overhang area is computed as `current layer footprint - previous layer footprint`.
- Current-layer paths are split into normal and overhang-colored pieces based on whether each small deposited path piece intersects the overhang area.
- For wave-overhang planning, the overhang cell perimeter is split into seed segments where it touches the previous-layer footprint and boundary segments everywhere else.
- After confirmation, wavefront paths are generated with `W0` set to the confirmed seed geometry. Each iteration buffers the current wavefront with the configured wavelength using browser-side JSTS geometry operations, clips to the confirmed overhang boundary, subtracts previous/already-filled wavefront area, and stops when no meaningful new area is added.

The tuning values live in [`src/lib/config.ts`](./src/lib/config.ts):

- `extrusionWidth`
- `samplingStep` for splitting rendered path pieces
- `overhangAreaThreshold`
- `footprintGridSize`
- `maxFootprintGridCells`

The legacy `supportDistanceThreshold` and `supportRatioThreshold` fields are still present in config for now, but the current outer-footprint heuristic does not use them.

## Current limitations

- The viewer is 2D only. There is no 3D preview in this version.
- The parser targets common FDM slicer output and is not a full G-code interpreter.
- Layer grouping is based on Z values seen during extrusion moves.
- Arcs (`G2`/`G3`), multiple tools, volumetric extrusion, firmware-specific behavior, and advanced retraction semantics are not modeled.
- The overhang heuristic is geometric and approximate, not a physically exact support simulation.
- The overhang boundary still starts from a rasterized footprint grid, so results are approximate and depend on `footprintGridSize`; wavefront propagation then uses vector buffer/intersection/difference operations on that boundary.
- The first printable layer is treated as supported to avoid marking the entire first layer as an overhang.

## Manual demo

A small sample file is included at [`public/demo/sample-overhang.gcode`](./public/demo/sample-overhang.gcode). You can load it from the app using the **Load demo** button.

## Future improvements

- Add richer parsing for more slicer flavors and metadata comments.
- Add segment hover inspection and per-segment support ratio readouts.
- Improve support estimation with polygonized paths, neighborhood indexing, and optional multi-layer lookback.
- Add direct URL import or drag-over overlays for larger workflows.
