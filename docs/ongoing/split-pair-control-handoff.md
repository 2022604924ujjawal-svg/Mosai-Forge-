# Split pair control: one pane drives the other

**Goal (Chad, 2026-08-16):** in a split group, one session (the driver)
can direct the other (the worker) and read its results. Example flow:
Fable plans and reasons in the left pane; gpt-5.6-sol (medium) executes
in the right pane; the user watches both live.

This is NOT spawn (#392): the partner is a visible, persistent, user
-chosen session with its own vendor/model, not a disposable child. It is
also narrower than #357 vendor handoff (no context digest; the driver
talks to the worker in plain text).

## Why this is mostly plumbing that exists

- Session-bound MCP tools: `lib/project-session-spawn.js:333-347`
  (`createMcpServer(adapter, boundSession)`) wired per query in
  `project.js:681-699` (`getLocalMcpServers(forSession)`). The depth
  -guard convention (never resolve the caller via `getActiveSession`)
  is already established there (spawn.js:248-253).
- Injecting a message into another session: `spawnOne.start`
  (spawn.js:211-242) already does history push + `sdk.startQuery`.
  For a LIVE partner query, `sdk.pushMessage` returns false when
  undeliverable and callers fall back to `startQuery`
  (project-user-message.js dispatchToSdk, commit 40d537e).
- Partner status: `check_spawned_sessions` (spawn.js:308-331) shows the
  status-reading pattern (`isProcessing`, `hasSessionError`).
- Group membership: `session-split-groups.js` store exposes
  `groupForMember(localId)`; `attachSplitGroups` returns `{store}`
  (project wiring already holds it for delete hooks).
- Per-session model persistence (commit c0552b0) means the worker pane
  reliably stays on its chosen model (e.g. gpt-5.6-sol).

## Tools (added to the existing `clay-sessions` MCP server)

Both tools are available ONLY when the bound session is a member of a
split group; otherwise they return a clear error telling the model the
session has no split partner. The partner is always "the other member
of my group" — no arbitrary session ids accepted (containment rail).

### `send_to_partner`

Args: `message` (string, required), `wait` (bool, default true),
`timeoutSeconds` (int, default 300, max 900).

1. Resolve partner via `splitGroups.groupForMember(bound.localId)`;
   error if none. Multi-user: partner must pass `canAccessSession` for
   the same owner (mirror spawn's ownership stance).
2. Loop rail: if the bound session's CURRENT turn was itself initiated
   by a partner delegation (see `_delegatedBy` below), refuse with
   "delegation loop" — the worker may answer, not re-drive the driver.
3. Record `{type: "user_message", text, delegated: true}` in the
   partner's history + session file, note the history index.
4. Deliver via the standard path: if `sdk.pushMessage(partner, ...)`
   returns false, `sdk.startQuery(partner, message, undefined,
   linuxUser-for-partner)`. Set `partner._delegatedBy = bound.localId`
   for the duration of the turn (cleared when isProcessing flips
   false). Set `partner.isProcessing`/broadcast exactly as
   dispatchToSdk does so both panes' UIs show the activity live.
5. If `wait`: poll `partner.isProcessing` (500ms) until false or
   timeout. On completion, return `{status, response}` where response =
   concatenation of the partner's `{type:"delta"}` history entries
   recorded after the index from step 3 (skip `thinking_delta`; cap at
   ~30k chars with a truncation note + hint to use `read_partner`).
   On timeout return `{status:"running"}` and tell the model to call
   `read_partner` later. If `wait:false`, return immediately.

### `read_partner`

Args: `lastTurns` (int, default 1, max 5).

Returns partner status (`running` | `done` | `error`, same derivation
as check, spawn.js:322) plus the text of the last N turns (user_message
boundaries; `delta` entries concatenated per turn, same cap as above).

## Safety rails (hard)

- Split-group members only; tool errors outside a group.
- No third-session reach: the partner id is derived server-side, never
  taken from tool args.
- One-hop delegation: a turn started by `send_to_partner` cannot itself
  call `send_to_partner` (the `_delegatedBy` guard above). This kills
  ping-pong loops while still allowing the worker to use its own tools.
- Delegated user_messages carry `delegated: true` so the UI can badge
  them (client polish, optional in v1) and so transcripts stay honest.
- The wait poll must hold no strong assumptions about query lifetime:
  isProcessing is the only signal (works for SDK, worker, and codex
  paths; it is reset in every completion/error path per 40d537e).
- Notifications: a delegated turn should not fire "response ready"
  banners for the worker pane (check project-notifications emitters;
  respect the same silence the adopted-session fix used if needed).

## Entry point: "Pair session" in the New session menu (Chad, 2026-08-16)

Two paths share the same tool plumbing; the group record decides the
role model.

Add an optional `pair: { driverId, workerId }` field to the split-group
record (persisted like the other fields; anchor by cliSessionIds the
same way members are, per a63c3c4).

### Configured pair (primary UX)

- Sidebar "New session" split-button gains a "Pair session..." entry.
- Dialog: driver vendor+model, worker vendor+model (+ worker effort
  where the vendor supports it, e.g. codex modelReasoningEffort).
  Default suggestion: driver = claude/current model, worker = last
  used codex model.
- On confirm (one WS message, e.g. `pair_session_create`): create both
  sessions (with `model` in sessionOpts, supported since c0552b0),
  create the split group with `pair` set, open the split (client
  receives the group id and calls openGroup).
- Role asymmetry: ONLY the driver gets `send_to_partner` /
  `read_partner` mounted (getLocalMcpServers checks the group's pair
  field). The worker gets neither — cleaner containment than the loop
  guard.
- Driver preset: when a session is a pair driver, sdk-bridge appends a
  short instruction block to its query context ("You are the planner.
  Delegate execution to your split partner via send_to_partner; review
  its results before proceeding."). Keep it terse; the user's own
  prompts carry the task.

### Ad-hoc pair (existing splits)

- Any split group WITHOUT `pair`: both members get the tools, guarded
  by the one-hop delegation rail. No preset injection.
- This keeps the "already mid-conversation with Fable, now hand
  execution to Sol" flow: make a split from the running session, use
  the tool directly.

## UI

Priority order:

1. **Delegated-message rendering (required):** a delegated
   user_message in the worker pane renders with the DRIVER session's
   vendor avatar, a "from <driver title>" label, and a tinted bubble.
   Client keys off `delegated: true` + `delegatedBy` metadata on the
   history item.
2. **Divider flow indicator:** while a send_to_partner is in flight the
   split divider shows a directional pulse (driver -> worker). Server
   broadcasts `split_delegation {groupId, from, to, active}`; the
   parent shell (split-view.js) renders it. Reuses the pane-bridge era
   broadcast plumbing.
3. **Header badges:** worker header shows "지시 수행 중" with the
   driver's vendor icon during a delegated turn; driver header shows a
   waiting indicator while blocked in `wait`. For configured pairs,
   permanent Driver/Worker role badges in the pane headers.
4. **Polish (later):** custom tool card for send_to_partner in the
   driver transcript (sent text, live elapsed, collapsed response
   preview); thin composer notice in the worker pane while a delegated
   turn runs ("왼쪽 세션의 지시를 처리 중 — 지금 보내면 이어서
   반영됩니다").

## Explicitly out of scope (v1)

- Digest/context transfer between panes (#357 covers that).
- More than 2 panes.
- Interrupting the partner from the driver.
- Converting an existing plain group into a configured pair (revisit;
  ad-hoc tools cover the need meanwhile).

## Tests

- Pure helpers: partner resolution (grouped/ungrouped/dissolved
  mid-turn), response extraction from history fixtures (delta concat,
  truncation, turn boundaries), loop-guard state machine.
- Tool handlers with a stubbed sm/sdk: send while partner idle (start
  path), while partner live (push path), push-fail fallback, timeout
  path, wait:false path, delegation-loop refusal.

## Acceptance (live, daemon restart first)

0. New session ▾ -> Pair session: pick Claude(fable) driver +
   Codex(gpt-5.6-sol, medium) worker -> split opens with role badges;
   worker session has NO send_to_partner tool; driver preset visible in
   its first query context (debug log).
1. Or make an ad-hoc split: left = Claude (fable), right = Codex
   (gpt-5.6-sol, medium). Both panes visible, both have the tools.
2. Tell the left pane: "X 기능 계획을 세우고, 구현 지시는
   send_to_partner로 오른쪽 세션에 넘겨. 결과를 검토해."
3. Left pane plans (thinking visible per 5b04241), calls
   send_to_partner; right pane starts streaming its execution live.
4. Left pane receives the worker's answer, reviews, iterates.
5. Worker pane cannot re-drive the driver (ask it to try; expect the
   loop-guard error).
6. Dissolving the group mid-wait fails the pending tool call cleanly.
