export interface StatusBarProps {
  relayStatus: "disconnected" | "connecting" | "connected";
  livekitConnected: boolean;
  claudeConnected: boolean;
}
