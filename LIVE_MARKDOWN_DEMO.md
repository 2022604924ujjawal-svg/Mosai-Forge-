# Live Markdown Editing

This document demonstrates how Clay makes agent-driven writing visible as the work happens. Rather than hiding the transition behind a refresh, Clay keeps the reader oriented within the document.

## Why this matters

A document should not silently jump from one finished state to another. When an agent changes the text, the reader should be able to follow the work and understand what moved.

## Current workflow

1. The user explicitly asks Clay to create or revise a document.
2. Clay opens the Markdown file directly in rendered mode.
3. Removed and added blocks remain visible long enough to understand the revision.
4. Clay moves through every changed location in document order.
5. The final document settles into a clean reading view when the tour ends.

## A quiet default

Markdown files changed incidentally during coding work stay in the background. The live document view is reserved for requests where writing is the primary task.

That distinction keeps ordinary coding sessions calm while making deliberate writing sessions unusually clear.

## What the reader sees

The document stays readable throughout the revision. Each change is surfaced in context, so it is easy to review the new wording, understand the intent, and step in whenever a different direction is needed.

## Closing thought

Transparency should feel calm: visible when it helps, quiet when it does not, and always interruptible by the person watching.
