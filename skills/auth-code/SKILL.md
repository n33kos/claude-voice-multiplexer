---
name: voice-multiplexer:auth-code
description: Generate a device pairing code for the voice multiplexer web app
---

# Generate Auth Code

Generate a one-time pairing code for authorizing a new device to connect to the Voice Multiplexer.

## Instructions

1. Call the `generate_auth_code` MCP tool (works independently — no standby required, just needs the relay server running)
2. Display the resulting code to the user clearly
3. Let them know to enter it on the web app within 60 seconds

If the relay server is not running, inform the user to start services with `/voice-multiplexer:start-services`.
