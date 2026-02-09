import type { Settings } from "../../hooks/useSettings";

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}
