import type { Settings } from "../../hooks/useSettings";
import type { AuthDevice } from "../../hooks/useAuth";
import type { ConnectedClient } from "../../hooks/useRelay";

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  authEnabled?: boolean;
  devices?: AuthDevice[];
  connectedClients?: ConnectedClient[];
  onGenerateCode?: () => Promise<{ code: string; expires_in: number } | null>;
  onRevokeDevice?: (deviceId: string) => Promise<boolean>;
}
