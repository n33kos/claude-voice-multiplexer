import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../hooks/useRelay";

interface Props {
  entries: TranscriptEntry[];
}

export function Transcript({ entries }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <div className="text-center text-neutral-600 text-sm py-6 h-full">
        Conversation will appear here
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {/* Top gradient fade */}
      <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[#0a0a0a] to-transparent z-10 pointer-events-none" />

      <div className="scrollbar-thin flex flex-col gap-3 overflow-y-auto h-full px-1 pt-4 pb-1">
        {entries.map((entry, i) => {
          if (entry.speaker === "system") {
            return (
              <div key={i} className="flex justify-center">
                <span className="text-xs text-amber-500/80 bg-amber-500/10 px-3 py-1 rounded-full">
                  {entry.text}
                </span>
              </div>
            );
          }
          return (
            <div
              key={i}
              className={`flex flex-col ${entry.speaker === "user" ? "items-end" : "items-start"}`}
            >
              <span className="text-[10px] text-neutral-600 mb-0.5 px-1">
                {entry.speaker === "user" ? "You" : "Claude"}
              </span>
              <div
                className={`
                  text-sm px-3 py-2 rounded-2xl max-w-[85%]
                  ${
                    entry.speaker === "user"
                      ? "bg-blue-600 text-white rounded-br-md"
                      : "bg-neutral-800 text-neutral-200 rounded-bl-md"
                  }
                `}
              >
                {entry.text}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}
