import type { StatusBarProps } from "./StatusBar.types";
import { statusColor } from "./StatusBar.utils";
import { StatusDot } from "./components/StatusDot/StatusDot";
import styles from "./StatusBar.module.scss";

export function StatusBar({
  relayStatus,
  livekitConnected,
  claudeConnected,
}: StatusBarProps) {
  return (
    <div data-component="StatusBar" className={styles.Root}>
      <div className={styles.StatusItem}>
        <StatusDot color={statusColor(relayStatus)} />
        <span>Relay Server</span>
      </div>
      <div className={styles.StatusItem}>
        <StatusDot color={statusColor(livekitConnected)} />
        <span>LiveKit Audio</span>
      </div>
      <div className={styles.StatusItem}>
        <StatusDot color={statusColor(claudeConnected)} />
        <span>Claude</span>
      </div>
    </div>
  );
}
