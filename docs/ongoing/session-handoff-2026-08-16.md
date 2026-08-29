# Session handoff: 2026-08-15/16 working state

**Author:** Claude session with Chad, closing 2026-08-16.
**Purpose:** Chad is moving day-to-day work into Clay itself. This document
is the complete state transfer: what shipped, what is in flight on which
branch, what to do next, and the working conventions that produced it.
Assume no other context.

---

## 1. Shipped to main this session (all released)

| Release | PR | What |
|---|---|---|
| v2.47.0-beta.2 | #385 | Kiro CLI adapter via ACP (contributor Brandon's commits preserved; re-verified against CLI 2.18.1 v3 engine; docs in `docs/guides/KIRO-INTEGRATION.md`) |
| v2.47.0-beta.3 | #390 | YOKE static vendor registry (`lib/yoke/vendor-registry.js`) + descriptive capability map; vendor-string conditionals outside yoke reduced from ~24 to 2 documented survivors |
| (no bump) | #391 | Mate datastore (`node:sqlite`) removed end to end; `~/.clay/mates/*/store.db` files left on disk |
| v2.47.0-beta.4 | #392 | Agent-driven session spawning (`clay-sessions` MCP: `spawn_sessions` / `check_spawned_sessions`) + `forkFromCurrent` context inheritance. Closed issue #358 |
| v2.47.0-beta.5 | #393 | Per-session vendor badges in the sidebar + connect-time session_list unified onto `mapSessionForClient` (fixed vendor/spawn/unread fields missing on first render) |
| v2.47.0-beta.6 | #394 | Worktrees presented as branches: title-bar branch chip (always visible on git projects, `isGitRepo` from `/api/branches`), worktree folder removed from the icon strip, "Add Worktree" menu entries removed |

Also merged earlier in the session: sidebar "New session" split-button with
vendor dropdown + per-project `lastVendor`; Anthropic billing-policy TUI
banner removed; GUI confirmed default everywhere. Issues #382 and #358
closed with comments.

## 2. In flight: branch `spike/split-view-iframe`

```
38c53a1  fix(notifications): silence banners for adopted external CLI sessions
398f629  feat(sessions): make a split a first-class group (Arc-style)
4f6d5a4  feat(ui): two-pane split view via chrome-less iframe panes
```

The three implementation commits above are followed by `dd7878c`, which adds
this handoff. The tree was clean at that commit; the acceptance-status update
below is the only subsequent working-tree change.

Architecture decision (recorded in
`docs/ongoing/split-view-spike-handoff.md`, verdict **PASS**): symmetric
iTerm-style split view is built by composing chrome-less iframe instances of
the existing app (`/p/<slug>/?pane=1&session=<id>`), NOT by refactoring the
session view into a component. The 2026-04 plan under
`docs/roadmaps/planned/split-view/` is superseded; its iframe ban is
overturned with recorded evidence.

Key mechanics: pane WS connections (`?pane=1` parsed by `lib/ws-request.js`)
skip restore/presence/auto-create; one-shot session pin per socket
(`lib/public/modules/pane-session.js`); parent shell
(`lib/public/modules/split-view.js`) owns drop zones above the iframes;
`X-Frame-Options` moved DENY -> SAMEORIGIN + CSP `frame-ancestors 'self'`.

Split groups (`docs/ongoing/split-group-handoff.md`, implemented and
code-verified): a split IS one session — one sidebar row, persisted in
`sessionsDir/split-groups.json`, Rename (inline) and Separate are
first-class, member deletion auto-dissolves (hooks on both delete paths),
uncustomized names follow member renames, remote dissolution closes open
splits everywhere.

The notification fix (38c53a1) is UNRELATED to split view: external `claude`
runs adopted into the sidebar were raising response/attention banners; now
adopted sessions carry a persisted `adopted` flag and both emitters
(`project-sessions.js` jsonl watcher, `server.js` tui-notify endpoint) stay
silent until Clay attaches a PTY. Pre-fix adopted records lack the flag;
deleting those sidebar entries silences them.

### Split-group acceptance completed

The eight manual items in `docs/ongoing/split-group-handoff.md` were completed
against an isolated server and real browser after the implementation commit:

- drag-created groups replaced both member rows and reopened in stored order;
- reload and daemon-restart persistence passed using durable session records;
- inline rename survived reload, and customized names survived member rename;
- Separate and either pane X restored ordinary rows without deleting sessions;
- deleting one member dissolved the group and restored the survivor;
- clicking a third session closed only the visual split, and the group reopened;
- normal clients received `split_groups`, pane clients did not;
- browser console error collection was empty.

The detailed dated result is appended to
`docs/ongoing/split-group-handoff.md`. The isolated server, browser, and temp
state were removed after verification.

### Immediate next steps (in order)

1. Verify the notification fix live (run `claude` in a project cwd,
   restart daemon, confirm no banners).
2. **Cherry-pick 38c53a1 onto a fresh branch off main -> own PR -> merge
   first** (do not let the bugfix ride the bigger split PR).
3. PR the split set (4f6d5a4 + 398f629, minus the cherry-picked fix) as ONE
   PR for issue #387; comment on #387 when it ships (draft first — see
   conventions).

## 3. Backlog, in rough priority

- **Split-view MVP polish** (policy list from the spike verdict, now the
  backlog): focused-pane routing for sidebar/file/terminal actions,
  unread/notification policy for panes, coordinated reconnect overlays,
  >2 panes and horizontal/tree layouts + drag a session title onto ANY edge
  (Chad wants full up/down/left/right docking), cross-project pane UI,
  pane memory optimization.
- **#357 vendor handoff**: build on `spawnOne` (`lib/project-session-spawn.js`);
  digest mode = package parent context as text for a different-vendor child
  (fork is same-vendor/lossless; digest is cross-vendor/lossy). Rate-limit
  events can trigger a "continue with X" banner.
- **Worktree stage 2**: aggregate worktree sessions into the parent
  sidebar; then spawn-into-worktree (phase 3, cross-project orchestration —
  in Clay a worktree is a separate project context).
- **Diff change-set view**: the ONLY missing diff piece is a "current
  working-tree changes" view (file list + HEAD diff). Per-file
  history/diff/session-edit tracking already exists
  (`fs_file_history`/`fs_git_diff`/`fs_file_at`, `diff.js` renderer). Do
  not rebuild what exists.
- **Single-user absorption phases 4-6** (`docs/ongoing/SINGLE-USER-ABSORPTION.md`):
  dead-branch cleanup, ~44 `!isMultiUser()` sites; per-file with runtime
  testing, do not sweep blindly.
- **Capability model v2 / open-bridge migration**
  (`docs/ongoing/open-bridge-migration.md`): migrate lib/yoke to the
  open-bridge package BEFORE any big yoke rework; the vendor registry must
  move with it.
- Linter: consciously declined for now. Optional cheap guard: a grep step
  in pr-checks for `localStorage.`/`alert(`/`confirm(` under
  lib/public/modules.

Open issues: #387 (split view, in progress here), #373 (docker compose,
help-wanted), #357 (vendor handoff), #213 (agent mode — largely satisfied
by split view + spawn once shipped; consider commenting then).

## 4. Working conventions (these produced every merge above)

- **Pipeline**: spec each feature as a handoff doc in
  `docs/ongoing/<topic>-handoff.md` with verified file:line references,
  hard safety rails, tests, and acceptance criteria -> an implementing
  agent builds it -> verify the result against the doc AND primary sources
  (SDK type defs, live binary probes, actual DOM) -> fix what verification
  finds -> commit.
- Verification is not optional: it caught a depth-guard bypass
  (`getActiveSession` is the project-global last-viewed session — never
  resolve a tool caller with it; bind per query), a THINKING-section
  regression (capability `thinking` means "emits a stream", not "accepts
  config"), an iframe TUI overlay bug, and a mobile loop-index bug.
- **Commits**: Angular convention via the `angular-commit` skill, no
  Co-Authored-By, split mixed work by hunk when needed. Feature removals
  are `refactor` WITHOUT breaking markers (protect 2.x; semantic-release).
- **PRs**: merge commits only (contributor authorship), CI green before
  merge, fork PRs need a workflow-run approval click. PR bodies list
  out-of-scope survivors with justifications.
- **GitHub comments**: draft -> Chad approves -> post. Short. "How to try
  it" beats feature descriptions. Natural-language examples, never internal
  parameter names.
- **Server files need a daemon restart** (`npm run dev`, dev ports 2635/6);
  client files are no-cache. A stale daemon shows up as "the agent says the
  MCP tool does not exist" and then improvises with the CLI — restart
  before debugging.
- localStorage is banned for user state; groups/prefs persist server-side.
- Vendor logic goes through `yoke.getVendorInfo()` / capabilities — never
  `vendor === "kiro"` comparisons outside lib/yoke (2 documented survivors
  in app-panels.js).

## 5. Environment notes

- kiro-cli 2.18.1 installed and logged in on this machine; v3 agent engine
  via `--agent-engine v3`; protocol reference in
  `docs/guides/KIRO-INTEGRATION.md`.
- `~/.clay/clay.db` is NOT this repo's (likely clayOS); this repo has no
  sqlite usage since #391.
- Tests: `npm test` (97 passing as of 38c53a1). Sweeps:
  `node --check` over bin/lib CJS, `node --check --input-type=module` over
  lib/public, `node scripts/check-client-imports.js`. CI runs pr-checks
  (no npm install, stdlib only) + tests.yml (`npm ci --ignore-scripts`).
