// Home Chat (Clay) — server-side handler.
// Routes home_clay_* WS messages to the user's Clay (host agent) mate
// project session, independent of which project the WS is currently
// bound to. Mirrors session events back to the WS as home_clay_* so the
// client renders into its own home-chat panel without disturbing the
// active project view.

function attachClayHome(deps) {
  var users = deps.users;
  var mates = deps.mates;
  var projects = deps.projects;
  var addProject = deps.addProject;

  // Per-WS subscription state.
  // ws._homeClayTap = { unsubscribe, sessionId, claySlug }
  // Stored on the ws itself rather than a side map so it's GC'd with the
  // socket and so handleDisconnection sees it without a registry lookup.

  function findClayProject(userId, ensureRegistered) {
    var mateCtx = mates.buildMateCtx(userId);
    var allMates = mates.getAllMates(mateCtx);
    var clay = null;
    for (var i = 0; i < allMates.length; i++) {
      if (allMates[i] && allMates[i].builtinKey === "clay") { clay = allMates[i]; break; }
    }
    if (!clay) return null;
    var slug = "mate-" + clay.id;
    if (!projects.has(slug)) {
      if (!ensureRegistered) return null;
      var dir = mates.getMateDir(mateCtx, clay.id);
      var fs = require("fs");
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      var name = (clay.profile && clay.profile.displayName) || clay.name || "Clay";
      addProject(dir, slug, name, null, clay.createdBy || userId, null, { isMate: true, mateDisplayName: name, isHostAgent: true });
    }
    var ctx = projects.get(slug);
    return ctx ? { ctx: ctx, slug: slug, mate: clay } : null;
  }

  // Pick the most recent visible session in Clay's project owned by this
  // user. Create one if none exists. The home chat is "single thread per
  // user" by default; home_clay_new_session forks a fresh one on demand.
  function getOrCreateHomeSession(found, userId) {
    var sm = found.ctx.getSessionManager();
    if (!sm) return null;
    var best = null;
    sm.sessions.forEach(function (s) {
      if (s.hidden) return;
      if (s.ownerId && s.ownerId !== userId) return;
      if (!best || (s.lastActivity || 0) > (best.lastActivity || 0)) best = s;
    });
    if (best) return best;
    var sess = sm.createSession({ ownerId: userId, vendor: "claude" }, null);
    return sess;
  }

  // Convert a session.history entry stream into the simplified home-chat
  // shape (alternating user / assistant turns, assistant text coalesced
  // across deltas). Tool calls and intermediate events are dropped — the
  // home chat surface intentionally hides them.
  function historyToHomeChat(history) {
    var msgs = [];
    var pending = "";
    function flushAssistant() {
      if (pending) {
        msgs.push({ role: "assistant", text: pending });
        pending = "";
      }
    }
    for (var i = 0; i < history.length; i++) {
      var e = history[i];
      if (!e) continue;
      if (e.type === "user_message" && e.text) {
        flushAssistant();
        msgs.push({ role: "user", text: e.text });
      } else if (e.type === "delta" && typeof e.text === "string") {
        pending += e.text;
      } else if (e.type === "result" || e.type === "done") {
        flushAssistant();
      } else if (e.type === "error" && e.text) {
        flushAssistant();
        msgs.push({ role: "assistant", text: "[error] " + e.text });
      }
    }
    flushAssistant();
    return msgs;
  }

  function transformEvent(obj) {
    if (!obj || typeof obj.type !== "string") return null;
    if (obj.type === "delta" && typeof obj.text === "string") {
      return { type: "home_clay_delta", text: obj.text };
    }
    if (obj.type === "result" || obj.type === "done") {
      return { type: "home_clay_done" };
    }
    if (obj.type === "error") {
      return { type: "home_clay_error", text: obj.text || "Unknown error" };
    }
    // intentionally skip: tool_*, thinking_*, status, plan_*, debate, etc.
    return null;
  }

  function teardownTap(ws) {
    if (ws && ws._homeClayTap && typeof ws._homeClayTap.unsubscribe === "function") {
      try { ws._homeClayTap.unsubscribe(); } catch (e) {}
    }
    if (ws) ws._homeClayTap = null;
  }

  function setupTap(ws, ctx, sessionId) {
    teardownTap(ws);
    var sm = ctx.getSessionManager();
    if (!sm || typeof sm.subscribeSession !== "function") return;
    var unsubscribe = sm.subscribeSession(sessionId, function (obj) {
      if (ws.readyState !== 1) return;
      var transformed = transformEvent(obj);
      if (!transformed) return;
      try { ws.send(JSON.stringify(transformed)); } catch (e) {}
    });
    if (!unsubscribe) return;
    ws._homeClayTap = { unsubscribe: unsubscribe, sessionId: sessionId, claySlug: ctx.slug || "" };
  }

  function sendError(ws, text) {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({ type: "home_clay_error", text: text }));
    } catch (e) {}
  }

  function handleMessage(ws, msg) {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.type !== "home_clay_open" && msg.type !== "home_clay_send" && msg.type !== "home_clay_new_session" && msg.type !== "home_clay_close") {
      return false;
    }

    if (msg.type === "home_clay_close") {
      teardownTap(ws);
      return true;
    }

    var userId = ws._clayUser ? ws._clayUser.id : null;
    if (users.isMultiUser() && !userId) {
      sendError(ws, "Not authenticated.");
      return true;
    }

    var found = findClayProject(userId, true);
    if (!found) {
      sendError(ws, "Clay mate not available yet — open the Mates panel once to seed.");
      return true;
    }

    if (msg.type === "home_clay_open") {
      var session = getOrCreateHomeSession(found, userId);
      if (!session) {
        sendError(ws, "Could not open Clay session.");
        return true;
      }
      setupTap(ws, found.ctx, session.localId);
      try {
        ws.send(JSON.stringify({
          type: "home_clay_history",
          sessionId: session.localId,
          messages: historyToHomeChat(session.history || []),
        }));
      } catch (e) {}
      return true;
    }

    if (msg.type === "home_clay_new_session") {
      var sm = found.ctx.getSessionManager();
      if (!sm) { sendError(ws, "Session manager unavailable."); return true; }
      var fresh = sm.createSession({ ownerId: userId, vendor: "claude" }, null);
      setupTap(ws, found.ctx, fresh.localId);
      try {
        ws.send(JSON.stringify({
          type: "home_clay_history",
          sessionId: fresh.localId,
          messages: [],
        }));
      } catch (e) {}
      return true;
    }

    if (msg.type === "home_clay_send") {
      var text = (msg.text || "").trim();
      if (!text) return true;

      var sm2 = found.ctx.getSessionManager();
      if (!sm2) { sendError(ws, "Session manager unavailable."); return true; }

      // Resume the tap if the WS reconnected since open.
      var tap = ws._homeClayTap;
      var sessionId = tap ? tap.sessionId : null;
      if (!sessionId) {
        var s2 = getOrCreateHomeSession(found, userId);
        if (!s2) { sendError(ws, "Could not open Clay session."); return true; }
        sessionId = s2.localId;
        setupTap(ws, found.ctx, sessionId);
      }
      var session2 = sm2.sessions.get(sessionId);
      if (!session2) {
        sendError(ws, "Session not found: " + sessionId);
        return true;
      }

      // Drive the SDK exactly the way the regular project user-message
      // path does. The session's own subscriber forwards events back as
      // home_clay_* via the tap installed above.
      var sdk = found.ctx.sdk;
      if (!sdk) {
        sendError(ws, "Clay SDK bridge unavailable.");
        return true;
      }
      try {
        if (!session2.isProcessing) {
          session2.isProcessing = true;
          session2.sentToolResults = {};
          if (!session2.queryInstance && (!session2.worker || session2.messageQueue !== "worker")) {
            sdk.startQuery(session2, text, null, null);
          } else {
            sdk.pushMessage(session2, text, null);
          }
        } else {
          sdk.pushMessage(session2, text, null);
        }
      } catch (e) {
        sendError(ws, "Failed to dispatch: " + (e.message || String(e)));
      }
      return true;
    }

    return false;
  }

  function handleDisconnection(ws) {
    teardownTap(ws);
  }

  return { handleMessage: handleMessage, handleDisconnection: handleDisconnection };
}

module.exports = { attachClayHome: attachClayHome };
