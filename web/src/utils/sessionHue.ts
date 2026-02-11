/** Derive a deterministic hue (0-360) from a session ID string. */
export function sessionHue(sessionId: string): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}
