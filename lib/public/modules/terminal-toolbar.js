// terminal-toolbar.js
//
// Reusable mobile control-key bar (Tab / Ctrl / Esc / arrows / Alt / pipe /
// slash / tilde) for any xterm-backed terminal. Soft keyboards lack these
// keys, so both the bottom-panel shell (terminal.js) and the embedded TUI
// session view (session-tui-view.js) mount this bar on touch devices.
//
// The caller owns the toolbar element and how bytes reach its terminal; this
// module owns the key sequences, the sticky Ctrl/Alt modifiers, and applying
// Ctrl to a soft-keyboard letter via xterm's custom key handler.

export var TERMINAL_TOOLBAR_HTML =
  '<button class="term-key" data-key="tab">Tab</button>' +
  '<button class="term-key term-key-toggle" data-key="ctrl">Ctrl</button>' +
  '<button class="term-key" data-key="esc">Esc</button>' +
  '<span class="term-key-spacer"></span>' +
  '<button class="term-key term-key-arrow" data-key="up">&#9650;</button>' +
  '<button class="term-key term-key-arrow" data-key="down">&#9660;</button>' +
  '<button class="term-key term-key-arrow" data-key="left">&#9664;</button>' +
  '<button class="term-key term-key-arrow" data-key="right">&#9654;</button>' +
  '<span class="term-key-spacer"></span>' +
  '<button class="term-key term-key-toggle" data-key="alt">Alt</button>' +
  '<button class="term-key" data-key="pipe">|</button>' +
  '<button class="term-key" data-key="slash">/</button>' +
  '<button class="term-key" data-key="tilde">~</button>';

var KEY_MAP = {
  tab: "\t",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pipe: "|",
  slash: "/",
  tilde: "~",
};

// Wire a toolbar element to a terminal.
//   opts.toolbar : the container element holding the .term-key buttons.
//   opts.send    : function(data) that writes the bytes to the live PTY.
// Returns { bindXterm(xterm), reset() }:
//   bindXterm - (re)attach the Ctrl-letter handler to the active xterm; call
//               whenever the active terminal changes.
//   reset     - clear sticky Ctrl/Alt state (call when hiding the bar).
export function createKeyToolbar(opts) {
  var toolbar = opts && opts.toolbar;
  var send = opts && opts.send;
  if (!toolbar || typeof send !== "function") return { bindXterm: function () {}, reset: function () {} };

  var ctrlActive = false;
  var altActive = false;

  function clearModifier(key) {
    var btn = toolbar.querySelector("[data-key='" + key + "']");
    if (btn) btn.classList.remove("active");
  }
  function reset() {
    ctrlActive = false;
    altActive = false;
    clearModifier("ctrl");
    clearModifier("alt");
  }

  // Bind the click handler once.
  if (!toolbar._keyToolbarBound) {
    toolbar._keyToolbarBound = true;
    // Keep focus on the terminal so the soft keyboard doesn't dismiss.
    toolbar.addEventListener("mousedown", function (e) { e.preventDefault(); });
    toolbar.addEventListener("click", function (e) {
      var btn = e.target.closest(".term-key");
      if (!btn) return;
      var key = btn.dataset.key;
      if (!key) return;

      if (key === "ctrl") {
        ctrlActive = !ctrlActive;
        btn.classList.toggle("active", ctrlActive);
        return;
      }
      if (key === "alt") {
        altActive = !altActive;
        btn.classList.toggle("active", altActive);
        return;
      }

      var seq = KEY_MAP[key];
      if (!seq) return;
      if (altActive) {
        seq = "\x1b" + seq;
        altActive = false;
        clearModifier("alt");
      }
      send(seq);
      if (ctrlActive) {
        ctrlActive = false;
        clearModifier("ctrl");
      }
    });
  }

  return {
    bindXterm: function (xterm) {
      if (!xterm || typeof xterm.attachCustomKeyEventHandler !== "function") return;
      xterm.attachCustomKeyEventHandler(function (ev) {
        if (ctrlActive && ev.type === "keydown" && ev.key && ev.key.length === 1) {
          var charCode = ev.key.toUpperCase().charCodeAt(0);
          if (charCode >= 65 && charCode <= 90) {
            send(String.fromCharCode(charCode - 64));
            ctrlActive = false;
            clearModifier("ctrl");
            return false;
          }
        }
        return true;
      });
    },
    // If Ctrl is armed, disarm it and return true. Lets a separate input
    // surface (e.g. the mobile TUI entry bar, where soft-keyboard letters
    // don't reach xterm) apply the Ctrl modifier to the next typed letter.
    takeCtrl: function () {
      if (!ctrlActive) return false;
      ctrlActive = false;
      clearModifier("ctrl");
      return true;
    },
    reset: reset,
  };
}
