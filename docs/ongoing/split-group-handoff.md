# Handoff: split groups (Arc-style "a split is one session")

**Status:** proposed / ready to implement
**Author:** handoff from Chad + Claude, 2026-08-16
**Branch:** continue on `spike/split-view-iframe` (on top of commit 4f6d5a4)
**Depends on:** the split-view spike (PASS, see
`docs/ongoing/split-view-spike-handoff.md`). This feature and the spike ship
as ONE PR; do not open a PR for either alone.

---

## Mission

Chad's model (2026-08-16, explicit): like Arc browser, combining two sessions
side-by-side produces a **group that is itself treated as one session**. The
two member rows disappear from the sidebar and one group row appears. Three
actions are first-class and guaranteed:

1. **Group**: created by the existing drag-to-split gesture.
2. **Separate**: an explicit action that dissolves the group back into two
   ordinary sessions (nothing is deleted).
3. **Rename**: a group has its own editable name, independent of member
   session titles.

Groups persist server-side (NEVER localStorage, root `CLAUDE.md` rule) and
survive reloads and daemon restarts: the group row remains in the sidebar and
clicking it reopens the split.

## Semantics (decide nothing yourself; these are the rules)

| Event | Result |
|---|---|
| Drop a session onto a drop zone (spike gesture) | Split opens AND a group record is created (auto-name, see below) |
| Click the group row | Open the split with both members (pane order = stored order) |
| Click any other session row while a split is open | Split closes visually; **the group persists**; the clicked session shows natively (Arc: switching tabs does not destroy a split tab) |
| Group row context menu -> Rename | Inline rename, same UX as session rename |
| Group row context menu -> Separate | Group record deleted; member rows reappear; if its split is open, exit to native on member[0] |
| Pane header X (either pane) | Same as Separate (a 2-member group cannot lose one member and remain a group) |
| A member session is deleted | Server dissolves the group automatically; clients are re-broadcast |
| Reload / daemon restart | Group rows come back from persistence; clicking restores the split |

Auto-name at creation: `"<title A> | <title B>"` (truncate each side to ~20
chars). Renaming overwrites it; member-title changes later do NOT rewrite a
custom name (track `nameCustomized`).

## Constraints

Root `CLAUDE.md` as always: `var`, no arrow functions, CommonJS server / ESM
client, store.js pattern, no localStorage, English comments/commits, Angular
commits, modules < 500 lines, no commit/push/PR without Chad's approval.
Keep green: `npm test`, both sweeps, `node scripts/check-client-imports.js`.

---

## Verified building blocks (file:line checked 2026-08-16)

| Fact | Where |
|---|---|
| Split shell, drop zones, pane lifecycle | `lib/public/modules/split-view.js` (spike, 190 lines) — `openSplit`, `closePane`, `switchNativeSession`, store key `splitPanes` |
| Session persistence dir per project (put the groups file here) | `lib/sessions.js:31-35` (`sessionsDir` = `~/.clay/sessions/<encoded-cwd>/`) |
| Session rename flow to copy (message + inline input UX) | `rename_session` handler `lib/project-sessions.js:796`, ctx-menu rename `lib/public/modules/sidebar-sessions.js:649-657`, `.session-rename-input` styles in `sidebar.css` |
| Session deletion hooks (dissolve groups here) | `lib/sessions.js:633` (`deleteSession`), `:676` (`deleteSessionQuiet`) — note the bulk loop at `:718` calls the quiet variant, so hook BOTH or the shared internal |
| Sidebar list rendering to extend | `lib/public/modules/sidebar-sessions.js` `renderSessionList` (sticky top, groups by date, `renderSessionItem`) |
| Session ctx menu pattern to reuse for group rows | `showSessionCtxMenu` in `sidebar-sessions.js:585+` |
| WS schema registry (add the new messages) | `lib/ws-schema.js` |
| Connect-time payload send point (send groups on connect) | `lib/project-connection.js` (the block that sends `session_list`) |
| Vendor icons for group rows | `VENDOR_AVATARS` via session list items (each session row already carries `vendor`) |
| Multi-user ownership pattern | sessions carry `ownerId`; groups do the same (creator-owned) |

---

## Implementation

### 1. Server: `lib/session-split-groups.js` (new, target < 200 lines)

`attachSplitGroups(ctx)` with `ctx = { sm, send, sendTo, usersModule, slug }`.
Persistence: one JSON file `split-groups.json` inside the project's
`sessionsDir` (obtain the path from the session manager; export a getter from
`sessions.js` if none exists rather than recomputing the encoded cwd).
Atomic write (tmp + rename), same as `saveSessionFile`
(`lib/sessions.js:120-127`).

Record shape:

```js
{ id: "sg_<ts36>_<rand>", name: "...", nameCustomized: false,
  ownerId: <creator user id or null>, members: [localId, localId],
  createdAt: <ms> }
```

Operations (all validate before mutating, all persist, all broadcast):

- `create(ws, msg)`: members must be exactly 2 distinct existing sessions the
  caller can access (`usersModule.canAccessSession` in multi-user mode); a
  session already in another group is rejected with an error result (one
  group per session, Arc semantics).
- `rename(ws, msg)`: owner-or-single-user only; trims, caps at 80 chars,
  sets `nameCustomized: true`.
- `dissolve(ws, msg)`: owner-or-single-user only; deletes the record.
- `dissolveBySession(localId)`: internal; called from session deletion (hook
  both `deleteSession` and `deleteSessionQuiet` paths in `lib/sessions.js`,
  or the shared helper they both use — read them first). Also prune invalid
  records on load (member session file gone while the daemon was down).
- `listFor(ws)`: multi-user -> only groups whose owner is the caller (keep it
  owner-private; member-visibility questions stay out of scope).

WS messages (register all in `lib/ws-schema.js`):

- c2s: `split_group_create { members: [id, id], name? }`,
  `split_group_rename { id, name }`, `split_group_dissolve { id }`
- s2c: `split_groups { groups: [...] }` — full list, sent on connect (next to
  the `session_list` send in `project-connection.js`) and after every
  mutation (per-ws filtered in multi-user mode, mirroring how session_list
  broadcasts filter).

Wire into `lib/project.js` handleMessage via one delegated call (no inline
logic, MODULE_MAP rule).

### 2. Client: store + split-view.js changes

- Store keys: `splitGroups: []`, and extend `splitPanes` with `groupId`.
- `split_groups` case in `app-messages.js` -> `store.set({ splitGroups })`.
- On drop (`openSplit`): after computing the two panes, send
  `split_group_create` with `[left.sessionId, right.sessionId]`. Open the
  split immediately (optimistic); attach `groupId` when the `split_groups`
  broadcast confirms (match by member pair).
- Clicking another session while split is open: keep the split-exit behavior
  but DO NOT dissolve (this replaces the spike's temporary rule only in that
  the group persists; the visual behavior is the same).
- Pane X: send `split_group_dissolve` for the current `groupId`, then the
  existing survivor-to-native flow.
- Opening a group: `openGroup(group)` builds panes from `group.members` in
  stored order (resolve titles from the cached session list; a missing
  member means the server will have pruned it — request nothing, just
  ignore; the next `split_groups` broadcast removes the row).

### 3. Client: sidebar rendering (`sidebar-sessions.js`)

In `renderSessionList`:

- Build `groupedSessionIds` = union of all `splitGroups` members. Skip those
  ids when rendering ordinary session rows.
- Render one `.session-item.split-group-item` row per group, positioned by
  the newest member `lastActivity` (so groups sort naturally with sessions).
  Row content: a split glyph (`iconHtml("columns-2")`),
  both members' vendor icons (13px, same dimming rules as
  `.session-vendor-icon`), the group name, summed unread badge, processing
  dot if either member `isProcessing`.
- Active state: the row is `.active` when `store.splitPanes` has its
  `groupId`.
- Click -> `openGroup`. Right-click -> group ctx menu (reuse the
  `session-ctx-menu` element pattern): **Rename** (inline input, reuse
  `.session-rename-input` styles and the commit/cancel keys of session
  rename) and **Separate** (`split_group_dissolve`; if this group's split is
  open, also exit to native on member[0]).
- Session search: a group row matches if either member matches.

CSS: a small block in `sidebar.css` (group glyph, dual vendor icons overlap
or side-by-side; keep the row height identical to session rows).

### 4. Guard rails

- One group per session (server-enforced; client also prevents offering the
  drop when the dragged or current session is already grouped — show the
  overlay disabled state or simply do not open the overlay).
- Groups are 2 members exactly in this iteration. Reject anything else
  server-side so future >2 support is a deliberate change.
- Deleting a session from the sidebar while it is in a group must visibly
  return the other member's row (server dissolve broadcast covers it; verify
  live).
- Pane-mode clients (`ws._clayPane`) never receive or need groups; do not
  send `split_groups` to them (minor traffic hygiene, not correctness).

---

## Tests (`test/split-groups.test.js`, node:test)

Factor the server module so the store logic is constructible with a fake
`sessionsDir` (tmp dir) and fake session map:

1. create: happy path persists and returns the record; rejects non-existent
   member, duplicate member, member already grouped, and 1 or 3 members.
2. rename: sets name + `nameCustomized`; rejects non-owner in multi-user
   mode; caps length.
3. dissolve: removes; idempotent second call is a no-op error.
4. dissolveBySession: removes any group containing the id.
5. load-time pruning: a groups file referencing a missing session loads
   without that group and rewrites the file.
6. Auto-name helper: truncation and the ⫿ join (pure function, exported).

Client pure helpers (auto-name composition, grouped-id set derivation) go in
a small exported section of `split-view.js` or a `split-group-helpers.js` if
size demands, tested in the same file.

---

## Acceptance (manual, record in the verification log below)

1. Drag-split two sessions -> their rows collapse into one named group row;
   reload the page -> the group row is still there; click it -> split
   reopens with the same left/right order.
2. Rename the group inline; reload; name survives. Renaming a member session
   afterwards does not overwrite the custom group name.
3. Separate from the ctx menu -> two ordinary rows return, split exits if
   open, nothing deleted.
4. Pane X -> same outcome as Separate.
5. Delete a member session -> group dissolves automatically, other member's
   row returns.
6. Clicking a third session while a split is open -> split closes, group row
   persists, clicking it reopens.
7. Restart the daemon -> groups survive (file persistence).
8. `npm test` green with the new suite; sweeps green.

---

## Verification log

### 2026-08-16 — implemented and accepted

- Dragging `Group Beta` to the right of `Group Alpha` created a persistent
  group, replaced both member rows with one `Group Alpha ⫿ Group Beta` row,
  and retained iframe order `[Alpha, Beta]`.
- Reloading left the group row collapsed; clicking it reopened the same two
  panes in stored order.
- Inline rename to `Author + Implement` survived reload. Renaming member
  `Group Alpha` to `Alpha Renamed` did not overwrite the customized group
  name. Unit coverage also verifies that non-customized names follow member
  title changes.
- Context-menu Separate restored both ordinary rows, exited an open split to
  member 0, and deleted neither session.
- Either pane-header X performed the same separation and restored the
  surviving member natively.
- Deleting one member dissolved the group automatically; the other member row
  returned and the split closed.
- Clicking `Standalone Gamma` while a split was open closed only the visual
  split. The group row persisted and reopened on click.
- Restarting the isolated daemon preserved a group backed by durable sessions.
  The row returned after reconnect and reopened iframe URLs in the stored
  `[1, 2]` order.
- Normal clients received `split_groups`; pane-mode clients did not. Browser
  console error collection was empty.
- `npm test`: 97 passed, 0 failed. Server/client `node --check` sweeps,
  `node scripts/check-client-imports.js` (85 modules), and `git diff --check`
  all passed.
