interface Props {
  relayStatus: "disconnected" | "connecting" | "connected";
  livekitConnected: boolean;
  claudeConnected: boolean;
}

function StatusDot({ color }: { color: string }) {
  return <div className={`w-1.5 h-1.5 rounded-full ${color}`} />;
}

function statusColor(connected: boolean | string) {
  if (connected === "connecting") return "bg-yellow-500";
  return connected && connected !== "disconnected" ? "bg-green-500" : "bg-red-500";
}

export function StatusBar({
  relayStatus,
  livekitConnected,
  claudeConnected,
}: Props) {
  return (
    <div className="flex items-center justify-between text-xs text-neutral-500 px-1">
      <div className="flex items-center gap-1.5">
        <StatusDot color={statusColor(relayStatus)} />
        <span>Relay Server</span>
      </div>
      <div className="flex items-center gap-1.5">
        <StatusDot color={statusColor(livekitConnected)} />
        <span>LiveKit Audio</span>
      </div>
      <div className="flex items-center gap-1.5">
        <StatusDot color={statusColor(claudeConnected)} />
        <span>Claude</span>
      </div>
    </div>
  );
}
