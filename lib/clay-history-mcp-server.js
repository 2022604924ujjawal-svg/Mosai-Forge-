// Clay-history MCP Server
// ------------------------
// Tools that let the Clay host agent search and read across the user's
// entire workspace (sessions, project memory, decision history). Scoped
// strictly to the active user's data via the projectSessions accessor;
// the Clay session never reads other users' files.
//
// Mounted only on host-agent mate projects (def.hostAgent === true), so
// regular Mates and project sessions never see these tools.
//
// Usage:
//   var clayHistoryMcp = require("./clay-history-mcp-server");
//   var tools = clayHistoryMcp.getToolDefs({ getAllProjectsWithSessions: ..., readSessionRange: ... });
//   var mcpConfig = adapter.createToolServer({ name: "clay-history", version: "1.0.0", tools: tools });

var fs = require("fs");
var path = require("path");
var sessionSearch = require("./session-search");

var z;
try { z = require("zod"); } catch (e) { z = null; }

function buildShape(props, required) {
  if (!z) return {};
  var shape = {};
  var keys = Object.keys(props);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var p = props[k];
    var field;
    if (p.type === "number") field = z.number();
    else if (p.type === "boolean") field = z.boolean();
    else if (p.enum) field = z.enum(p.enum);
    else field = z.string();
    if (p.description) field = field.describe(p.description);
    if (!required || required.indexOf(k) === -1) field = field.optional();
    shape[k] = field;
  }
  return shape;
}

// Heuristic patterns that suggest a "decision" was made. Kept conservative
// so the result set stays small and useful. Matches case-insensitively.
var DECISION_PATTERNS = [
  /\bdecided\s+to\b/i,
  /\bdecision\b/i,
  /\bgoing\s+with\b/i,
  /\bsettled\s+on\b/i,
  /\bchose\s+to\b/i,
  /\bwill\s+go\s+with\b/i,
  /\blet'?s\s+go\s+with\b/i,
  /\b결정\b/,                  // Korean "decision"
  /\b정했\b/,                  // Korean "settled/chose"
  /\b이걸로\s+가/,              // Korean "going with this"
];

function getToolDefs(deps) {
  var getAllProjectsWithSessions = deps.getAllProjectsWithSessions;
  if (typeof getAllProjectsWithSessions !== "function") {
    throw new Error("clay-history-mcp-server requires getAllProjectsWithSessions");
  }

  var tools = [];

  // --- search_clay_history ---
  // BM25 search across every session the user can see. Returns ranked
  // hits with snippet + project/session attribution. Optionally scoped
  // to a single project slug or a date window (since/until in ISO date
  // or unix-millis form).
  tools.push({
    name: "search_clay_history",
    description: "Search the user's entire workspace history for past conversations and decisions using BM25 ranking. Returns up to 30 hits with project, session ID, and a short snippet. Use this first for any 'what did I say about X' or 'when did I decide Y' question. Scope can be narrowed by projectSlug, since, or until.",
    inputSchema: buildShape({
      query: { type: "string", description: "Free-text search query. Multiple terms are AND-ish via BM25." },
      projectSlug: { type: "string", description: "Optional. Restrict to one project's sessions (matches the slug shown in the Clay sidebar)." },
      since: { type: "string", description: "Optional. Earliest activity date. Accepts ISO 8601 (2026-04-01) or unix milliseconds." },
      until: { type: "string", description: "Optional. Latest activity date. Same formats as 'since'." },
      maxResults: { type: "number", description: "Optional. Default 20, max 50." },
    }, ["query"]),
    handler: function (args) {
      try {
        var query = (args.query || "").trim();
        if (!query) {
          return Promise.resolve({
            content: [{ type: "text", text: "Empty query." }],
            isError: true,
          });
        }
        var maxResults = Math.min(50, Math.max(1, args.maxResults || 20));
        var projectSessions = getAllProjectsWithSessions();
        if (args.projectSlug) {
          projectSessions = projectSessions.filter(function (p) {
            return p.projectSlug === args.projectSlug;
          });
        }
        var sinceMs = parseTime(args.since);
        var untilMs = parseTime(args.until);
        if (sinceMs != null || untilMs != null) {
          projectSessions = projectSessions.map(function (p) {
            var filtered = (p.sessions || []).filter(function (s) {
              var t = s.lastActivity || s.createdAt || 0;
              if (sinceMs != null && t < sinceMs) return false;
              if (untilMs != null && t > untilMs) return false;
              return true;
            });
            return Object.assign({}, p, { sessions: filtered });
          }).filter(function (p) { return p.sessions.length > 0; });
        }
        var results = sessionSearch.searchPalette(projectSessions, query, { maxResults: maxResults });
        if (results.length === 0) {
          return Promise.resolve({
            content: [{ type: "text", text: "No matches for: " + query }],
          });
        }
        var lines = results.map(function (r) {
          var when = r.lastActivity ? new Date(r.lastActivity).toISOString().slice(0, 10) : "";
          var ref = "[" + r.projectSlug + "/" + r.sessionId + " — " + when + "]";
          var head = r.sessionTitle || "(untitled)";
          var body = r.snippet ? r.snippet.replace(/\s+/g, " ").trim() : "";
          if (body.length > 220) body = body.substring(0, 220) + "...";
          return ref + " " + head + (body ? " — " + body : "");
        });
        return Promise.resolve({
          content: [{ type: "text", text: lines.join("\n") }],
        });
      } catch (e) {
        return Promise.resolve({
          content: [{ type: "text", text: "Search failed: " + (e.message || String(e)) }],
          isError: true,
        });
      }
    },
  });

  // --- read_session ---
  // Pull a window of turns from a specific session. Use this after
  // search_clay_history identifies a session worth reading more of.
  tools.push({
    name: "read_session",
    description: "Read a window of turns from a specific session. Call this after search_clay_history identifies an interesting hit — the snippet there is short, this gives you the surrounding context. Returns user_message and assistant text turns; tool calls are summarized.",
    inputSchema: buildShape({
      projectSlug: { type: "string", description: "Project slug, e.g. 'clay' or 'mate-abc123'." },
      sessionId: { type: "string", description: "Session local ID (e.g. 'sess_abc123')." },
      offset: { type: "number", description: "Optional. Skip the first N turns. Default 0." },
      limit: { type: "number", description: "Optional. Max turns to return. Default 30, max 100." },
    }, ["projectSlug", "sessionId"]),
    handler: function (args) {
      try {
        var projectSlug = args.projectSlug;
        var sessionId = args.sessionId;
        var offset = Math.max(0, args.offset || 0);
        var limit = Math.min(100, Math.max(1, args.limit || 30));

        var projectSessions = getAllProjectsWithSessions();
        var found = null;
        for (var p = 0; p < projectSessions.length; p++) {
          if (projectSessions[p].projectSlug !== projectSlug) continue;
          var sessions = projectSessions[p].sessions || [];
          for (var s = 0; s < sessions.length; s++) {
            if (sessions[s].localId === sessionId) {
              found = { project: projectSessions[p], session: sessions[s] };
              break;
            }
          }
          if (found) break;
        }
        if (!found) {
          return Promise.resolve({
            content: [{ type: "text", text: "Session not found: " + projectSlug + "/" + sessionId }],
            isError: true,
          });
        }
        var history = found.session.history || [];
        var slice = history.slice(offset, offset + limit);
        if (slice.length === 0) {
          return Promise.resolve({
            content: [{ type: "text", text: "No turns in window (offset=" + offset + ", limit=" + limit + ", total=" + history.length + ")." }],
          });
        }
        var out = [];
        out.push("# " + (found.session.title || "untitled") + " — " + projectSlug + "/" + sessionId);
        out.push("Showing turns " + (offset + 1) + "-" + (offset + slice.length) + " of " + history.length + "\n");
        for (var i = 0; i < slice.length; i++) {
          var entry = slice[i];
          var label;
          var text = "";
          if (entry.type === "user_message") {
            label = "USER";
            text = entry.text || "";
          } else if (entry.type === "delta") {
            label = "ASSISTANT";
            text = entry.text || "";
          } else if (entry.type === "tool_executing" || entry.type === "tool_result") {
            label = "TOOL";
            text = (entry.name || "") + (entry.input ? " " + JSON.stringify(entry.input).substring(0, 120) : "");
          } else {
            continue;
          }
          if (text.length > 800) text = text.substring(0, 800) + "...";
          out.push("[" + label + "] " + text);
        }
        return Promise.resolve({
          content: [{ type: "text", text: out.join("\n") }],
        });
      } catch (e) {
        return Promise.resolve({
          content: [{ type: "text", text: "read_session failed: " + (e.message || String(e)) }],
          isError: true,
        });
      }
    },
  });

  // --- list_recent_decisions ---
  // Heuristic. Scans user_message and assistant text turns for phrases
  // that suggest a decision was made. Useful when the user asks
  // "what did I decide about X recently". Returns ranked-by-recency.
  tools.push({
    name: "list_recent_decisions",
    description: "Find turns that mention an explicit decision (decided to / going with / 결정 / 정했 etc.). Use when the user asks about recent decisions. Returns chronologically with the project and session the decision was made in. Scope by projectSlug or since/until.",
    inputSchema: buildShape({
      projectSlug: { type: "string", description: "Optional. Restrict to one project." },
      since: { type: "string", description: "Optional. Earliest activity date (ISO or unix-ms)." },
      until: { type: "string", description: "Optional. Latest activity date." },
      maxResults: { type: "number", description: "Optional. Default 15, max 30." },
    }),
    handler: function (args) {
      try {
        var maxResults = Math.min(30, Math.max(1, args.maxResults || 15));
        var sinceMs = parseTime(args.since);
        var untilMs = parseTime(args.until);
        var projectSessions = getAllProjectsWithSessions();
        if (args.projectSlug) {
          projectSessions = projectSessions.filter(function (p) {
            return p.projectSlug === args.projectSlug;
          });
        }
        var hits = [];
        for (var p = 0; p < projectSessions.length; p++) {
          var proj = projectSessions[p];
          var sessions = proj.sessions || [];
          for (var s = 0; s < sessions.length; s++) {
            var session = sessions[s];
            var t = session.lastActivity || session.createdAt || 0;
            if (sinceMs != null && t < sinceMs) continue;
            if (untilMs != null && t > untilMs) continue;
            var history = session.history || [];
            for (var h = 0; h < history.length; h++) {
              var entry = history[h];
              if (entry.type !== "user_message" && entry.type !== "delta") continue;
              var text = entry.text || "";
              if (!text) continue;
              if (!matchesDecisionPattern(text)) continue;
              hits.push({
                projectSlug: proj.projectSlug,
                projectTitle: proj.projectTitle,
                sessionId: session.localId,
                sessionTitle: session.title || "(untitled)",
                lastActivity: t,
                turnIdx: h,
                turnType: entry.type === "user_message" ? "user" : "assistant",
                text: text,
              });
            }
          }
        }
        hits.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
        if (hits.length > maxResults) hits = hits.slice(0, maxResults);
        if (hits.length === 0) {
          return Promise.resolve({
            content: [{ type: "text", text: "No decision-pattern matches in scope." }],
          });
        }
        var lines = hits.map(function (h) {
          var when = h.lastActivity ? new Date(h.lastActivity).toISOString().slice(0, 10) : "";
          var ref = "[" + h.projectSlug + "/" + h.sessionId + " — " + when + "]";
          var snippet = h.text.replace(/\s+/g, " ").trim();
          if (snippet.length > 220) snippet = snippet.substring(0, 220) + "...";
          return ref + " (" + h.turnType + ") " + snippet;
        });
        return Promise.resolve({
          content: [{ type: "text", text: lines.join("\n") }],
        });
      } catch (e) {
        return Promise.resolve({
          content: [{ type: "text", text: "list_recent_decisions failed: " + (e.message || String(e)) }],
          isError: true,
        });
      }
    },
  });

  return tools;
}

function parseTime(input) {
  if (input == null || input === "") return null;
  if (typeof input === "number") return input;
  var s = String(input).trim();
  if (/^\d{10,}$/.test(s)) return parseInt(s, 10); // unix ms
  var d = new Date(s);
  var n = d.getTime();
  return isNaN(n) ? null : n;
}

function matchesDecisionPattern(text) {
  for (var i = 0; i < DECISION_PATTERNS.length; i++) {
    if (DECISION_PATTERNS[i].test(text)) return true;
  }
  return false;
}

module.exports = { getToolDefs: getToolDefs };
