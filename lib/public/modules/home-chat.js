// Clay FAB + popover chat — phablet-style, persistent across the app.
// Self-contained: own DOM, own renderer, own WS protocol (home_clay_*).
// Does not interfere with the active project session.

import { escapeHtml } from './utils.js';
import { getWs } from './ws-ref.js';
import { renderMarkdown } from './markdown.js';
import { switchProject } from './app-projects.js';

var initialized = false;
var openState = false;
var fabBtn = null;
var popoverEl = null;
var messagesEl = null;
var inputEl = null;
var sendBtn = null;
var typingEl = null;
var newBtnEl = null;
var closeBtnEl = null;

// Drag state for the FAB.
var FAB_POS_KEY = "clay-fab-pos";
var DRAG_THRESHOLD_PX = 5;
var dragState = null;

// Per-turn assembly state. Server may emit many delta events for a single
// assistant turn; we accumulate text and render incrementally into the
// last bubble.
var currentAssistantBubble = null;
var currentAssistantText = "";
var openedOnce = false;  // gate the initial home_clay_open request

export function initHomeChat() {
  if (initialized) return;
  initialized = true;

  fabBtn = document.getElementById("clay-fab");
  popoverEl = document.getElementById("clay-popover");
  messagesEl = document.getElementById("home-chat-messages");
  inputEl = document.getElementById("home-chat-input");
  sendBtn = document.getElementById("home-chat-send-btn");
  typingEl = document.getElementById("home-chat-typing");
  newBtnEl = document.getElementById("home-chat-new-btn");
  closeBtnEl = document.getElementById("home-chat-close-btn");

  if (!fabBtn || !popoverEl || !messagesEl || !inputEl || !sendBtn) return;

  // --- Restore persisted FAB position ---
  restoreFabPosition();
  // Re-clamp on viewport resize so a saved position from a wider window
  // doesn't strand the FAB off-screen.
  window.addEventListener("resize", function () {
    if (fabBtn.classList.contains("user-positioned")) clampFabIntoView();
  });

  // --- FAB drag + click ---
  // mousedown/touchstart begins a potential drag. We only treat it as a
  // click (toggle popover) if the pointer didn't move past DRAG_THRESHOLD_PX.
  fabBtn.addEventListener("mousedown", onPointerDown);
  fabBtn.addEventListener("touchstart", onPointerDown, { passive: false });

  if (closeBtnEl) closeBtnEl.addEventListener("click", closePopover);

  // ESC closes the popover.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openState) {
      closePopover();
    }
  });

  // --- Input handling ---
  inputEl.addEventListener("input", function () {
    autoResize();
    sendBtn.disabled = inputEl.value.trim().length === 0;
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.addEventListener("click", doSend);
  if (newBtnEl) {
    newBtnEl.addEventListener("click", function () {
      var ws = getWs();
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "home_clay_new_session" }));
      messagesEl.innerHTML = "";
      currentAssistantBubble = null;
      currentAssistantText = "";
      hideTyping();
      addSystemBubble("New conversation started.");
    });
  }
}

// --- FAB drag mechanics ---

function getPointer(e) {
  if (e.touches && e.touches.length > 0) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

function onPointerDown(e) {
  // Ignore right-clicks and modifier-clicks.
  if (e.button && e.button !== 0) return;
  var p = getPointer(e);
  var rect = fabBtn.getBoundingClientRect();
  dragState = {
    startX: p.x,
    startY: p.y,
    offsetX: p.x - rect.left,
    offsetY: p.y - rect.top,
    moved: false,
  };
  document.addEventListener("mousemove", onPointerMove);
  document.addEventListener("mouseup", onPointerUp);
  document.addEventListener("touchmove", onPointerMove, { passive: false });
  document.addEventListener("touchend", onPointerUp);
  document.addEventListener("touchcancel", onPointerUp);
  // Don't preventDefault yet — we let the browser distinguish between a
  // tap (which should fire click → toggle) and a drag.
}

function onPointerMove(e) {
  if (!dragState) return;
  var p = getPointer(e);
  var dx = p.x - dragState.startX;
  var dy = p.y - dragState.startY;
  if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) {
    return;
  }
  dragState.moved = true;
  fabBtn.classList.add("dragging");
  // Touch needs explicit prevent so the page doesn't scroll.
  if (e.cancelable) e.preventDefault();
  var x = p.x - dragState.offsetX;
  var y = p.y - dragState.offsetY;
  setFabPosition(x, y);
}

function onPointerUp() {
  document.removeEventListener("mousemove", onPointerMove);
  document.removeEventListener("mouseup", onPointerUp);
  document.removeEventListener("touchmove", onPointerMove);
  document.removeEventListener("touchend", onPointerUp);
  document.removeEventListener("touchcancel", onPointerUp);
  if (!dragState) return;
  if (dragState.moved) {
    fabBtn.classList.remove("dragging");
    persistFabPosition();
    clampFabIntoView();
  } else {
    // Pure tap → toggle popover.
    toggleOpen();
  }
  dragState = null;
}

function setFabPosition(x, y) {
  // Ensure the FAB stays within the viewport with a small margin.
  var margin = 4;
  var w = fabBtn.offsetWidth;
  var h = fabBtn.offsetHeight;
  var maxX = window.innerWidth - w - margin;
  var maxY = window.innerHeight - h - margin;
  if (x < margin) x = margin;
  if (y < margin) y = margin;
  if (x > maxX) x = maxX;
  if (y > maxY) y = maxY;
  fabBtn.classList.add("user-positioned");
  fabBtn.style.left = x + "px";
  fabBtn.style.top = y + "px";
  fabBtn.style.right = "auto";
  fabBtn.style.bottom = "auto";
  // If the popover is open, keep it anchored to the FAB.
  if (openState) anchorPopoverToFab();
}

function clampFabIntoView() {
  if (!fabBtn) return;
  var rect = fabBtn.getBoundingClientRect();
  setFabPosition(rect.left, rect.top);
}

function persistFabPosition() {
  if (!fabBtn) return;
  try {
    var rect = fabBtn.getBoundingClientRect();
    localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
  } catch (e) {}
}

function restoreFabPosition() {
  try {
    var raw = localStorage.getItem(FAB_POS_KEY);
    if (!raw) return;
    var pos = JSON.parse(raw);
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      setFabPosition(pos.x, pos.y);
    }
  } catch (e) {}
}

// Anchor the popover so its corner sits next to the FAB. We pick the
// corner that gives the most room — popover opens "into" the screen,
// not off-screen.
function anchorPopoverToFab() {
  if (!fabBtn || !popoverEl) return;
  var fr = fabBtn.getBoundingClientRect();
  var pw = popoverEl.offsetWidth || 320;
  var ph = popoverEl.offsetHeight || 480;
  var margin = 12;
  // Decide vertical: open above FAB if there's more room above.
  var roomAbove = fr.top;
  var roomBelow = window.innerHeight - fr.bottom;
  var openUp = roomAbove >= roomBelow;
  // Decide horizontal: align right edge of popover with right edge of FAB
  // when the FAB is on the right half of the screen, else left edge.
  var fabRightSide = (fr.left + fr.width / 2) > window.innerWidth / 2;

  var top, left;
  if (openUp) {
    top = Math.max(margin, fr.top - ph - 8);
    popoverEl.style.transformOrigin = fabRightSide ? "bottom right" : "bottom left";
  } else {
    top = Math.min(window.innerHeight - ph - margin, fr.bottom + 8);
    popoverEl.style.transformOrigin = fabRightSide ? "top right" : "top left";
  }
  if (fabRightSide) {
    left = Math.max(margin, fr.right - pw);
  } else {
    left = Math.min(window.innerWidth - pw - margin, fr.left);
  }
  popoverEl.style.top = top + "px";
  popoverEl.style.left = left + "px";
  popoverEl.style.right = "auto";
  popoverEl.style.bottom = "auto";
}

function openPopover() {
  if (!popoverEl || openState) return;
  openState = true;
  // Anchor BEFORE unhiding so the slide-up animation uses the correct
  // transform-origin (top vs bottom, left vs right) for the FAB's
  // current corner.
  anchorPopoverToFab();
  popoverEl.classList.remove("hidden");
  if (fabBtn) fabBtn.classList.add("open");
  // Pull session history on first open. If WS isn't ready yet, leave
  // openedOnce false so the next open retries.
  if (!openedOnce) {
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      openedOnce = true;
      requestSession();
    } else {
      addSystemBubble("Connecting…");
    }
  }
  // Focus the input so the user can start typing immediately.
  setTimeout(function () { if (inputEl) inputEl.focus(); }, 60);
}

function closePopover() {
  if (!openState) return;
  openState = false;
  if (popoverEl) popoverEl.classList.add("hidden");
  if (fabBtn) {
    fabBtn.classList.remove("open");
    fabBtn.focus();
  }
}

function toggleOpen() {
  if (openState) closePopover(); else openPopover();
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(120, inputEl.scrollHeight) + "px";
}

function requestSession() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "home_clay_open" }));
}

function doSend() {
  var text = inputEl.value.trim();
  if (!text) return;
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;

  // Optimistic render of the user's message.
  addUserBubble(text);
  inputEl.value = "";
  autoResize();
  sendBtn.disabled = true;

  ws.send(JSON.stringify({ type: "home_clay_send", text: text }));
  showTyping();
}

// --- Rendering ---

function addUserBubble(text) {
  finalizeAssistant();
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-user";
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
}

function ensureAssistantBubble() {
  if (currentAssistantBubble) return currentAssistantBubble;
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-clay";
  messagesEl.appendChild(bubble);
  currentAssistantBubble = bubble;
  currentAssistantText = "";
  return bubble;
}

function appendAssistantText(text) {
  var bubble = ensureAssistantBubble();
  currentAssistantText += text;
  bubble.innerHTML = linkifyRefs(renderMarkdown(currentAssistantText));
  scrollToBottom();
}

function finalizeAssistant() {
  if (currentAssistantBubble && !currentAssistantText) {
    currentAssistantBubble.remove();
  }
  currentAssistantBubble = null;
  currentAssistantText = "";
}

function addSystemBubble(text) {
  var bubble = document.createElement("div");
  bubble.className = "home-chat-bubble home-chat-bubble-system";
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
}

function linkifyRefs(html) {
  // Match [slug/sess_id - date]. Conservative: slug is alphanumeric/-/_,
  // sess id starts with sess_.
  var re = /\[([a-zA-Z0-9_\-]+)\/(sess_[a-zA-Z0-9_\-]+)(?:\s+[—-]\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\]/g;
  return html.replace(re, function (_full, slug, sessId, date) {
    var label = slug + "/" + sessId.substring(0, 14) + (date ? " · " + date : "");
    return '<span class="home-chat-ref" data-slug="' + escapeHtml(slug) + '" data-session="' + escapeHtml(sessId) + '">' + escapeHtml(label) + '</span>';
  });
}

function scrollToBottom() {
  if (!messagesEl) return;
  requestAnimationFrame(function () {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function showTyping() { if (typingEl) typingEl.classList.remove("hidden"); }
function hideTyping() { if (typingEl) typingEl.classList.add("hidden"); }

// --- Server message handlers (called from app-messages.js dispatcher) ---

export function handleHomeClayHistory(msg) {
  if (!messagesEl) return;
  messagesEl.innerHTML = "";
  currentAssistantBubble = null;
  currentAssistantText = "";
  hideTyping();
  var entries = msg.messages || [];
  if (entries.length === 0) {
    addSystemBubble("Hi — I'm Clay. I can search every session, project, and decision in your workspace. What are you trying to find?");
    return;
  }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.role === "user") {
      addUserBubble(e.text || "");
    } else if (e.role === "assistant") {
      appendAssistantText(e.text || "");
      finalizeAssistant();
    }
  }
}

export function handleHomeClayDelta(msg) {
  hideTyping();
  if (typeof msg.text === "string") appendAssistantText(msg.text);
}

export function handleHomeClayDone() {
  hideTyping();
  finalizeAssistant();
}

export function handleHomeClayError(msg) {
  hideTyping();
  finalizeAssistant();
  addSystemBubble("Error: " + (msg.text || "unknown"));
}

// --- Click delegation for session ref chips ---

document.addEventListener("click", function (e) {
  var chip = e.target && e.target.closest && e.target.closest(".home-chat-ref");
  if (!chip) return;
  var slug = chip.dataset.slug;
  if (!slug) return;
  closePopover();
  if (typeof switchProject === "function") {
    switchProject(slug);
  }
});

// --- Initialize on DOM ready ---
// FAB chat is currently disabled. The DOM markup (#clay-fab, #clay-popover)
// has been removed from index.html, so initHomeChat() would return early
// anyway, but we skip the auto-init outright to make the disable explicit.
// To re-enable: restore the markup in index.html, the CSS import in
// style.css, and uncomment the block below.
//
// if (typeof document !== "undefined") {
//   if (document.readyState === "loading") {
//     document.addEventListener("DOMContentLoaded", initHomeChat);
//   } else {
//     initHomeChat();
//   }
// }
