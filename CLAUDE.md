# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build & typecheck
npm run build                              # daemon (src/ → dist/), runs postbuild (worker bootstraps, bin perms, build manifest)
npm run typecheck                          # daemon: tsc --noEmit
npx tsc --noEmit                           # same, daemon typecheck only
npx tsc -p server/tsconfig.json --noEmit   # server (stricter: noUnusedLocals, noImplicitReturns)
cd server && npm run typecheck             # equivalent, run from server/
cd web && npx tsc --noEmit                 # web typecheck (also stricter: noUnusedLocals) — REQUIRED before pushing, see below
npm run lint                               # eslint src/ only (server/, web/, test/ are NOT covered by this lint config)

# Tests (vitest workspace — root config wires daemon + web + most server tests together)
npm test                               # all projects (daemon, web, most of server, excludes e2e)
npm run test:unit                      # daemon only (src/**/*.test.ts, test/**/*.test.ts, excludes e2e + *.integration.test.ts)
npm run test:server                    # server project via root workspace (some server tests are EXCLUDED here, see below)
npm run test:web                       # web only (web/test/**/*.test.ts, jsdom environment)
npm run test:e2e                       # e2e only (test/e2e/**/*.test.ts, 90s timeout, requires tmux, fileParallelism disabled, retry: 2)
npm run test:integration               # daemon/root integration tests (vitest.integration.config.ts)
npm run test:coverage                  # coverage across daemon+web+server, then writes summary + checks thresholds
npx vitest run path/to/file.test.ts    # single file (works for any workspace project)

# Server has its own auth/proxy tests EXCLUDED from the root workspace (need server/node_modules,
# e.g. @hono/node-server, proxy-addr) — run these from inside server/, not from root:
cd server && npm test                  # includes auth-flow, bind-rebind, auth-security, proxy-addr,
                                        # password-auth, admin, cron-api, job-dispatch tests
cd server && npm run test:integration  # server/vitest.integration.config.ts

# Server (self-hosted backend)
cd server && npm run dev               # run server via tsx watch
cd server && npm run migrate           # apply PostgreSQL migrations

# Web
cd web && npm run dev                  # vite dev server
cd web && npm run build                # tsc --noEmit && vite build

# Dev
npm run dev                            # run daemon via tsx
```

A `husky` pre-commit hook runs `lint-staged`, which greps staged content for `API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY` and blocks the commit if found — don't rely on `--no-verify` to work around this; fix the leak.

## Architecture

IM.codes is a specialized instant messenger for AI coding agents — a three-tier system for remote terminal access, file browsing, multi-agent workflows, and session management:

```
You (browser / mobile app)
        ↓ WebSocket
Server (Node.js + Hono + PostgreSQL, self-hosted in server/)
        ↓ WebSocket
Daemon (Node.js CLI on user's machine, src/)
        ↓ tmux / ConPTY / transport
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw / Shell)
        ↔ imcodes send (agent-to-agent)
```

### Daemon (`src/`)

Node.js process that manages AI agent sessions via tmux. Entry point: `src/index.ts` (commander CLI).

- **Agent layer** (`src/agent/`): Two runtime backends — **process agents** run in tmux/ConPTY sessions, **transport agents** stream via network protocols.
  - Process drivers (`src/agent/drivers/`): `claude-code.ts`, `codex.ts`, `gemini.ts`, `opencode.ts`, `shell.ts` — each implements `AgentDriver` (build launch/resume commands, detect status via terminal patterns, capture output). `tmux.ts` wraps tmux (Linux/macOS), `conpty.ts` provides ConPTY (Windows).
  - Transport providers (`src/agent/providers/`): `qwen.ts` (Qwen, LOCAL_SDK — spawns CLI process with stream-json output), `openclaw.ts` (OpenClaw, PERSISTENT — WebSocket to gateway). Each implements `TransportProvider` — `connect()`, `send()`, `onDelta()`, `onComplete()`. Streaming is event-driven (no terminal scraping).
  - Agent types: `ProcessAgent = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'shell' | 'script'`, `TransportAgent = 'openclaw' | 'qwen'`. Defined in `src/agent/detect.ts`.
  - `session-manager.ts` manages all sessions, auto-restart with loop prevention. `provider-registry.ts` manages transport provider lifecycle.
- **Transport relay** (`src/daemon/transport-relay.ts`): Converts transport provider callbacks (`onDelta`, `onComplete`, `onError`) to unified timeline events (`assistant.text`, `session.state`, `tool.call`).
- **Routing** (`src/router/`): `message-router.ts` routes inbound messages to the correct session. `command-parser.ts` handles `/bind`, `/status`, `/send`, etc.
- **Server link** (`src/daemon/server-link.ts`): WebSocket client connecting to the server at `/api/server/:id/ws`. Sends `{ type: 'auth', serverId, token }` on open. Credentials stored in `~/.imcodes/server.json` after `imcodes bind`.
- **Session store** (`src/store/session-store.ts`): JSON file at `~/.imcodes/sessions.json`, debounced writes.
- **Shared context & memory** (`src/context/`): The largest daemon subsystem — embedding generation/fallback, memory recall (`memory-recall-*.ts`), memory search/write MCP tools, skill registry/resolution, live context ingestion, summary compression, and startup memory bootstrap. Backs the "Shared Agent Context & Memory" and Managed MCP Tools features described in the README. CPU-heavy work (embedding, markdown ingest, skill review) runs in worker threads (`*-worker.ts` + matching `*-worker-bootstrap.mjs`), not on the main event loop.
- **OpenSpec Auto Deliver engine** (`src/autofix/`): `state-machine.ts` drives the delivery run through stages, `audit-engine.ts` / `decision-engine.ts` produce the PASS/REWORK/BLOCKED verdicts, `branch-manager.ts` and `prompt-builder.ts`/`report-parser.ts` handle branch state and structured audit I/O. Orchestrated from the daemon side by `src/daemon/openspec-auto-deliver-orchestrator.ts`.
- **P2P / Team discussions and evolution pipeline** (`src/daemon/p2p-*.ts`, `src/daemon/evolution-*.ts`): Multi-agent discussion rounds, workflow compilation/materialization (mirrored in `shared/p2p-workflow-*.ts`), and the self-evolution factory pipeline (design → delivery runners, artifact store, inbox watcher).
- **Repo & issue tracking** (`src/repo/`, `src/tracker/`): Git provider abstraction (local git, GitHub, GitLab) for the Repository Dashboard feature; `src/tracker/` talks to GitHub/GitLab issue APIs.
- **CLI/bind/setup** (`src/bind/`, `src/setup/`, `src/cli/`): `bind-flow.ts` implements `imcodes bind`, `setup-flow.ts` implements `imcodes setup` (one-command self-host), `src/cli/send-output.ts` formats `imcodes send` CLI output.
- **Worker-pool pattern**: several daemon subsystems offload blocking work to `worker_threads` behind a pool (`fs-list-pool.ts`, `fs-git-status-pool.ts`, `jsonl-parse-pool.ts`, `timeline-history-pool.ts`, `file-preview-read-pool.ts`). Each has a `*-worker.ts` (worker logic), a `*-worker-bootstrap.mjs` (entry point copied to `dist/` by the `postbuild`/`copy-worker-bootstraps.mjs` script), and `*-worker-types.ts` (message contracts). Follow this pattern for new CPU-heavy daemon work rather than blocking the main loop.

### Server (`server/`)

Self-hosted Node.js backend (Hono). Has its own `tsconfig.json` and `node_modules`.

- **Routes** (`server/src/routes/`): `server.ts` includes WebSocket upgrade + session management. `passkey-auth.ts` handles WebAuthn passkey registration/login. `push.ts` dispatches push notifications to iOS (APNs) and Android (FCM). `cron-api.ts` manages scheduled tasks. `discussions.ts` serves P2P discussion runs/history. `file-transfer.ts` handles file upload/download. `session-mgmt.ts` provides session label/description/cwd CRUD.
- **WsBridge** (`server/src/ws/bridge.ts`): Holds the daemon WebSocket. Enforces auth handshake, queues messages when daemon is disconnected, relays between daemon and browser viewers. Binary PTY frames are routed only to browsers subscribed to the target session (not broadcast).
- **DB schema**: PostgreSQL migrations in `server/src/db/migrations/`. Key tables: `users`, `servers`, `sessions`, `sub_sessions`, `passkey_credentials`, `passkey_challenges`, `api_keys`, `scheduled_tasks`, `orchestration_runs`.
- **Logger** (`server/src/util/logger.ts`) recursively redacts keys matching `/_token$/i`, `/_key$/i`, `/_secret$/i` before output.

### Web (`web/`)

Vite + React web terminal viewer (`web/src/ws-client.ts` — WebSocket client with reconnect). There is no separate `mobile/` project — the iOS/Android apps are this same `web/` app wrapped with Capacitor (`web/capacitor.config.ts`, `web/ios/`, `web/android/`), adding biometric auth (`web/src/biometric-auth.ts`) and push notifications (`web/src/push-notifications.ts`) as native bridges. `web/src/pages/` holds top-level routed pages (Dashboard, Repo, Discussions, Cron, Admin, Settings, etc.); most feature logic lives in flat `web/src/*.ts(x)` modules and `web/src/components/`.

### i18n Development (`web/`)

The web project uses `i18next` with `react-i18next` for internationalization.

- **Storage**: Locales are in `web/src/i18n/locales/*.json`.
- **Structure**: JSON files use nested namespaces (e.g., `common`, `chat`, `session`).
- **Usage**:
  - Hook: `const { t } = useTranslation();`
  - Translate: `t('namespace.key')` or `t('namespace.key_with_params', { name: 'value' })`
- **Interpolation**: Uses double curly braces: `{{variable}}`.
- **Supported**: `en`, `zh-CN`, `zh-TW`, `es`, `ru`, `ja`, `ko`. Default is auto-detected from browser or `localStorage`.
- **MANDATORY**: All user-visible strings in `web/` MUST use `t()`. Never hardcode display text in any language. When adding new strings, update ALL 7 locale files.

## Key Conventions

- **FORBIDDEN — Never `git add` these directories:** `openspec/` and `docs/` are local-only planning/documentation directories. NEVER stage, commit, or push any file under `openspec/` or `docs/` to git. They are in `.gitignore` and must stay out of version control.
- Session names follow the pattern `deck_{project}_{role}` (e.g., `deck_myapp_brain`, `deck_myapp_w1`).
- Main sessions and sub-sessions are the same session model. Treat them as equally important in behavior, queueing, timeline semantics, edit/undo, and lifecycle handling. Differences should come only from parent/attachment relationship and presentation constraints, not from weaker semantics for sub-sessions.
- Agent types: Process = `'claude-code' | 'codex' | 'gemini' | 'opencode' | 'shell' | 'script'`, Transport = `'openclaw' | 'qwen'` — the `AgentType` union in `src/agent/detect.ts`.
- **Pod-sticky routing (MANDATORY for daemon-dependent requests)**: The server runs multiple replicas. Each daemon connects to ONE pod via WebSocket. The ingress routes any request that carries `serverId` (as a `?serverId=` query string OR as a `:serverId` URL-path parameter) to the pod holding that daemon's WS. Any endpoint that depends on the daemon (file transfer, session commands, Watch API, memory source resolution) **MUST** carry `serverId`. In-memory state (download tokens, WsBridge instances, terminal streams, pending RPCs) is per-pod — requests without serverId routing will hit a random pod and fail.
  - **Convention going forward — prefer `?serverId=` query string** for new routes. The ingress handles this generically: any route under `/api/...` that carries `?serverId=` is pod-sticky-routed without needing a dedicated path-style mount. Use `c.req.query('serverId')` server-side and treat its presence as the routing key. Path-style `/api/server/:serverId/...` mounts still work for existing routes (file-transfer, watch, cron, session-mgmt, etc.) — don't break them — but new routes should follow the query-string convention. Example: `GET /api/memory/sources?serverId=...&projectionId=...` lives under a flat `/api` mount and is automatically routed to the pod holding that daemon's WS.
- **MANDATORY — Transport command liveness contract:** Daemon command receipt and urgent-control delivery MUST preserve current dev behavior. The daemon MUST NOT intercept `/compact`; `/compact` is an ordinary SDK-native message and is forwarded unchanged to the transport provider. Provider adapters that expose a native compact RPC (for example Codex app-server `thread/compact/start`) MUST translate the raw `/compact` command at the SDK boundary instead of sending it as model text. Ordinary `session.send` ack is a daemon-receipt ack and MUST NOT wait for recall, live context bootstrap, memory lookup/enrichment, embedding, transport lock, pending relaunch, provider send-start, provider settlement, telemetry, or any background memory work. `/stop` and approval/feedback/control responses MUST use the priority path and MUST NOT be routed through or blocked by the ordinary send queue/locks.
- Server secrets (`JWT_SIGNING_KEY`) are set via environment variables, never committed.
- E2E tests require tmux. They are auto-skipped when `SKIP_TMUX_TESTS=1` or inside a Claude Code session (`CLAUDECODE` env var set).
- **MANDATORY — Test session hygiene:** Any e2e/integration test that creates tmux sessions, main sessions, sub-sessions, or temporary projects/cwds **MUST** use naming/path patterns covered by `shared/test-session-guard.ts`. If a new test introduces a new naming family, you **MUST** update `shared/test-session-guard.ts` and its tests in the same change. Leaked test sessions must never persist to `~/.imcodes/sessions.json`, must never be written to the server DB, and must be cleaned from live terminal backends on daemon startup.
- The server TypeScript project is stricter (`noUnusedLocals`, `noImplicitReturns`). Both daemon and server projects must compile cleanly.
- **Shared code between daemon, server, and web**: Use `shared/` directory (NOT `src/shared/`). Server tsconfig includes `../shared/**/*`. Import path from server: `../../../shared/foo.js`. Import path from daemon/test: `../../shared/foo.js`. Import path from web: `@shared/foo.js` (Vite alias configured in `web/vite.config.ts`). The `shared/` dir is copied into Docker image by `Dockerfile` (`COPY shared/ ./shared/`). **NEVER** import across project boundaries with `../../../src/` paths — they break at runtime in Docker.
- **Web tsconfig is stricter** than daemon (`noUnusedLocals`). The Docker build runs `cd web && npm run build` which will fail on unused variables/imports that pass `npx tsc --noEmit` in daemon. Always run `cd web && npx tsc --noEmit` before pushing.
- **MANDATORY — ZERO TOLERANCE: No hardcoded strings for types, statuses, message names, cookie names, header names, or any value shared across daemon/server/web.** Before writing ANY string literal that represents a type, status, event name, cookie name, or protocol constant:
  1. **STOP and search** `shared/` for an existing constant: `grep -r "your_string" shared/`
  2. If it exists → import it. If it doesn't → create it in the appropriate `shared/*.ts` file first, then import.
  3. **NEVER** define the same string in two places. Not even with a comment saying "must match X". Import it.
  4. Import paths: server uses `../../../shared/foo.js`, daemon uses `../../shared/foo.js`, web uses `@shared/foo.js`.
  - Existing shared modules: `shared/repo-types.ts` (repo message types), `shared/p2p-status.ts` (P2P run statuses), `shared/p2p-modes.ts` (P2P modes), `shared/cookie-names.ts` (cookie/CSRF constants).
  - **When adding a new constant**: add it to an existing shared module if it fits, or create a new `shared/<name>.ts` file.
- **MANDATORY: Never copy code. Always share and reuse.** If the same logic exists in daemon and server/web, extract it to `shared/`. If a utility function is needed in multiple files, create it once in `src/util/` or `shared/` and import it. Duplicate code is a bug factory.
