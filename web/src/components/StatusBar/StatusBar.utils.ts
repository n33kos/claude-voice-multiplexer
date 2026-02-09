export function statusColor(connected: boolean | string): string {
  if (connected === "connecting") return "bg-yellow-500";
  return connected && connected !== "disconnected" ? "bg-green-500" : "bg-red-500";
}
