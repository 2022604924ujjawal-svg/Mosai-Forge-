var url = require("url");

function parseWsRequestUrl(requestUrl) {
  var parsed = url.parse(requestUrl || "/", true);
  var paneSession = Number(parsed.query.session);
  if (!Number.isSafeInteger(paneSession) || paneSession < 1) paneSession = null;
  return {
    path: parsed.pathname || "/",
    pane: parsed.query.pane === "1",
    paneSession: paneSession,
  };
}

module.exports = { parseWsRequestUrl: parseWsRequestUrl };
