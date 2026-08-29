// Pure resolution for the one-shot session pin used by pane-mode clients.

export function resolvePaneSession(paneMode, pinPending, pendingSessionId, sessions) {
  if (!paneMode || !pinPending || !pendingSessionId) return { consumed: false, sessionId: null };
  var list = sessions || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === pendingSessionId) {
      return { consumed: true, sessionId: pendingSessionId };
    }
  }
  return { consumed: true, sessionId: null };
}

// session_switched is authoritative even when the previous session left the
// vendor selector locked. The lock only applies to late model metadata.
export function resolveSwitchedVendor(currentVendor, sessionVendor) {
  return sessionVendor || currentVendor || "claude";
}
