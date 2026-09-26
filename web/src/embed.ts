/**
 * Embed mode — lets another app host vmux (e.g. in an iframe) locked to a
 * single session.  Parsed once from the URL at load; with no query params
 * every field is inert and the app behaves exactly as normal.
 *
 *   ?session=<session_id>   lock to this session: hide the session list,
 *                           ignore every other way of switching sessions,
 *                           and auto-(re)connect whenever it's online.
 *   ?transcript=0           hide the transcript (and with it the text input
 *                           and question/permission cards — use the
 *                           terminal button to answer those).
 *
 * While either param is set, settings changes stay in memory so the embed
 * can't overwrite the settings of a normal vmux tab on the same origin.
 */

function parse() {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session")?.trim() || null;
  const transcript = params.get("transcript");
  const hideTranscript = transcript === "0" || transcript === "false";
  return Object.freeze({
    lockedSessionId: session,
    hideTranscript,
    active: session !== null || hideTranscript,
  });
}

export const embed = parse();
