import type { StatusBarProps } from "./StatusBar.types";
import { statusColor } from "./StatusBar.utils";
import { StatusDot } from "./components/StatusDot/StatusDot";

export function StatusBar({
  relayStatus,
  livekitConnected,
  claudeConnected,
}: StatusBarProps) {
  return (
    <div data-component="StatusBar" className="flex items-center justify-between text-xs text-neutral-500 px-1">
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
