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

**Status:** early development. The Electron + React + TypeScript scaffold and unit tests exist;
`npm run test:e2e` arrives with the end-to-end setup.

## Stack

Electron · React 19 · TypeScript (strict) · Redux Toolkit + RTK Query · Tailwind CSS + shadcn/ui ·
electron-vite · Vitest + React Testing Library · Playwright (Electron) · GitHub Actions.
Do not add dependencies outside this list without asking.

## Commands

```
npm install          # install dependencies
npm run dev          # run the app with hot reload
npm run typecheck    # TypeScript checks for main, preload and renderer
npm run lint         # ESLint
npm test             # unit tests (Vitest)
npm run test:e2e     # end-to-end tests (Playwright)
npm run build        # production build
```

Run `typecheck`, `lint` and `test` before every commit.

## Structure

```
src/main/        Electron main process: windows, tray, settings, starting services, IPC handlers
src/preload/     the only bridge between UI and main; exposes a typed window.api
src/shared/      types shared by main and renderer (IPC contract, settings schema)
src/renderer/    React UI
tests/unit/      Vitest + Testing Library in jsdom (config: vitest.config.mts, setup: tests/setup.ts);
                 query by role or label, the way a user finds things — not by class names
tests/e2e/       Playwright
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
- Services listen on `127.0.0.1` only.
- Never commit secrets, tokens, keys, `.env` files or model files.

## Git workflow

- `main` is protected: changes land through pull requests with passing checks.
- Branch names: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
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
