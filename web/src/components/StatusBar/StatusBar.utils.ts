export function statusColor(connected: boolean | string): "green" | "yellow" | "red" {
  if (connected === "connecting") return "yellow";
  return connected && connected !== "disconnected" ? "green" : "red";
}
