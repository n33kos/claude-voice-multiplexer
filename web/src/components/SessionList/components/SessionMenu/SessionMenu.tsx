import { useEffect, useRef, useState } from "react";
import type { DisplaySession } from "../../../../hooks/useRelay";

interface SessionMenuProps {
  session: DisplaySession;
  onClearTranscript: (sessionName: string) => void;
  onRemoveSession: (sessionName: string) => void;
}

export function SessionMenu({
  session,
  onClearTranscript,
  onRemoveSession,
}: SessionMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/50 transition-colors"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-20 overflow-hidden">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClearTranscript(session.session_name);
              setOpen(false);
            }}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            Clear transcripts
          </button>
          {!session.online && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveSession(session.session_name);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-neutral-700 transition-colors"
            >
              Delete session
            </button>
          )}
        </div>
      )}
    </div>
  );
}
