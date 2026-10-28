# Madnolia project structure

## Supported application

The supported application is the static browser app in `web/`. It runs analysis, editing, search, and exports locally in Chrome or Edge and stores workspace files in a user-selected folder. Build and deployment use only the web app; the GitHub Pages artifact contains `web/dist`.

| Path | Responsibility |
| --- | --- |
| `web/src/App.tsx`, `main.tsx` | Browser app entry and routing. |
| `web/src/browser/` | Local folder access, model cache, analysis, audio processing, search, project storage, and exports. |
| `web/src/components/` | React screens and browser workspace UI. |
| `web/src/browserConstants.ts`, `browserAnalysisConstants.ts`, `browserAudioConstants.ts` | Browser workspace, model, analysis, and audio limits. |
| `web/src/types/` | Shared browser, analysis, audio, and UI types. |
| `web/tests/` | Node tests and the static browser smoke test. |
| `web/vite.config.ts` | Relative asset base for subpath hosting on GitHub Pages. |

The browser workspace stores `madnolia-browser.json` and uses `analyses/`, `projects/`, `collages/`, `media/`, `models/`, and `jobs/`. Its format is not compatible with the Python application's `data/` layout.

## Retained Python application

All 78 approved Python source, test, installer, tooling, config, and legacy note files have been removed from `main` and are preserved at `legacy/python`, commit `5528ab02b63338ce59bf049f7596d5e50657b53b`. The Python archive is not invoked by the supported web build or Pages deployment and is not included in `web/dist`. Local data, models, downloads, caches, environments, and binaries remain untouched.

## Development and verification

Run commands from `web/`:

```powershell
npm ci
npm run dev
npm test
npm run build
npm run preview
```

The browser smoke test is `node tests/browser-static-smoke.mjs` after building. It serves the output below a simulated Pages subpath and checks folder access, persistence, and that the app makes no API network requests. It locates installed Chrome or Edge automatically; set `CHROME_PATH` to a browser executable when it is installed elsewhere.

See [docs/static-web.md](docs/static-web.md) for browser requirements, local storage, engine differences, and manual Pages deployment.
