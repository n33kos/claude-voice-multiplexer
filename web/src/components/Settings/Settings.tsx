import classNames from "classnames";
import type { ThemeMode } from "../../hooks/useSettings";
import type { SettingsProps } from "./Settings.types";
import styles from "./Settings.module.scss";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function Settings({ open, onClose, settings, onUpdate }: SettingsProps) {
  if (!open) return null;

  return (
    <div data-component="Settings" className={styles.Overlay}>
      <div className={styles.Backdrop} onClick={onClose} />
      <div className={styles.Panel}>
        <div className={styles.PanelHeader}>
          <h2 className={styles.Title}>Settings</h2>
          <button onClick={onClose} className={styles.CloseButton}>
            <svg className={styles.CloseIcon} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className={styles.SettingsList}>
          <div className={styles.SettingRow}>
            <div className={styles.SettingLabel}>
              <span className={styles.SettingTitle}>Theme</span>
              <span className={styles.SettingDescription}>
                Choose light, dark, or follow system preference
              </span>
            </div>
            <div className={styles.ThemeSelector}>
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onUpdate({ theme: opt.value })}
                  className={classNames(styles.ThemeOption, {
                    [styles.ThemeOptionActive]: settings.theme === opt.value,
                  })}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <label className={styles.SettingRow}>
            <div className={styles.SettingLabel}>
              <span className={styles.SettingTitle}>Auto-listen</span>
              <span className={styles.SettingDescription}>
                Automatically start recording when Claude finishes speaking
              </span>
            </div>
            <button
              role="switch"
              aria-checked={settings.autoListen}
              onClick={() => onUpdate({ autoListen: !settings.autoListen })}
              className={classNames(styles.Toggle, { [styles.ToggleActive]: settings.autoListen })}
            >
              <span className={classNames(styles.ToggleThumb, { [styles.ToggleThumbActive]: settings.autoListen })} />
            </button>
          </label>

          <label className={styles.SettingRow}>
            <div className={styles.SettingLabel}>
              <span className={styles.SettingTitle}>Mute speaker</span>
              <span className={styles.SettingDescription}>
                Mute Claude's voice playback on this tab
              </span>
            </div>
            <button
              role="switch"
              aria-checked={settings.speakerMuted}
              onClick={() => onUpdate({ speakerMuted: !settings.speakerMuted })}
              className={classNames(styles.Toggle, { [styles.ToggleActive]: settings.speakerMuted })}
            >
              <span className={classNames(styles.ToggleThumb, { [styles.ToggleThumbActive]: settings.speakerMuted })} />
            </button>
          </label>

          <label className={styles.SettingRow}>
            <div className={styles.SettingLabel}>
              <span className={styles.SettingTitle}>Status pill</span>
              <span className={styles.SettingDescription}>
                Show the agent status pill above the voice controls
              </span>
            </div>
            <button
              role="switch"
              aria-checked={settings.showStatusPill}
              onClick={() => onUpdate({ showStatusPill: !settings.showStatusPill })}
              className={classNames(styles.Toggle, { [styles.ToggleActive]: settings.showStatusPill })}
            >
              <span className={classNames(styles.ToggleThumb, { [styles.ToggleThumbActive]: settings.showStatusPill })} />
            </button>
          </label>
        </div>
      </div>
    </div>
  );
}
