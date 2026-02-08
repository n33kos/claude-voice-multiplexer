import type { Settings } from '../hooks/useSettings'

interface Props {
  open: boolean
  onClose: () => void
  settings: Settings
  onUpdate: (patch: Partial<Settings>) => void
}

export function Settings({ open, onClose, settings, onUpdate }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl p-5 pb-8 sm:pb-5 animate-in slide-in-from-bottom">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-medium text-neutral-300">Settings</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {/* Auto-listen toggle */}
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-neutral-200">Auto-listen</span>
              <span className="text-xs text-neutral-500">
                Automatically start recording when Claude finishes speaking
              </span>
            </div>
            <button
              role="switch"
              aria-checked={settings.autoListen}
              onClick={() => onUpdate({ autoListen: !settings.autoListen })}
              className={`
                relative shrink-0 w-10 h-6 rounded-full transition-colors duration-200
                ${settings.autoListen ? 'bg-blue-500' : 'bg-neutral-700'}
              `}
            >
              <span
                className={`
                  absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200
                  ${settings.autoListen ? 'translate-x-4' : 'translate-x-0'}
                `}
              />
            </button>
          </label>

          {/* Speaker mute toggle */}
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-neutral-200">Mute speaker</span>
              <span className="text-xs text-neutral-500">
                Mute Claude's voice playback on this tab
              </span>
            </div>
            <button
              role="switch"
              aria-checked={settings.speakerMuted}
              onClick={() => onUpdate({ speakerMuted: !settings.speakerMuted })}
              className={`
                relative shrink-0 w-10 h-6 rounded-full transition-colors duration-200
                ${settings.speakerMuted ? 'bg-blue-500' : 'bg-neutral-700'}
              `}
            >
              <span
                className={`
                  absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200
                  ${settings.speakerMuted ? 'translate-x-4' : 'translate-x-0'}
                `}
              />
            </button>
          </label>
        </div>
      </div>
    </div>
  )
}
