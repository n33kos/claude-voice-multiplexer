import type { VoiceOption } from "../hooks/useVoiceSettings";

export interface VoiceGroup {
  label: string;
  voices: VoiceOption[];
}

export function groupVoices(voices: VoiceOption[]): VoiceGroup[] {
  const langLabels: Record<string, string> = {
    "en-US": "American English",
    "en-GB": "British English",
    es: "Spanish",
    fr: "French",
    hi: "Hindi",
    it: "Italian",
    ja: "Japanese",
    pt: "Portuguese",
    zh: "Chinese",
  };

  const groups = new Map<string, VoiceOption[]>();
  for (const voice of voices) {
    const genderLabel = voice.gender === "F" ? "Female" : "Male";
    const langLabel = langLabels[voice.lang] || voice.lang;
    const key = `${langLabel} ${genderLabel}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(voice);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      // English first, then alphabetical
      const aEn = a.startsWith("American") || a.startsWith("British");
      const bEn = b.startsWith("American") || b.startsWith("British");
      if (aEn && !bEn) return -1;
      if (!aEn && bEn) return 1;
      return a.localeCompare(b);
    })
    .map(([label, voices]) => ({ label, voices }));
}
