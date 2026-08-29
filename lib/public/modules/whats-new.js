// What's New viewer.
//
// Content-agnostic carousel popup. The server pushes an array of unseen
// entries on connect (`whats_new_state`); this module renders them as a
// single carousel that the user flips through with prev/next chevrons or
// dot indicators. Each card shows image + title + short summary + a
// "Read more" button that jumps to the home page's What's New feed for
// the detail view.
//
// Dismiss behavior:
//   - X / Esc / backdrop click closes the carousel and marks ALL queued
//     entries as seen on the server (one whats_new_seen per id).
//   - "Read more" marks the current entry seen and opens the home page
//     anchored on that entry.
//
// Adding a new entry is a server-side content change only - see
// lib/whats-new-content.js. This module should not need to be edited.

import { escapeHtml } from './utils.js';
import { getWs } from './ws-ref.js';

var entries = [];      // current carousel batch
var currentIndex = 0;
var rootEl = null;
var dismissedThisSession = {};  // ids we've already marked seen this session
var initialized = false;
var keyHandlerBound = false;
var onReadMore = null;  // injected by initWhatsNew

export function initWhatsNew(opts) {
  if (initialized) return;
  initialized = true;
  if (opts && typeof opts.onReadMore === "function") onReadMore = opts.onReadMore;
  if (!keyHandlerBound) {
    document.addEventListener("keydown", onKeyDown);
    keyHandlerBound = true;
  }
}

export function handleWhatsNewState(msg) {
  if (!msg || !Array.isArray(msg.entries) || msg.entries.length === 0) return;
  // The server sends the full entries list plus the subset of ids the
  // user hasn't dismissed yet. The home feed uses the full list (via
  // setKnownEntries in app-messages); we only auto-pop the carousel for
  // unseen ids.
  var unseenIds = Array.isArray(msg.unseenIds) ? msg.unseenIds : msg.entries.map(function (e) { return e && e.id; });
  var unseenSet = {};
  for (var u = 0; u < unseenIds.length; u++) unseenSet[unseenIds[u]] = true;

  var fresh = [];
  for (var i = 0; i < msg.entries.length; i++) {
    var e = msg.entries[i];
    if (!e || !e.id) continue;
    if (!unseenSet[e.id]) continue;
    if (dismissedThisSession[e.id]) continue;
    fresh.push(e);
  }
  if (fresh.length === 0) return;
  if (rootEl) {
    entries = entries.concat(fresh);
    renderCarousel();
    return;
  }
  entries = fresh;
  currentIndex = 0;
  openCarousel();
}

export function handleWhatsNewSeenResult(msg) {
  if (msg && msg.ok === false && window && window.console) {
    console.warn("[whats-new] mark seen failed:", msg.error);
  }
}

// Returns the most recent batch of entries (the same array the server
// last sent us). The home feed reads from this. Empty until the server
// has pushed at least once during this session.
var allKnownEntries = [];
export function getKnownEntries() {
  return allKnownEntries.slice();
}

export function setKnownEntries(list) {
  // Used by app-messages on whats_new_state to keep the home feed in sync
  // even after dismiss empties the carousel array.
  if (!Array.isArray(list)) return;
  // Merge by id, preserving order from the new list.
  var seen = {};
  var merged = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id && !seen[list[i].id]) {
      seen[list[i].id] = true;
      merged.push(list[i]);
    }
  }
  for (var j = 0; j < allKnownEntries.length; j++) {
    var k = allKnownEntries[j];
    if (k && k.id && !seen[k.id]) {
      seen[k.id] = true;
      merged.push(k);
    }
  }
  allKnownEntries = merged;
}

// ----------------------------------------------------------------------
// Render
// ----------------------------------------------------------------------

function openCarousel() {
  rootEl = document.createElement("div");
  rootEl.className = "whats-new-backdrop";
  rootEl.innerHTML =
    '<div class="whats-new-card" role="dialog" aria-modal="true">' +
      '<button type="button" class="whats-new-close" aria-label="Close">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '</button>' +
      '<div class="whats-new-image-slot"></div>' +
      '<div class="whats-new-body">' +
        '<div class="whats-new-eyebrow">What\'s new</div>' +
        '<h2 class="whats-new-title"></h2>' +
        '<p class="whats-new-summary"></p>' +
        '<button type="button" class="whats-new-read-more">' +
          'Read more' +
          ' <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -2px; margin-left: 2px;"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>' +
        '</button>' +
      '</div>' +
      '<div class="whats-new-nav">' +
        '<button type="button" class="whats-new-prev" aria-label="Previous">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>' +
        '</button>' +
        '<div class="whats-new-dots"></div>' +
        '<button type="button" class="whats-new-next" aria-label="Next">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
        '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(rootEl);

  rootEl.querySelector(".whats-new-close").addEventListener("click", function (ev) {
    ev.stopPropagation();
    closeAndMarkSeen();
  });
  rootEl.querySelector(".whats-new-prev").addEventListener("click", function (ev) {
    ev.stopPropagation();
    go(-1);
  });
  rootEl.querySelector(".whats-new-next").addEventListener("click", function (ev) {
    ev.stopPropagation();
    go(1);
  });
  rootEl.querySelector(".whats-new-read-more").addEventListener("click", function (ev) {
    ev.stopPropagation();
    readMoreCurrent();
  });
  rootEl.addEventListener("click", function (ev) {
    if (ev.target === rootEl) closeAndMarkSeen();
  });

  renderCarousel();
  requestAnimationFrame(function () {
    if (rootEl) rootEl.classList.add("show");
  });
}

function renderCarousel() {
  if (!rootEl || entries.length === 0) return;
  if (currentIndex < 0) currentIndex = 0;
  if (currentIndex >= entries.length) currentIndex = entries.length - 1;
  var entry = entries[currentIndex];

  var imgSlot = rootEl.querySelector(".whats-new-image-slot");
  if (entry.image) {
    imgSlot.innerHTML = '<img src="' + escapeHtml(entry.image) + '" alt="">';
    imgSlot.classList.remove("empty");
  } else {
    imgSlot.innerHTML = '';
    imgSlot.classList.add("empty");
  }

  rootEl.querySelector(".whats-new-title").textContent = entry.title || "What's new";
  rootEl.querySelector(".whats-new-summary").textContent = entry.summary || "";

  var dotsEl = rootEl.querySelector(".whats-new-dots");
  var navEl = rootEl.querySelector(".whats-new-nav");
  if (entries.length <= 1) {
    navEl.classList.add("hidden");
  } else {
    navEl.classList.remove("hidden");
    dotsEl.innerHTML = "";
    for (var i = 0; i < entries.length; i++) {
      var dot = document.createElement("button");
      dot.type = "button";
      dot.className = "whats-new-dot" + (i === currentIndex ? " active" : "");
      dot.setAttribute("aria-label", "Go to slide " + (i + 1));
      (function (idx) {
        dot.addEventListener("click", function (ev) {
          ev.stopPropagation();
          currentIndex = idx;
          renderCarousel();
        });
      })(i);
      dotsEl.appendChild(dot);
    }
    rootEl.querySelector(".whats-new-prev").disabled = (currentIndex === 0);
    rootEl.querySelector(".whats-new-next").disabled = (currentIndex === entries.length - 1);
  }
}

function go(delta) {
  if (entries.length === 0) return;
  currentIndex = Math.max(0, Math.min(entries.length - 1, currentIndex + delta));
  renderCarousel();
}

function readMoreCurrent() {
  var entry = entries[currentIndex];
  if (!entry) return;
  // Mark this one seen on the server and hand off to the article viewer
  // via onReadMore. We don't mark the others seen - user might still
  // want to see them as cards on a future connect.
  markSeen(entry.id);
  var id = entry.id;
  closeCarousel();
  if (typeof onReadMore === "function") {
    try { onReadMore(id); } catch (e) {}
  }
}

function closeAndMarkSeen() {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].id) markSeen(entries[i].id);
  }
  closeCarousel();
}

function closeCarousel() {
  if (rootEl) {
    rootEl.remove();
    rootEl = null;
  }
  entries = [];
  currentIndex = 0;
}

function markSeen(id) {
  if (!id || dismissedThisSession[id]) return;
  dismissedThisSession[id] = true;
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ type: "whats_new_seen", id: id })); } catch (e) {}
  }
}

function onKeyDown(ev) {
  if (!rootEl) return;
  if (ev.key === "Escape") {
    closeAndMarkSeen();
  } else if (ev.key === "ArrowLeft") {
    go(-1);
  } else if (ev.key === "ArrowRight") {
    go(1);
  }
}
