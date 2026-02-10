import { useState, useEffect, useCallback } from "react";
import classNames from "classnames";
import type { ThemeMode } from "../../hooks/useSettings";
import type { SettingsProps } from "./Settings.types";
import styles from "./Settings.module.scss";

interface ServiceHealth {
  whisper: { status: string };
  kokoro: { status: string };
  livekit: { status: string };
  relay: { status: string };
}

function useServiceHealth(open: boolean) {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/health");
      if (resp.ok) setHealth(await resp.json());
    } catch {
      // relay itself is down
      setHealth({
        whisper: { status: "unknown" },
        kokoro: { status: "unknown" },
        livekit: { status: "unknown" },
        relay: { status: "down" },
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  return { health, loading, refresh };
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function Settings({
  open,
  onClose,
  settings,
  onUpdate,
  authEnabled,
  devices,
  connectedClients,
  onGenerateCode,
  onRevokeDevice,
}: SettingsProps) {
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const { health, loading: healthLoading, refresh: refreshHealth } = useServiceHealth(open);

  if (!open) return null;

  const handleGenerateCode = async () => {
    if (!onGenerateCode) return;
    setCodeLoading(true);
    const result = await onGenerateCode();
    setCodeLoading(false);
    if (result) {
      setPairCode(result.code);
      // Auto-clear after expiry
      setTimeout(() => setPairCode(null), result.expires_in * 1000);
    }
  };

  const handleRevoke = async (deviceId: string) => {
    if (!onRevokeDevice) return;
    setRevoking(deviceId);
    await onRevokeDevice(deviceId);
    setRevoking(null);
  };

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

          <div className={styles.Divider} />

          <div className={styles.SectionHeader}>
            <span className={styles.SectionTitle}>Services</span>
            <button
              onClick={refreshHealth}
              disabled={healthLoading}
              className={styles.CodeButton}
            >
              {healthLoading ? "Checking..." : "Refresh"}
            </button>
          </div>

          {health && (
            <div className={styles.ServiceList}>
              {(["relay", "whisper", "kokoro", "livekit"] as const).map((svc) => {
                const status = health[svc]?.status ?? "unknown";
                const labels = { relay: "Relay Server", whisper: "Whisper (STT)", kokoro: "Kokoro (TTS)", livekit: "LiveKit" };
                return (
                  <div key={svc} className={styles.ServiceRow}>
                    <span
                      className={classNames(styles.ServiceDot, {
                        [styles.ServiceDotOk]: status === "ok",
                        [styles.ServiceDotDown]: status === "down",
                        [styles.ServiceDotUnknown]: status === "unknown",
                      })}
                    />
                    <span className={styles.ServiceName}>{labels[svc]}</span>
                    <span className={classNames(styles.ServiceStatus, {
                      [styles.ServiceStatusOk]: status === "ok",
                      [styles.ServiceStatusDown]: status === "down",
                    })}>
                      {status === "ok" ? "Running" : status === "down" ? "Down" : "Unknown"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {connectedClients && connectedClients.length > 0 && (
            <>
              <div className={styles.Divider} />
              <div className={styles.SectionHeader}>
                <span className={styles.SectionTitle}>Connected Clients</span>
                <span className={styles.ClientCount}>{connectedClients.length}</span>
              </div>
              <div className={styles.ServiceList}>
                {connectedClients.map((client) => (
                  <div key={client.client_id} className={styles.ServiceRow}>
                    <span className={classNames(styles.ServiceDot, styles.ServiceDotOk)} />
                    <span className={styles.ServiceName}>{client.device_name}</span>
                    <span className={styles.ServiceStatus}>{client.client_id}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {authEnabled && devices && (
            <>
              <div className={styles.Divider} />

              <div className={styles.SectionHeader}>
                <span className={styles.SectionTitle}>Authorized Devices</span>
                <button
                  onClick={handleGenerateCode}
                  disabled={codeLoading}
                  className={styles.CodeButton}
                >
                  {codeLoading ? "Generating..." : "Pair New Device"}
                </button>
              </div>

              {pairCode && (
                <div className={styles.CodeDisplay}>
                  <span className={styles.CodeLabel}>Pairing code:</span>
                  <span className={styles.CodeValue}>{pairCode}</span>
                  <span className={styles.CodeHint}>Expires in 60s</span>
                </div>
              )}

              {devices.map((device) => (
                <div key={device.device_id} className={styles.DeviceRow}>
                  <div className={styles.DeviceInfo}>
                    <span className={styles.DeviceName}>{device.device_name}</span>
                    <span className={styles.DeviceMeta}>
                      Paired {formatDate(device.paired_at)}
                    </span>
                  </div>
                  <button
                    onClick={() => handleRevoke(device.device_id)}
                    disabled={revoking === device.device_id}
                    className={styles.RevokeButton}
                  >
                    {revoking === device.device_id ? "..." : "Revoke"}
                  </button>
                </div>
              ))}

              {devices.length === 0 && (
                <span className={styles.NoDevices}>No devices paired yet</span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
