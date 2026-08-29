var followedPath = null;
var suppressedForTurn = false;
var cleanupTimer = null;
var tourTimer = null;
var statusTimer = null;
var followExpiryTimer = null;
var sawChange = false;
var tourVersion = 0;
var touring = false;
var tourViewer = null;

function normalizedPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

export function isMarkdownPath(filePath) {
  return /\.mdx?$/i.test(normalizedPath(filePath));
}

export function markdownPathFromToolInput(input) {
  if (!input || typeof input !== "object") return null;
  if (isMarkdownPath(input.file_path)) return input.file_path;
  var paths = Array.isArray(input.file_paths) ? input.file_paths : [];
  for (var i = 0; i < paths.length; i++) {
    if (isMarkdownPath(paths[i])) return paths[i];
  }
  return null;
}

export function pathsMatch(left, right) {
  var a = normalizedPath(left);
  var b = normalizedPath(right);
  if (!a || !b) return false;
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}

function statusElement() {
  return document.getElementById("file-viewer-live-status");
}

function setStatus(state, label) {
  var el = statusElement();
  if (!el) return;
  clearTimeout(statusTimer);
  el.classList.remove("hidden", "editing", "updated");
  el.classList.add(state);
  var labelEl = el.querySelector(".file-viewer-live-label");
  if (labelEl) labelEl.textContent = label;
}

function hideStatusSoon() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(function () {
    var el = statusElement();
    if (el) el.classList.add("hidden");
  }, 1800);
}

export function beginMarkdownTurn() {
  stopChangeTour();
  clearTimeout(cleanupTimer);
  clearLiveClasses();
  suppressedForTurn = false;
  followedPath = null;
  sawChange = false;
  clearTimeout(followExpiryTimer);
  clearTimeout(statusTimer);
  var el = statusElement();
  if (el) el.classList.add("hidden");
}

export function beginMarkdownPresentation(filePath) {
  if (suppressedForTurn || !isMarkdownPath(filePath)) return false;
  clearTimeout(followExpiryTimer);
  if (!pathsMatch(followedPath, filePath)) sawChange = false;
  followedPath = normalizedPath(filePath);
  setStatus("editing", "Editing");
  return true;
}

export function isFollowingMarkdown(filePath) {
  return !suppressedForTurn && pathsMatch(followedPath, filePath);
}

export function cancelMarkdownFollow() {
  followedPath = null;
  suppressedForTurn = true;
  clearTimeout(cleanupTimer);
  stopChangeTour();
  clearTimeout(statusTimer);
  clearTimeout(followExpiryTimer);
  var status = statusElement();
  if (status) status.classList.add("hidden");
  clearLiveClasses();
}

export function finishMarkdownTurn() {
  if (!followedPath || suppressedForTurn) return;
  if (sawChange && !touring) {
    setStatus("updated", "Updated");
    hideStatusSoon();
  } else {
    var el = statusElement();
    if (el) el.classList.add("hidden");
  }
  clearTimeout(followExpiryTimer);
  followExpiryTimer = setTimeout(function () { followedPath = null; }, 4000);
}

function blockSignature(node) {
  return node.outerHTML.replace(/\s+/g, " ").trim();
}

export function diffBlockSignatures(oldSignatures, newSignatures) {
  var oldLength = oldSignatures.length;
  var newLength = newSignatures.length;
  var rows = new Array(oldLength + 1);
  var i;
  var j;
  for (i = 0; i <= oldLength; i++) rows[i] = new Uint32Array(newLength + 1);

  for (i = oldLength - 1; i >= 0; i--) {
    for (j = newLength - 1; j >= 0; j--) {
      rows[i][j] = oldSignatures[i] === newSignatures[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  var matches = [];
  i = 0;
  j = 0;
  while (i < oldLength && j < newLength) {
    if (oldSignatures[i] === newSignatures[j]) {
      matches.push({ oldIndex: i, newIndex: j });
      i++;
      j++;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

function clearLiveClasses() {
  var viewer = document.getElementById("file-viewer-body");
  if (!viewer) return;
  var removed = viewer.querySelectorAll(".markdown-live-removed");
  for (var i = 0; i < removed.length; i++) removed[i].remove();
  var active = viewer.querySelectorAll(".markdown-live-added, .markdown-live-changed, .markdown-live-focus, .markdown-live-seen");
  for (var j = 0; j < active.length; j++) {
    active[j].classList.remove("markdown-live-added", "markdown-live-changed", "markdown-live-focus", "markdown-live-seen");
  }
}

function detachTourInterruption() {
  if (tourViewer) {
    tourViewer.removeEventListener("wheel", interruptChangeTour);
    tourViewer.removeEventListener("pointerdown", interruptChangeTour);
    tourViewer.removeEventListener("touchstart", interruptChangeTour);
  }
  document.removeEventListener("keydown", interruptChangeTour);
  tourViewer = null;
}

function stopChangeTour() {
  tourVersion++;
  touring = false;
  clearTimeout(tourTimer);
  detachTourInterruption();
  var focused = document.querySelectorAll(".markdown-live-focus");
  for (var i = 0; i < focused.length; i++) focused[i].classList.remove("markdown-live-focus");
}

function interruptChangeTour() {
  if (!touring) return;
  stopChangeTour();
  setStatus("updated", "Updated");
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(function () {
    clearLiveClasses();
    hideStatusSoon();
  }, 1800);
}

function attachTourInterruption(viewer) {
  tourViewer = viewer;
  viewer.addEventListener("wheel", interruptChangeTour, { passive: true });
  viewer.addEventListener("pointerdown", interruptChangeTour);
  viewer.addEventListener("touchstart", interruptChangeTour, { passive: true });
  document.addEventListener("keydown", interruptChangeTour);
}

export function changeTourDelay(text) {
  var length = String(text || "").trim().length;
  return Math.min(1800, Math.max(850, 700 + length * 3));
}

function startChangeTour(viewer, targets) {
  stopChangeTour();
  touring = true;
  attachTourInterruption(viewer);
  var version = tourVersion;
  var index = 0;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function visitNext() {
    if (!touring || version !== tourVersion) return;
    if (index >= targets.length) {
      var last = targets[targets.length - 1];
      if (last && last.isConnected) {
        last.classList.remove("markdown-live-focus");
        last.classList.add("markdown-live-seen");
      }
      touring = false;
      detachTourInterruption();
      setStatus("updated", "Updated");
      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(function () {
        clearLiveClasses();
        hideStatusSoon();
      }, 1400);
      return;
    }

    var previous = index > 0 ? targets[index - 1] : null;
    if (previous && previous.isConnected) {
      previous.classList.remove("markdown-live-focus");
      previous.classList.add("markdown-live-seen");
    }
    var target = targets[index];
    index++;
    if (!target || !target.isConnected) {
      visitNext();
      return;
    }
    target.classList.add("markdown-live-focus");
    setStatus("editing", "Change " + index + " of " + targets.length);
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    tourTimer = setTimeout(visitNext, reduceMotion ? 250 : changeTourDelay(target.textContent));
  }

  requestAnimationFrame(visitNext);
}

function changedRegionStart(matches, oldIndex) {
  var newIndex = 0;
  for (var i = 0; i < matches.length; i++) {
    if (matches[i].oldIndex >= oldIndex) break;
    newIndex = matches[i].newIndex + 1;
  }
  return newIndex;
}

export function animateMarkdownChange(markdownEl, oldMarkdown, newMarkdown, renderFn) {
  if (!markdownEl || oldMarkdown === newMarkdown) return false;
  clearLiveClasses();

  var oldRoot = document.createElement("div");
  var newRoot = document.createElement("div");
  oldRoot.innerHTML = renderFn(oldMarkdown);
  newRoot.innerHTML = renderFn(newMarkdown);

  var oldBlocks = Array.from(oldRoot.children);
  var newBlocks = Array.from(newRoot.children);
  var liveBlocks = Array.from(markdownEl.children);
  var oldSignatures = oldBlocks.map(blockSignature);
  var newSignatures = newBlocks.map(blockSignature);
  var matches = diffBlockSignatures(oldSignatures, newSignatures);
  var matchedOld = new Set(matches.map(function (match) { return match.oldIndex; }));
  var matchedNew = new Set(matches.map(function (match) { return match.newIndex; }));
  for (var i = 0; i < liveBlocks.length; i++) {
    if (matchedNew.has(i)) continue;
    liveBlocks[i].classList.add("markdown-live-added");
  }

  for (var j = 0; j < oldBlocks.length; j++) {
    if (matchedOld.has(j)) continue;
    var clone = oldBlocks[j].cloneNode(true);
    clone.classList.add("markdown-live-removed");
    clone.setAttribute("aria-hidden", "true");
    var insertionIndex = changedRegionStart(matches, j);
    var anchor = insertionIndex < liveBlocks.length ? liveBlocks[insertionIndex] : null;
    markdownEl.insertBefore(clone, anchor);
  }

  var changedTargets = Array.from(markdownEl.children).filter(function (element) {
    return element.classList.contains("markdown-live-added") || element.classList.contains("markdown-live-removed");
  });
  if (changedTargets.length === 0) return false;
  sawChange = true;
  var hasRemoved = oldBlocks.length !== matchedOld.size;
  var hasAdded = newBlocks.length !== matchedNew.size;
  if (hasRemoved && hasAdded) {
    for (var k = 0; k < liveBlocks.length; k++) {
      if (!matchedNew.has(k)) liveBlocks[k].classList.add("markdown-live-changed");
    }
  }

  clearTimeout(cleanupTimer);
  startChangeTour(document.getElementById("file-viewer-body"), changedTargets);
  return true;
}
