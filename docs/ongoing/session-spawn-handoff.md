# Handoff: agent-driven session spawning (issue #358)

**Status:** MVP implemented (commit 5fc36eb, session-bound tool servers included) / phase 2 ready to implement
**Author:** handoff from Chad + Claude, 2026-08-15
**Branch:** start from `main`
**Issue:** https://github.com/chadbyte/clay/issues/358 ("I have 10 issues and
I want a session per issue... I want one session to create 10 new ones")

---

## Mission

Let an agent session create N sibling sessions, each with its own title and
starting prompt, so a user can say "make one session per issue" and have the
parent fan the work out. MVP is an in-app MCP tool; every building block
already exists in the codebase and is listed below with file:line.

## Constraints (same as every clay handoff)

- Root `CLAUDE.md`: `var` only, no arrow functions, CommonJS server-side,
  English comments/commits, Angular commits, modules under 500 lines, no
  inline logic in `project.js` handleMessage, read
  `docs/guides/MODULE_MAP.md` first.
- Do not commit/push/PR without explicit approval from Chad.
- Keep green: `npm test`, both `node --check` sweeps,
  `node scripts/check-client-imports.js`.

---

## Existing building blocks (verified)

| Mechanic | Where | Note |
|---|---|---|
| Programmatic session creation | `sm.createSession(sessionOpts)` — used by loop (`lib/project-loop.js:415`) and debate (`lib/project-debate.js:529`) | `sessionOpts` supports `ownerId`, `vendor`, `sessionVisibility` |
| Start a session with a prompt | `sdk.startQuery(session, promptText, undefined, linuxUser)` (`lib/project-loop.js:511`) | linuxUser via the same resolution loop uses (`getLinuxUserForSession`) |
| Completion hook | `session.onQueryComplete = function(completedSession) {...}` — loop uses it (`lib/project-loop.js:435`); consumed at `lib/sdk-bridge.js:950,968` | drives the concurrency queue below |
| In-app MCP tool pattern | `lib/debate-mcp-server.js` (SDK-free tool defs + `buildShape` zod helper) wired in `lib/project.js:482-501` via `adapter.createToolServer({ name, version, tools })` | copy this shape exactly |
| Per-project MCP gating | `getLocalMcpServers()` (`lib/project.js:643-660`) filters servers by availability | add the spawn gate here |
| Session fork (phase 2) | `fork_session` WS flow (`lib/project-sessions.js:1220`), `sdk.forkSession(session, uuid)` -> `forkSessionUnified` (`lib/sdk-bridge.js:1065`), adapter capability `fork` (claude: true) | fork carries parent context into the child |
| Vendor validity | `adapters[vendor]` presence + `sm.capabilitiesByVendor`, plus the vendor registry (`lib/yoke/vendor-registry.js`): `osUserIsolation` gates kiro for isolated users | reuse, do not re-hardcode vendor names |

No new WS message types are needed for the MVP: children appear through the
existing `session_list` broadcast (`sm.broadcastSessionList()`), and the tool
result returns their ids to the parent agent.

---

## Design

### New files

1. **`lib/session-spawn-mcp-server.js`** (SDK-free, mirrors
   `debate-mcp-server.js`): tool definitions only, handlers delegate to
   callbacks injected from the attach module.

2. **`lib/project-session-spawn.js`**: `attachSessionSpawn(ctx)` owning all
   orchestration state. Exposes `{ createMcpServer }`. `ctx` needs: `sm`,
   `getSdk` (late-bound; the sdk bridge is created after mcpServers in
   project.js, so inject a getter, not the instance), `send`, `isMate`,
   `usersModule`, `getSessionForWs` is NOT needed (MCP handlers do not have
   a ws; resolve the calling session instead, see "parent resolution").

### Tools (MCP server name: `clay-sessions`)

**`spawn_sessions`**
- Input: `sessions` (JSON string, array of `{ "title": string, "prompt":
  string }`), `vendor` (optional string; default = parent session's vendor,
  else project default). JSON-string array input follows the
  `propose_debate` precedent (`debate-mcp-server.js:45`) because
  `buildShape` only supports flat primitives.
- Validates, creates each session, queues their queries, returns
  `{ spawned: [{ localId, title }], queued: n, running: n }` as the tool
  text (JSON stringified).

**`check_spawned_sessions`**
- No input (or optional `parentOnly` boolean, default true).
- Returns each child of the calling session: `{ localId, title, status:
  "running" | "done" | "error", turnCount, lastActivity }`. Status: running
  = `isProcessing`; error = last history entries contain `type: "error"` or
  `done` with code 1 (same heuristic as `lib/project-loop.js:441-449`);
  else done. This closes the loop: the parent can poll and summarize.

### Parent resolution

MCP tool handlers receive only tool args, no session. Resolve the caller the
same way debate does: the tool server is per-project and the handler runs
during a specific session's turn. Follow how `_pendingDebateProposals` +
`tool_executing` correlate, or simpler: thread the calling session through
`createToolServer` if the adapter supports per-session tool context. If
neither is clean, fall back to what ask-user does (`lib/project.js:521+`,
stateless post). REQUIRED: the implementing agent must read how
`propose_debate`'s handler learns which session called it, and use the same
mechanism. Do not guess; if the answer is "the project's active session",
document that limitation in the tool description.

### Session record

Children get:

```js
session.spawn = {
  parentId: <parent localId>,
  index: i,            // position in the batch
  batchId: "sp_" + Date.now().toString(36),
};
session.title = args title (trimmed, fallback "Spawned task " + (i+1));
session.ownerId / visibility inherited from parent;
session.vendor = resolved vendor;
```

Persist with `sm.saveSessionFile(session)` and broadcast once per batch.

### Safety rails (all hard requirements)

1. **No grandchildren.** If the calling session has `session.spawn`, the
   tool returns an error ("spawned sessions cannot spawn further sessions").
   This is the fan-out bomb guard.
2. **Caps.** Max 10 sessions per call, max 20 live children per parent
   (count children whose `spawn.parentId` matches). Constants at the top of
   `project-session-spawn.js`.
3. **Concurrency queue.** Do not start 10 SDK queries at once. Start at most
   `SPAWN_CONCURRENCY = 3`; queue the rest; on each child's
   `onQueryComplete`, start the next queued one. Children are fresh sessions
   so the `onQueryComplete` slot is free (loop/auto-continue only set it on
   their own sessions; see `lib/sdk-bridge.js:950`).
4. **Permissions.** Do NOT add `mcp__clay-sessions__*` to the auto-approve
   block in `lib/sdk-bridge.js` (the clay-history/email pattern) and do NOT
   add it to `CLAY_MANAGED_ALLOW` in `lib/claude-hook-installer.js`.
   Spawning is powerful; the default permission prompt must fire. In
   allow-all/bypass sessions it will auto-run, which is consistent with what
   the user opted into.
5. **Vendor guards.** Reject a vendor with no adapter in `adapters`; reject
   a vendor whose registry entry has `osUserIsolation: false` when the
   parent runs as an isolated linuxUser (mirror `lib/sdk-bridge.js:1111`
   semantics through the registry, never `vendor === "kiro"`).
6. **linuxUser inheritance.** Children run as the parent's Linux user (same
   resolution loop uses: owner's linuxUser in multi-user mode).

### Gating

In `lib/project.js` mcpServers block: register `clay-sessions` only when
`!isMate` (mate DMs are conversations, not work fan-out surfaces; revisit
later if asked). In `getLocalMcpServers()` no dynamic condition is needed
beyond that static gate, but keep the hook in mind if spawn ever becomes
config-gated.

### Delivered by the MVP (commit 5fc36eb)

Everything above is implemented, plus one correction over this document's
original text: tool servers are **bound per query** to the calling session
(`getLocalMcpServers(forSession)` in `lib/project.js`,
`getMcpServers(session)` in `lib/sdk-bridge.js:1334`). Never resolve the
caller via `sm.getActiveSession()` — that is the project-global "last
viewed" session and breaks the depth guard; the unbound descriptor-listing
instance fails closed by design. Keep this invariant in phase 2.

### Out of scope for phase 2 as well (do not build)

- Sidebar grouping of children under the parent (loop-group UI is the
  template when it happens).
- Parent auto-notification when all children finish; polling covers it.
- Worktree-per-child isolation. In Clay a worktree is a separate project
  (own slug and project context, see `lib/daemon-projects.js`), so spawning
  into worktrees is cross-project orchestration — a phase 3 design of its
  own. Phase 2 children share the parent's cwd; the tool description
  should keep advising analysis-style parallelism over concurrent edits.
- Issue #357 (vendor handoff) still builds on `spawnOne`; unchanged.

---

## Phase 2: `forkFromCurrent` (context-inheriting spawn)

**Goal:** the pattern promised in issue #358's thread (Karamorf's fork
workflow, endorsed by the maintainer comment): load context once into the
parent, then fan out children that START with that context, no re-explaining.

### Existing fork pipeline (verified, reuse it)

The UI fork already does everything per child; steal its recipe from
`lib/project-sessions.js:1220-1266`:

1. `sdk.forkSession(session, uuid)` -> resolves `{ sessionId: <new
   cliSessionId>, useLocalHistory: <bool> }` (`forkSessionUnified`,
   `lib/sdk-bridge.js:1065`, which calls
   `adapter.forkSession(session.cliSessionId, { upToMessageId: uuid, dir: cwd })`).
2. If `useLocalHistory`: copy the parent's local `history` (the UI trims to
   the uuid's `historyIndex`; for full-context spawn just copy
   `session.history.slice()`), rebuild `messageUUIDs` from `message_uuid`
   entries, set `forked.cliSessionId = result.sessionId`.
3. Else: `require("./cli-sessions").readCliSessionHistory(resolveSessionHome(session), cwd, result.sessionId)`
   provides the display history.
4. A later `startQuery` on the child resumes the forked CLI session because
   `resumeSessionId: session.cliSessionId` (`lib/sdk-bridge.js` queryOpts) —
   that is what actually gives the agent the parent context. The local
   history copy is only for the transcript UI.

### Tool surface change

Add one optional input to `spawn_sessions`:

- `forkFromCurrent` (boolean, default false): "Children start with a copy
  of this session's full conversation context."

No new tool. `check_spawned_sessions` unchanged.

### Implementation in `attachSessionSpawn`

In `spawn(args, caller)` when `args.forkFromCurrent` is true, validate
BEFORE creating anything:

1. `caller.cliSessionId` must exist (the parent has completed at least one
   turn). Error text: "forkFromCurrent requires the calling session to have
   at least one completed turn".
2. Capability gate: `sm.capabilitiesByVendor[vendor]` must have
   `fork: true`. Note the capabilities map is only populated after adapter
   init (the parent is mid-query, so its own vendor is always initialized —
   but guard anyway and fail with a clear error).
3. Vendor lock: an explicit `args.vendor` different from `caller.vendor`
   is an error ("forkFromCurrent children must use the parent's vendor") —
   a fork is a CLI-native session copy and cannot change runtime.
4. Fork uuid: use the LAST entry of `caller.messageUUIDs` (full context).
   If `messageUUIDs` is empty but `cliSessionId` exists, still call
   forkSession with the last uuid absent — check what
   `adapter.forkSession` does with `upToMessageId: undefined` before
   relying on it; if it throws, treat as error (1) instead.

Then per child, BEFORE queueing (serially, in batch order):

- `await sdk.forkSession(caller, lastUuid)` -> `{ sessionId, useLocalHistory }`.
- Create the child exactly as the MVP does, then set
  `child.cliSessionId = sessionId` and copy the display history per the
  recipe above (both `useLocalHistory` branches).
- The queued `start()` is unchanged: push the task prompt as a
  `user_message` and `startQuery` — the query resumes the forked CLI
  session, so the agent sees parent context + its task prompt.

Failure handling: fork the children serially; if fork N fails, stop there
and return a tool result containing both `spawned` (the ones that made it,
already queued) and `failed: { index, error }`. Do not attempt rollback:
orphaned forked CLI sessions are inert JSONL copies and Clay sessions
already created are visible/deletable in the sidebar. The agent gets an
honest partial report.

Concurrency note: `sdk.forkSession` calls are awaited one at a time before
`queue.add` — do not interleave them with running child queries writing to
the same parent JSONL.

### Tests to add (extend `test/session-spawn.test.js`)

1. forkFromCurrent happy path: fake `sdk.forkSession` returning
   `{ sessionId: "cli-fork-N", useLocalHistory: true }`; assert each child
   gets its own `cliSessionId`, a copied history array (not the same
   reference as the parent's), and that the task prompt is appended AFTER
   the copied history when `start()` runs.
2. Parent without `cliSessionId` -> exact error, nothing created.
3. Capability gate: `capabilitiesByVendor` lacking `fork` -> error.
4. Vendor mismatch with `forkFromCurrent` -> error.
5. Partial failure: `forkSession` rejects on the 2nd child -> result lists
   1 spawned + the failure; queue only received the 1st task.
6. All existing tests stay green (default `forkFromCurrent: false` path
   must be byte-for-byte the MVP behavior).

### Phase 2 acceptance criteria

1. Live: load a plan into a parent session, spawn 3 children with
   `forkFromCurrent: true`, and each child demonstrably knows the plan
   without it appearing in its task prompt (ask each child "what plan are
   you working from?").
2. Child transcripts in the UI show the inherited conversation followed by
   their own task prompt.
3. Fresh-spawn path (default) behaves exactly as before.
4. Error paths above verified; `npm test` green; sweeps green.
5. Issue #358 can be closed referencing both the MVP and this phase
   (draft the closing comment for Chad's approval — never post without it).

---

## Tests

`test/session-spawn.test.js` (node:test, CommonJS). Extract the pure logic
(cap checks, depth guard, batch parsing/validation, queue advancement) into
exported helpers on `project-session-spawn.js` (or a small
`lib/session-spawn-policy.js` if attach-ctx coupling makes direct testing
awkward) and test:

1. Batch parse: valid JSON array accepted; non-array / missing prompt /
   more than 10 entries rejected with the exact error strings.
2. Depth guard: a session with `spawn.parentId` cannot spawn.
3. Children cap: 20th child allowed, 21st rejected.
4. Queue: with concurrency 3 and 5 tasks, 3 start immediately; completing
   one starts the 4th; completing all leaves the queue empty.
5. Vendor guard: unknown vendor rejected; isolated-user + registry
   `osUserIsolation: false` vendor rejected (use the real registry).

---

## Acceptance criteria

1. In a normal project session, asking the agent to "create three sessions,
   one per X" produces a `spawn_sessions` permission prompt; approving
   creates 3 titled sessions that appear in the sidebar and start running
   (max 3 concurrent), each answering its own prompt.
2. `check_spawned_sessions` from the parent reports running/done/error
   correctly after the children finish.
3. A spawned child asking to spawn gets the depth-guard error.
4. Caps and vendor guards behave per the tests; `npm test` green with the
   new suite; all static sweeps green.
5. No auto-approve entries added anywhere for `mcp__clay-sessions__*`.
6. `docs/guides/MODULE_MAP.md` gains rows for the two new files.

---

## Verification log

### 2026-08-16 — phase 2 verified

- 78/78 tests (6 new fork tests), syntax sweeps and import check green.
- Code-verified the fork semantics the implementation relies on: Claude SDK
  `ForkSessionOptions.upToMessageId` "If omitted, full copy" (sdk.d.ts:708),
  Codex `thread/fork` ignores the uuid option (codex.js:1567),
  `readCliSessionHistory` resolves [] on errors (no spurious fork failures).
- Live E2E on the dev daemon: context planted in a parent ("Spiderman"
  codename + three rules), two forkFromCurrent children spawned via the
  spawn_sessions permission card; both children knew the codename and rules
  without them appearing in their task prompts. Depth guard and permission
  prompt behaved as designed.
- Known cosmetic limitation: codex forkFromCurrent children resume with full
  context but their Clay transcript shows only the task prompt (codex fork
  reads no local JSONL); same behavior as the existing UI fork on codex.
- Gotcha reconfirmed: server-side changes need a daemon restart; a stale
  daemon leaves the tools unmounted and the agent improvises with
  `claude --fork-session` in Bash.
