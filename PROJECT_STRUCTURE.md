# Madnolia project structure

This guide describes current source responsibilities and verification entry points. User media, saved project data, model caches, virtual environments, build output, and runtime audit assets remain in their existing locations and are not source modules.

## Backend

| Path | Responsibility |
| --- | --- |
| `src/madnolia/pipeline.py` | Stateful ingest and realignment orchestration. |
| `src/madnolia/analysis_versions.py` | Pure finalized-version manifest construction and active-version file discovery, re-exported through the existing pipeline API. |
| `src/madnolia/storage.py`, `projects.py` | Database, analysis, project, media path, and persistence operations. |
| `src/madnolia/compositions.py` | Composition storage, loading, project-bound parent/source checks, and compatibility exports. |
| `src/madnolia/services/composition_validation.py` | Pure request and professional-segment schema validation. |
| `src/madnolia/exporters.py` | Stateful audio/video rendering and export dispatch; retains its established helper import paths. |
| `src/madnolia/services/export_formats.py` | Pure EDL, FCPXML, and timecode formatting helpers. |
| `src/madnolia/viewer.py` | FastAPI routes, job coordination, and response assembly. |
| `src/madnolia/services/media_waveform.py` | Cached waveform data extraction, re-exported at the existing viewer helper path. |
| `src/madnolia/types/common.py`, `constants.py` | Shared backend schemas and constants. |

## Frontend

| Path | Responsibility |
| --- | --- |
| `web/src/api/client.ts`, `api/*.ts`, `api.ts` | Shared HTTP request behavior, feature API modules, and compatibility exports. |
| `web/src/features/composition/timeline.ts` | Timeline retiming, segment duration, and pure segment reordering. |
| `web/src/features/composition/waveform.ts` | Source-mapped waveform polygon generation. |
| `web/src/features/composition/regions.ts` | Professional region editing and envelope mapping calculations. |
| `web/src/features/composition/history.ts` | Pure professional editor undo/redo history. |
| `web/src/composition.ts`, `professionalHistory.ts` | Compatibility exports for the established module paths. |
| `web/src/components/` | Stateful React routes, timeline and professional editor UI. |
| `web/src/types/index.ts`, `constants.ts` | Shared frontend API, editor types, and constants. |
| `web/src/styles.css` | Main stylesheet entry, importing the ordered partitions in `styles/`. |
| `web/src/styles/base.css`, `layout.css`, `timeline.css`, `analysis.css`, `composition.css`, `professional.css` | Contiguous stylesheet partitions imported in source order to preserve the cascade. |

## Packaging and tool entry points

The six comparison and benchmark scripts under `scripts/` keep their existing direct invocation paths and bootstrap behavior. Installer build and payload scripts under `installer/`, the root `Madnolia.spec`, and the Windows release workflow also retain their established locations and invocation paths. The refactor changes none of those interfaces.

## Development and verification

Use the supported Python 3.11 development environment at the repository root:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev,web]"
python -m pytest
.venv\Scripts\ruff.exe check src tests installer scripts
```

Run frontend checks from `web/`:

```powershell
npm ci
npm test
npm run build -- --configLoader native
```

The browser smoke script is `py -3.11 web/tests/professional-browser-smoke.py` when FastAPI and Chrome are available. Installer tests run with `python -m pytest tests/test_installer.py -q`; full portable release bundles are not part of routine development verification.
