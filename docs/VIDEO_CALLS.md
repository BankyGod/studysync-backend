# Pod video calls (LiveKit)

Primary in-app video uses **LiveKit**. The StudySync API mints short-lived access tokens; media goes through LiveKit Cloud (or your self-hosted LiveKit server). Do **not** open a browser URL / deep-link for joins.

## Env (Render / `.env`)

```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxx
LIVEKIT_API_SECRET=secretxxxxxxxx
```

Create a project at [cloud.livekit.io](https://cloud.livekit.io) and copy the WebSocket URL + API key/secret.

Self-host: same three vars pointing at your LiveKit server (`wss://livekit.example.com`).

Without these vars, `POST .../calls` falls back to Socket.IO `webrtc`.

---

## Backend response (LiveKit)

`POST /api/workspaces/:groupId/calls` (default when LiveKit is configured):

```json
{
  "call": {
    "id": "...",
    "provider": "livekit",
    "roomName": "StudySynccs101abc",
    "url": "wss://your-project.livekit.cloud",
    "token": "eyJ...",
    "moderator": true,
    "livekitConfigured": true,
    "embed": {
      "mode": "livekit",
      "url": "wss://your-project.livekit.cloud",
      "token": "eyJ...",
      "roomName": "StudySynccs101abc",
      "identity": "<user-id>",
      "displayName": "Ada Lovelace"
    }
  }
}
```

- **Starter** → `moderator: true` + `roomAdmin` grant on the token  
- **Joiner** (`POST .../calls/:id/join`) → new token for that user (`moderator: false` unless they started the call)

If `livekitConfigured: false`, credentials are missing on the server.

---

## Frontend (`livekit-client` or `@livekit/components-react`)

```bash
npm install livekit-client
```

```jsx
import { Room, RoomEvent } from 'livekit-client'

const room = new Room()
await room.connect(call.url, call.token)
await room.localParticipant.setCameraEnabled(true)
await room.localParticipant.setMicrophoneEnabled(true)

// Leave / End for all still use StudySync REST:
// POST .../calls/:id/leave
// POST .../calls/:id/end
```

Or with components:

```jsx
import { LiveKitRoom, VideoConference } from '@livekit/components-react'
import '@livekit/components-styles'

<LiveKitRoom token={call.token} serverUrl={call.url} connect={true} video={true} audio={true}>
  <VideoConference />
</LiveKitRoom>
```

---

## Providers

| `provider` | When |
|---|---|
| `livekit` | Default when `LIVEKIT_*` is set |
| `webrtc` | Fallback / explicit Socket.IO signaling |
| `jitsi` | Legacy optional; needs JAAS/JWT or open rooms |

---

## Camera / mic

HTTPS (or localhost) + browser permission. Separate from token minting.
