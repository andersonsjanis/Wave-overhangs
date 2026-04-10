# Running Locally

Use these commands from the repo root:

```powershell
cd "C:\Users\AndersonsJA\OneDrive - University of Twente\Documents\Github\Wave-overhangs"
npm install
npm run dev
```

Then open the local URL printed by Vite in your browser. It is usually `http://localhost:5173/`.

## Quick notes

- If dependencies are already installed, you can skip `npm install`.
- This project uses Vite 5, so a recent Node.js version is required. The lockfile currently shows `^18.0.0 || >=20.0.0`.
- The local dev server also exposes the helper endpoint `/api/save-generated-gcode`, which can save generated output into `public/demo/`.

## Other useful commands

```powershell
npm run build
```

Creates a production build in `dist/`.

```powershell
npm run preview
```

Serves the built app locally so you can check the production bundle.

```powershell
npm test
```

Runs the Vitest test suite.
