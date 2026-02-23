import { useState, useEffect, useCallback } from "react";
import { authFetch } from "./useAuth";

export interface VoiceOption {
  id: string;
  name: string;
  lang: string;
  gender: string;
}

export interface VoiceSettings {
  kokoro_voice: string;
  kokoro_speed: number;
  available_voices: VoiceOption[];
}

export interface ServiceStatus {
  [name: string]: string;
}

export function useVoiceSettings(open: boolean) {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [services, setServices] = useState<ServiceStatus>({});
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await authFetch("/api/settings");
      if (resp.ok) {
        setSettings(await resp.json());
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  const fetchServices = useCallback(async () => {
    try {
      const resp = await authFetch("/api/services");
      if (resp.ok) {
        const data = await resp.json();
        setServices(data.services || {});
      }
    } catch {
      // ignore
    }
  }, []);

  const updateSetting = useCallback(
    async (key: string, value: string | number) => {
      setSaveStatus("saving");
      try {
        const resp = await authFetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: value }),
        });
        if (resp.ok) {
          setSettings((prev) =>
            prev ? { ...prev, [key]: value } : prev,
          );
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 1500);
          return true;
        }
      } catch {
        // ignore
      }
      setSaveStatus("idle");
      return false;
    },
    [],
  );

  const restartService = useCallback(async (name: string) => {
    try {
      const resp = await authFetch(`/api/services/${name}/restart`, {
        method: "POST",
      });
      return resp.ok;
    } catch {
      // ignore
    }
    return false;
  }, []);

  const testVoice = useCallback(
    async (voice: string, speed: number) => {
      try {
        const resp = await authFetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kokoro_voice: voice,
            kokoro_speed: speed,
          }),
        });
        if (!resp.ok) return;
        setSettings((prev) =>
          prev
            ? { ...prev, kokoro_voice: voice, kokoro_speed: speed }
            : prev,
        );
      } catch {
        // ignore
      }
    },
    [],
  );

  useEffect(() => {
    if (open) {
      fetchSettings();
      fetchServices();
    }
  }, [open, fetchSettings, fetchServices]);

  return {
    settings,
    services,
    loading,
    saveStatus,
    updateSetting,
    restartService,
    fetchServices,
    testVoice,
  };
}
