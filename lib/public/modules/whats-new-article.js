// What's New article viewer.
//
// A full-screen blog-style reader for a single What's New entry. Opened
// from either:
//   - the carousel popup ("Read more" jumps straight here)
//   - the home page list of titles (click on a title)
//
// Closing returns the user to whichever surface was visible underneath
// (home or a session). The viewer is a fixed-position overlay so we
// don't need to track or restore the previous view ourselves - hiding
// this element simply reveals the layer below.

import { getKnownEntries } from './whats-new.js';

var rootEl = null;
var dateEl = null;
var titleEl = null;
var bodyEl = null;
var backBtn = null;
var keyHandlerBound = false;
var visible = false;

export function initWhatsNewArticle() {
  rootEl = document.getElementById("whats-new-article");
  if (!rootEl) return;
  dateEl = document.getElementById("wna-date");
  titleEl = document.getElementById("wna-title");
  bodyEl = document.getElementById("wna-body");
  backBtn = document.getElementById("wna-back");

  if (backBtn) backBtn.addEventListener("click", function () { closeArticle(); });
  if (!keyHandlerBound) {
    document.addEventListener("keydown", function (ev) {
      if (visible && ev.key === "Escape") {
        ev.stopPropagation();
        closeArticle();
      }
    });
    keyHandlerBound = true;
  }
}

export function openArticle(entryId) {
  if (!rootEl) return;
  var entries = getKnownEntries();
  var entry = null;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].id === entryId) { entry = entries[i]; break; }
  }
  if (!entry) return;

  if (dateEl) dateEl.textContent = entry.publishedAt || "";
  if (titleEl) titleEl.textContent = entry.title || "";
  if (bodyEl) bodyEl.innerHTML = (typeof entry.body === "string") ? entry.body : "";

  rootEl.classList.remove("hidden");
  // Scroll to top in case a previous article was open.
  try { rootEl.scrollTop = 0; } catch (e) {}
  visible = true;
}

export function closeArticle() {
  if (!rootEl) return;
  rootEl.classList.add("hidden");
  visible = false;
}

export function isArticleVisible() {
  return visible;
}
