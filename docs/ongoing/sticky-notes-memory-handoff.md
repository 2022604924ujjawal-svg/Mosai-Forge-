# Sticky notes as agent-controllable handoff memory

**Goal (Chad, 2026-08-17):** sessions can read and write the project's
sticky notes, turning the existing shared canvas into visible handoff
memory. People may use the board freely; Clay agents use it specifically
for cross-session work memory: checklists and to-do lists, work goals,
handoffs, unfinished work, durable decisions and constraints, and
knowledge worth preserving beyond the current session. Notes are
title-first, may contain detailed multi-paragraph context, and should
let another worker continue without reconstructing the previous
conversation. The user always sees what the agent remembers, can edit
or delete it, and every vendor gets the same memory because injection
is plain text.

## Why sticky notes beat a hidden memory file

- Visible: memory lives on a canvas the user already watches; an agent
  writing a note is immediately observable (nm broadcasts keep every
  client live).
- Editable: the user can correct or delete a wrong memory directly, no
  tooling needed.
- Cross-vendor: injection is text, so claude/codex/kiro all share the
  same memory without vendor work.
- Fable-class models measurably improve with a memory surface they are
  told to consult and maintain.

## Existing plumbing (verified 2026-08-17)

- `lib/notes.js` createNotesManager: `list/create/update/remove/
  bringToFront/getActiveNotesText`, per-project persistence, broadcast
  on every mutation. Wired in project.js:810 (`nm`).
- Client canvas: `lib/public/modules/sticky-notes.js` (recently
  stabilized, split view shares one canvas above both panes).
- A knowledge sync of `getActiveNotesText()` already exists for mate
  contexts (project.js:1725-1737).
- Session-bound MCP mounting pattern: project-session-spawn/pair.

## Design

### 1. MCP tools (`clay-notes`, mounted on project sessions)

- `list_notes` -> `[{id, text, color, updatedAt, origin}]`. Auto-allowed
  (read-only).
- `write_note` -> `{id?, text, color?}`; no id creates, id updates.
  Auto-allowed: the write is immediately visible on the shared canvas,
  which IS the oversight. Agent-created notes get
  `origin: {sessionId, vendor}` and auto-placement (cascade offset from
  the last note; never on top of an existing one).
- `remove_note` -> `{id}`. Auto-allowed ONLY for notes whose origin is
  the calling session; removing a user-created note (or another
  session's) keeps the permission prompt -- deleting someone else's
  memory is destructive.
- Tool descriptions frame the memory contract as handoff-first. The
  first line is a concise title; the remaining body may be long and
  should preserve the goal, background, rationale, decisions, completed
  work, current state, validation, next steps, blockers, and references
  when those details prevent context loss. Quality is controlled by
  prohibiting routine narration and duplicate notes, not by forcing
  artificial brevity.

### 2. Injection (the recall half)

- On every query start, inject active notes as a bounded context block
  via the existing vendor-neutral instruction path (same family as
  instructions.scanAndMerge / appendSystemPrompt from a726fbc):
  `"--- Project sticky notes (shared memory; manage via clay-notes
  tools) ---"` + `getActiveNotesText()`.
- Caps: 4000 chars total and 800 chars per note, newest-first truncation
  with a marker telling the model to use list_notes for the full note.
  The policy explicitly requires reading a relevant truncated handoff
  before acting. Full board content remains available through
  list_notes without truncation.
- This makes recall automatic; the agent does not need to remember to
  look.

### 3. UI (small)

- Agent-created notes render a small vendor avatar badge (origin) in
  the note corner, mirroring the delegated-message pattern.
- The first line renders as the note title. Checklist lines accept both
  `[x]` / `[ ]` and `- [x]` / `- [ ]`; rendered boxes are keyboard- and
  pointer-toggleable and persist back to Markdown.
- The empty archive explains the value in user terms: notes survive the
  current session and are useful for checklists, goals, handoffs, and
  durable project knowledge. This is guidance, not a restriction on how
  people use their board.
- The rest of the canvas remains the existing shared surface.

## Rails

- REVISED (Chad, 2026-08-17): no short hard cap -- the canvas has a
  collapse affordance, so long handoff notes are encouraged when they
  preserve worker context. Keep only a generous abuse guard:
  write_note rejects past 20000 chars.
- Context cost is contained at injection instead: each note contributes
  at most 800 chars and the total note block stays capped at 4000 chars.
- Note count cap (20 active) -- write_note errors past it, prompting
  consolidation/cleanup instead of unbounded growth.
- remove_note ownership rule above.
- Injection is capped and clearly labeled so prompts stay auditable.

## Proactive use (Chad, 2026-08-17: "적극적으로, 하지만 남용 없이")

The goal is that users NOTICE the board being useful without being
spammed by it.

- Inject the policy block on EVERY query, even with zero notes (an
  empty board must still announce the capability, otherwise the agent
  never volunteers). Zero-note form: label + "(board is empty)" +
  policy text.
- Policy text defines the board as shared cross-session work memory and
  limits Clay-agent writes to checklists and to-dos, work goals,
  handoffs, unfinished work, durable decisions and constraints, and
  knowledge worth preserving beyond the current session. It requires a
  title on the first line, welcomes detailed bodies, and tells the next
  worker to call list_notes before acting on a relevant truncated
  preview. Transcripts, routine progress narration, self-announcements,
  and duplicate notes remain forbidden. Human use remains unrestricted.
- Noticeability: on an agent write, the server broadcasts
  `note_written {id, byTitle, vendor, preview}` (register in
  ws-schema); non-pane clients toast "<title> left a note: <preview>"
  and pulse the note on the canvas. User's own edits never toast.
- Abuse ceiling stays structural: 20 active notes, 20000-char guard,
  ownership rule.

## Out of scope (v1)

- Per-note "include in context" toggles (all active notes inject, cap
  applies).
- Cross-project notes.
- Mate sessions (isMate skips the server, same as clay-sessions).

## Tests

- notes tool handlers against a stubbed nm: create/update/remove,
  ownership rule on remove, size/count caps.
- Injection: cap truncation, empty-notes no-op, label format.

## Acceptance (live, daemon restart)

1. Ask a session to "remember X on the board" -> note appears on the
   canvas with the session's vendor badge, no permission prompt.
2. New session (any vendor) asked "what do you remember?" answers from
   the injected notes without calling tools.
3. Agent updates its own note without a prompt; asking it to delete a
   user-created note triggers the permission prompt.
4. Notes survive daemon restart (existing nm persistence).
