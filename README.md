# Wave Overhang Post-Processor

Browser-based tooling for inspecting sliced FDM G-code, detecting unsupported overhang regions, previewing wave-style replacement paths, and exporting a post-processed G-code file.

The app is built with Vite, React, and TypeScript. Uploaded files stay local to the browser; no cloud upload is required. In local development, the Vite dev server also exposes an optional helper endpoint that can save generated output into `public/demo/`.

## Current capabilities

- Open a local `.gcode` or `.txt` toolpath by file picker or drag-and-drop, or load the bundled demo sample.
- Parse common FDM movement/extrusion commands including `G0`, `G1`, `G90`, `G91`, `G92`, `M82`, and `M83`.
- Group extrusion moves into printable layers and compute model bounds, per-layer stats, and warnings.
- Inspect the toolpath in both:
  - a 2D layer viewer with zoom/pan, point display, previous-layer ghosting, travel moves, and highlighted overhang regions
  - a 3D stack viewer that renders the full layer stack, highlights the selected layer, and adds clickable overhang callouts
- Detect candidate overhang regions by comparing each layer footprint against the previous layer footprint.
- Generate a wave-planning guide for overhanging layers by separating the supported seed edge from the exposed boundary.
- Preview generated wavefront paths for a layer and regenerate them with adjustable settings.
- Switch between two propagation approaches for wave generation:
  - `raster`: grid-based propagation on the detected overhang region
  - `huygens`: vector-style propagation using buffered fronts and clipping
- Export a post-processed `.gcode` file that preserves the original file and replaces detected overhang toolpaths on planned layers with generated wave paths.
- Tune export parameters such as bead area, filament diameter, and retraction distance from the UI.
- Run automated tests for parsing, overhang analysis, wave-path planning, viewer scaling, and G-code export.

## Typical workflow

1. Load a sliced FDM G-code file or the bundled demo.
2. Inspect a layer in 2D or switch to the 3D stack view for whole-model context.
3. Move to a layer with a non-zero overhang area.
4. Generate the guide to inspect the detected seed edge and overhang boundary.
5. Confirm the guide to generate wavefront paths, then tweak wavelength / resolution / iteration settings if needed.
6. Export a post-processed G-code file once one or more layers have an accepted wave-path preview.

## Project structure

```text
src/
  components/   React UI, upload flow, 2D canvas, 3D canvas, controls
  lib/          parser, geometry, overhang analysis, wave planning, export
  types/        shared TypeScript types
public/demo/    bundled sample inputs and locally saved dev outputs
tests/          Vitest coverage
```

## Setup

```bash
npm install
npm run dev
```

Open the local URL printed by Vite in your browser.

## Available scripts

- `npm run dev` starts the local Vite development server.
- `npm run build` type-checks the project and creates a production build in `dist/`.
- `npm run preview` serves the production build locally.
- `npm test` runs the Vitest suite.

## Build and deploy

Build locally with:

```bash
npm run build
```

The frontend is configured for static hosting:

- Vite uses a relative `base` path (`./`) so built assets work on GitHub Pages.
- `.github/workflows/deploy-pages.yml` builds and deploys `dist/` from `main`.

For `andersonsjanis/Wave-overhangs`, the published site URL is:

```text
https://andersonsjanis.github.io/Wave-overhangs/
```

To enable GitHub Pages deployment:

1. Push this project to the repository's `main` branch.
2. In GitHub, open **Settings** -> **Pages**.
3. Set **Source** to **GitHub Actions**.
4. Wait for the deployment workflow to finish.
5. Open the published Pages URL.

To verify the production build locally first:

```bash
npm run build
npm run preview
```

Static-hosting note: downloading generated output works everywhere, but the extra `/api/save-generated-gcode` endpoint that saves a copy into `public/demo/` only exists when running the local Vite dev server.

## Overhang analysis and wave planning

The current overhang detection is footprint-based and intentionally approximate:

- Each extrusion segment is buffered into a deposited-track footprint using the configured extrusion width.
- Layer footprints are unioned and compared against the previous layer.
- The overhang region is computed as `current layer footprint - previous layer footprint`.
- Current-layer extrusion paths are split into normal and overhang-colored path parts for display.
- For overhanging layers, the overhang perimeter is split into:
  - seed segments where the region still touches the supporting previous layer
  - boundary segments on the exposed perimeter
- Wave paths are then generated from that seed geometry using the selected propagation model.

The main tuning defaults live in [`src/lib/config.ts`](./src/lib/config.ts):

- `DEFAULT_OVERHANG_SETTINGS`
- `DEFAULT_WAVE_PATH_SETTINGS`
- `DEFAULT_GCODE_EXPORT_SETTINGS`

Important current parameters include:

- `extrusionWidth`
- `samplingStep`
- `overhangAreaThreshold`
- `footprintGridSize`
- `maxFootprintGridCells`
- `wavelength`
- `iterationLimit`
- `rasterSubdivisions`
- `waveBufferQuadrantSegments`
- `beadArea`
- `filamentDiameter`
- `retractionDistance`

`supportDistanceThreshold` and `supportRatioThreshold` are still present in the config/types for legacy compatibility, but the current footprint-based analysis does not use them as primary decision inputs.

## Output G-code behavior

When you export:

- only layers with an existing generated wave-path plan are modified
- untouched parts of the original toolpath stay in place
- candidate overhang toolpaths on modified layers are replaced with generated seed/wavefront paths
- extrusion is regenerated from bead area and filament diameter
- travel moves around replacement paths can include retraction/unretraction
- the browser downloads the new file as `<original-name>-post-processed.gcode`

## Current limitations

- The 3D viewer is a canvas-based stack preview, not a full shaded mesh/volumetric simulation.
- The parser targets common sliced FDM output and is not a complete G-code interpreter.
- Layer grouping depends on Z changes observed during extrusion moves.
- Arcs (`G2`/`G3`), multi-tool workflows, volumetric extrusion, firmware-specific behavior, and advanced retraction semantics are not modeled.
- Overhang detection is geometric and approximate rather than a physically exact support simulation.
- The raster planner is grid-based, so curved boundaries can look jagged at coarse resolutions.
- The Huygens planner is still constrained by the detected overhang boundary geometry and current clipping/buffering assumptions.
- The first printable layer is treated as supported to avoid marking the full first layer as an overhang.

## Demo file

The bundled sample is [`public/demo/sample-overhang.gcode`](./public/demo/sample-overhang.gcode). In the UI, load it with **Load demo sample**.
