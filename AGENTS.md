# AGENTS.md

Guidance for AI coding agents and human contributors working in this repository.

## Project

OpenVatra is an open-source Windows desktop app that brings local AI tools into one window: Chat, Code and
Automations tabs. It runs everything on the user's own PC. Nothing is hosted.

It controls, but does not replace, these local services (all bound to `127.0.0.1`):

| Service                | Role                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| llama-swap + llama.cpp | Runs the chat models; one OpenAI-compatible endpoint that swaps models on demand |
| Ollama                 | Embedding model for document search (optional engine for chat models)            |
| Open WebUI backend     | Chats, web search and RAG through its API (git submodule, API only, no frontend) |
| OpenCode / OpenClaw    | Code and automation agents (later phases)                                        |

**Status:** early development; the app shell works (see README), Chat, Code and Automations are placeholders.
Settings: `%APPDATA%\OpenVatra\settings.json` (validated, typed IPC); log: `%APPDATA%\OpenVatra\logs\main.log`.

## Stack

Electron · React 19 · TypeScript (strict) · Redux Toolkit + RTK Query · Tailwind CSS + shadcn/ui ·
Fontsource (Geist, Geist Mono, Source Serif 4; bundled, never loaded from the web) ·
electron-vite · Vitest + React Testing Library · Playwright (Electron) · GitHub Actions ·
Go (standard library plus `golang.org/x/sys` and the SQLite driver `modernc.org/sqlite`) for `core/`, the local program that will own the services.
Do not add dependencies outside this list without asking.

## Commands

```
npm ci               # install exact dependencies from package-lock.json (Node 26, see .nvmrc)
npm run dev          # run the app; the UI hot-reloads, main/preload changes restart Electron
npm run typecheck    # TypeScript checks for main/preload (tsconfig.node) and renderer (tsconfig.web)
npm run lint         # ESLint incl. accessibility rules; zero warnings allowed
npm run format       # format everything with Prettier (format:check only verifies)
npm test             # unit and component tests (Vitest)
npm run check        # format check, typecheck, lint, unit tests, gofmt/go vet/go test; prints only failures
                     # (-- <paths> limits the JS tests; -- --e2e also builds and runs the e2e tests)
npm run inspect      # print element boxes in the built app as text: npm run inspect -- "<selector>" [--shot]
npm run fetch:llama  # download the pinned llama.cpp build (resources/llama/llama.json) into resources/llama/bin
npm run build:core   # go build -C core → resources/core/core.exe (dev and build run it; needs Go, see core/go.mod)
npm run build        # build core, typecheck, production build to out/
npm run build:win    # build + Windows installer (electron-builder)
npm run test:e2e     # build, then launch the real app with Playwright (tests/e2e); full output
                     # (quiet: npm run check -- --e2e, or -- tests/e2e/<name>.spec.ts for some specs)
```

Run `npm run check` before every commit: it covers typecheck, lint, format check and the tests in one short report.

UI components come from shadcn/ui: add them with `npx shadcn@latest add <name>` (config in `components.json`);
they land in `src/renderer/src/components/ui/` and are ours to edit.

## Structure

```
src/main/        Electron main process: windows, tray, settings, starting services, IPC handlers
src/preload/     the only bridge between UI and main; exposes a typed window.api
src/shared/      types shared by main and renderer (IPC contract, settings schema)
src/renderer/    React UI
core/            Go module (`core.exe`): listens on 127.0.0.1 only, every request needs a per-run token and a
                 matching Host header; bundled into the app as an extra resource, built by `npm run build:core`
tests/unit/      Vitest + Testing Library in jsdom (config: vitest.config.mts, setup: tests/setup.ts);
                 query by role or label, the way a user finds things — not by class names
tests/e2e/       Playwright; each run gets a temporary user-data folder (testProfile.ts), never the real one
resources/llama/ pinned llama.cpp release (llama.json, licence); the Vulkan build is fetched into bin/ (git-ignored)
vendor/          git submodules (Open WebUI); never edit files here
```

## Code style

- TypeScript strict; no `any`. Named exports.
- Files `camelCase.ts`; React components `PascalCase.tsx`, one component per file.
- Prettier formatting (2 spaces, single quotes, no semicolons); ESLint must pass.
- The renderer never uses Node APIs or the file system directly. Everything privileged goes through
  `window.api`, typed in `src/shared/ipc.ts`.
- Keep comments for the _why_; the code should say the _what_.

## Security rules

- Every window: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP.
- Never load remote web pages inside the app; open external links in the default browser (http/https only).
- Services listen on `127.0.0.1` only. `core` also requires its token on every request; never log the token.
- Never commit secrets, tokens, keys, `.env` files or model files.

## Git workflow

- `main` is protected: changes land through pull requests with passing checks.
- Branch names: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`, `ci/<topic>`.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, unit tests, the Go checks, build (incl. `core.exe`) and e2e tests on Windows for every
  pull request and push to `main`. Actions are pinned to commit SHAs with the release in a comment.
- Dependency install scripts need approval (`allowScripts` in `package.json`); review any new prompt from
  `npm install-scripts ls` instead of approving everything.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary` — types `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`;
  scope is the module (`shell`, `services`, `chat`, `code`, `automations`, `setup`).
  Example: `feat(shell): restore last open tab on startup`
- Small, focused commits. Do not mix refactors with features.

## Boundaries

- **Always:** keep the renderer sandboxed; add or update tests with every behavior change; keep this file
  current when commands or structure change.
- **Ask first:** new dependencies; changes to the security rules; changes to the IPC contract shape;
  updating a submodule.
- **Never:** edit `vendor/`; disable tests to make CI pass; commit secrets or large binaries; push to `main` directly.
