@AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (NaruXT/pasolibre-samu) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (root `CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.

## Intent Layer

**Before starting any of the 11 tracer-bullet tickets in the GitHub issue tracker, read this section first** — the codebase itself is still just the default `create-next-app` scaffold, so these decisions aren't visible anywhere else yet.

No child `AGENTS.md` nodes exist — `app/` and `docs/` are both well under the 20k-token threshold. Re-run `scripts/estimate_tokens.sh` from the `intent-layer` skill once real feature code lands under `app/` (API routes, map components, domain logic) to check whether a node is warranted there.

### Global Invariants

- **One Next.js project, no separate service.** The sequencing agent lives in a Next.js API route — never split it into a Python service or a second deployable.
- **Single orchestration seam.** All tick logic (ETA calc → cycle phase calc → LLM call → Portal publish) funnels through one API route. Tests exercise that route as a unit; only the LLM call and the Portal REST call are replaced with test doubles — ETA and cycle-phase calculations are pure functions and must run for real in tests.
- **The agent decides once per semáforo per trayecto.** Invoke the LLM only when a semáforo's ETA enters the decision window (~60s) and no decision has been published for it yet in this trip. Never re-invoke on later ticks for an already-decided semáforo.
- **Semáforo cycle phase is a pure function of `(semaforoId, elapsedTime)`.** 90s cycle, 45s green / 45s red, per-semáforo offset derived deterministically from `semaforoId` (e.g. a hash) — never `Math.random()`, never state stored separately from that derivation.
- **`semaforos-ruta-1` (Portal channel) is the source of truth for interventions.** Reconstruct a semáforo's effective phase as: base deterministic cycle + any decisions already published to that channel for its `semaforoId` in the active trip. Don't build a separate mutable store for this.
- **Portal channel semantics are fixed and differ by publisher:** `ambulancia-1` (client, `ephemeral: true`, WebSocket) · `ruta-ambulancia-1` (one publish per trip, not ephemeral) · `semaforos-ruta-1` (server, REST, **not** ephemeral — the server REST endpoint has no `ephemeral` field; this is accepted, not a bug).
- **The ambulance is never slowed by traffic.** It moves at Mapbox's estimated route-leg pace (priority vehicle). TomTom Traffic Flow is consulted only for cross-traffic congestion at each semáforo, as context fed to the LLM's decision — never to modulate the ambulance's own speed.
- **Destination is fixed:** Hospital Nacional Edgardo Rebagliati Martins (`-12.0784, -77.0399`). Only the emergency origin point is user-selected.
- **Portal server-side auth details are unresolved** — the secret-key format and anonymous-JWT minting flow aren't documented publicly. Resolve by reading the generated `portal.config.ts` or SDK source when implementing ticket #1, not by guessing env var names.
- Full architecture rationale lives in GitHub issues #1–#11 (`ready-for-agent` label) and their native `blocked_by` dependencies — read the target ticket's issue body before starting it, it carries acceptance criteria this file doesn't repeat.
