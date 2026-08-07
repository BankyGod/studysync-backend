# Pod video calls (in-app)

Video calls stay **inside StudySync**. Do **not** redirect users to `meet.jit.si`.

Default provider: **`webrtc`** (camera/mic in your UI via WebRTC + Socket.IO signaling).

Optional: `provider: "jitsi"` embeds Jitsi **inside a panel** with the External API (still no full-page redirect).

---

## Camera error: `gum.general: Could not start video source`

This is a **browser/device** issue, not a missing backend route. Fix checklist:

1. Site must be **HTTPS** (or `localhost`) — camera APIs block plain HTTP.
2. User must **Allow** camera + microphone when the browser prompts.
3. Close Zoom/Teams/other apps using the camera.
4. If using an iframe, it **must** include:
   ```html
   allow="camera; microphone; display-capture; autoplay; clipboard-write"
   ```
5. Prefer mounting WebRTC `<video>` elements in your React tree (default `webrtc` provider) instead of opening a new tab.

---

## API

`POST /api/workspaces/:groupId/calls`

```json
{ "title": "Quick sync", "provider": "webrtc" }
```

| `provider` | Behavior |
|------------|----------|
| `webrtc` (default) | In-app WebRTC; use `call.embed` + socket signaling |
| `jitsi` | Embed Jitsi in a div via External API using `call.embed` |

### Response highlight

```json
{
  "call": {
    "id": "...",
    "provider": "webrtc",
    "joinUrl": null,
    "embed": {
      "mode": "webrtc",
      "callId": "...",
      "groupId": "cs-101",
      "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }],
      "socketRoom": "call:...",
      "displayName": "Ada Lovelace"
    },
    "participantIds": ["..."]
  }
}
```

Other endpoints (unchanged): `GET /active`, `POST /:callId/join|leave|end`.

---

## Frontend: in-app WebRTC (recommended)

1. Start/join call via REST.
2. Open a **full-screen / side panel** in the workspace (stay on StudySync).
3. Socket steps:

```js
socket.emit('call:join-room', { callId, groupId })

socket.on('webrtc:peer-joined', ({ userId }) => {
  // create RTCPeerConnection, createOffer, then:
  socket.emit('webrtc:signal', {
    callId,
    toUserId: userId,
    signal: { type: 'offer', sdp },
  })
})

socket.on('webrtc:signal', async ({ fromUserId, signal }) => {
  // handle offer / answer / ice-candidate
  // reply with webrtc:signal to fromUserId
})

// on hang up:
socket.emit('call:leave-room', { callId })
await api.post(`/workspaces/${groupId}/calls/${callId}/leave`)
```

4. Local media:

```js
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true,
})
localVideoRef.srcObject = stream
```

5. Attach remote tracks to `<video autoPlay playsInline />` elements in your UI.

Mesh WebRTC works well for small pods (≈2–6). For larger rooms later, move to an SFU (LiveKit/Daily).

---

## Frontend: Jitsi embedded (no redirect)

Only if you pass `provider: "jitsi"`.

```html
<script src="https://meet.jit.si/external_api.js"></script>
```

```js
const { domain, options } = call.embed
const api = new JitsiMeetExternalAPI(domain, {
  ...options,
  parentNode: document.getElementById('studysync-call-panel'),
})
```

Never do `window.location = call.joinUrl` or `window.open` unless the user explicitly asks for a pop-out.

Iframe fallback (if you must):

```html
<iframe
  id="studysync-call-panel"
  allow="camera; microphone; display-capture; autoplay; clipboard-write"
  allowfullscreen
  src="{call.joinUrl}"
  style="width:100%;height:70vh;border:0;border-radius:12px"
></iframe>
```

---

## Socket events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `call:started` / `call:ended` | server → clients | Call lifecycle |
| `call:join-room` | client → server | Join signaling room `call:{id}` |
| `call:leave-room` | client → server | Leave signaling room |
| `webrtc:peer-joined` / `webrtc:peer-left` | server → room | Peer presence |
| `webrtc:signal` | both | Relay SDP / ICE (`offer`, `answer`, `ice-candidate`) |

---

## Env

```
JITSI_DOMAIN=meet.jit.si
# optional custom ICE (JSON array) for WebRTC
# WEBRTC_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"}]
```
