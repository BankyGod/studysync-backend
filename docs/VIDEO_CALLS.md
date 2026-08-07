# Pod video calls (chat)

Group members can start an **online video call** from pod chat. The backend creates a shared **Jitsi** room (no paid API key required with `meet.jit.si`).

## API

Base: `/api/workspaces/:groupId/calls`  
Auth: Bearer JWT + must be a group member

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/` | Start call (fails with 409 if one is already active) |
| `GET` | `/active` | Current active call or `{ call: null }` |
| `GET` | `/:callId` | Call details |
| `POST` | `/:callId/join` | Mark current user as joined |
| `POST` | `/:callId/leave` | Leave (auto-ends when last person leaves) |
| `POST` | `/:callId/end` | End call for everyone |

### Start response (`201`)

```json
{
  "call": {
    "id": "...",
    "groupId": "cs-101",
    "status": "active",
    "provider": "jitsi",
    "roomName": "StudySynccs101abc123",
    "joinUrl": "https://meet.jit.si/StudySynccs101abc123?...",
    "startedById": "...",
    "participantIds": ["..."],
    "participantCount": 1,
    "startedAt": "..."
  },
  "message": {
    "id": "...",
    "type": "call",
    "content": "Started a video call",
    "call": { "id": "...", "status": "active", "joinUrl": "...", "roomName": "..." }
  }
}
```

## Socket.IO (workspace room)

Join with `join:workspace` `{ groupId }` first.

| Event | When |
|-------|------|
| `call:started` | Someone started a call |
| `call:participant-joined` | Member joined |
| `call:participant-left` | Member left |
| `call:ended` | Call ended |
| `message:new` | Chat bubble for start/end |

## Frontend integration

1. Button in chat: `POST /workspaces/{groupId}/calls`
2. Open `call.joinUrl` in a new tab **or** embed Jitsi in an iframe / [Jitsi Meet External API](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe)
3. Listen for `call:started` so other members see “Join call”
4. On join: `POST .../calls/{callId}/join` then open the same `joinUrl`
5. On hang up: `POST .../calls/{callId}/leave` or `.../end`

Example iframe:

```html
<iframe
  allow="camera; microphone; display-capture; autoplay"
  src="{call.joinUrl}"
  style="width:100%;height:70vh;border:0"
></iframe>
```

## Env

```
JITSI_DOMAIN=meet.jit.si
```

Optional: point `JITSI_DOMAIN` at your own Jitsi server later.
