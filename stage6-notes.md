# Stage 6 repair notes

- Excluded `.visually-hidden` file inputs from visible workflow input sizing and padding rules, while keeping the upload label association intact.
- Added independent loading, error, retry, and completed-empty states for the analysis and collage lists on ProjectsPage. List retries issue GET requests and leave project creation and nickname messages separate.
- Repaired the UI audit request lifecycle: reset archives earlier requests, clears the active request list, settles intercepted fetches after navigating away, and keeps per-scenario evidence across resets. Corrected created-project fixture responses and the requested project, collage, search, retry, and professional save/export scenarios.
- `py_compile` for `.runtime-audit/ui-audit/audit.py`: passed.
- `git diff --check`: passed.
- Browser scenarios were not run.
