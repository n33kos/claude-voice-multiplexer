---
name: relay-standby
description: Put this Claude session into voice relay standby mode for remote voice access
---

# Voice Relay Standby

Put this session into standby mode so it can receive remote voice input through the Claude Voice Multiplexer relay server.

## Instructions

When invoked, use the `relay_standby` MCP tool to register this session with the relay server. The tool will:

1. Connect to the relay server via WebSocket
2. Register this session with a name and metadata
3. Enter a listening loop where it receives transcribed voice input
4. For each voice message received, respond conversationally — summarize your work, answer questions, and keep responses concise and natural as if speaking out loud
5. Send your response text back through the relay for audio synthesis

## Behavior While in Standby

- Respond as if you are speaking out loud — be conversational, concise, and natural
- Summarize technical details rather than reading raw output
- Remember the full context of your current session and work
- When asked about your work, describe what you've been doing in plain language
- You can still use all your normal tools while in standby
