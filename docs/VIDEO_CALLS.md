# Pod video calls + Jitsi React SDK

Frontend should embed with [@jitsi/react-sdk](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-react-sdk) — **do not redirect**.

## Why you see “Waiting for the moderator”

Public `meet.jit.si` often blocks anonymous room starts. The starter needs a **moderator JWT**.

StudySync mints that JWT when you configure **8x8 JaaS** or a **self-hosted Jitsi** secret.

---

## Backend response (Jitsi)

`POST /api/workspaces/:groupId/calls` with `{ "provider": "jitsi" }`:

```json
{
  "call": {
    "id": "...",
    "provider": "jitsi",
    "roomName": "StudySynccs101abc",
    "domain": "8x8.vc",
    "appId": "vpaas-magic-cookie-...",
    "jwt": "eyJ...",
    "roomUrl": "https://8x8.vc/StudySynccs101abc?jwt=eyJ...",
    "joinUrl": "https://8x8.vc/StudySynccs101abc?jwt=eyJ...",
    "moderator": true,
    "jwtConfigured": true,
    "embed": {
      "mode": "jaas",
      "jwt": "eyJ...",
      "roomUrl": "...",
      "reactSdk": {
        "component": "JaaSMeeting",
        "appId": "vpaas-magic-cookie-...",
        "roomName": "StudySynccs101abc",
        "jwt": "eyJ...",
        "userInfo": { "displayName": "Ada", "email": "ada@..." },
        "configOverwrite": { "prejoinPageEnabled": false, "disableDeepLinking": true }
      }
    }
  }
}
```

- **Starter** → `moderator: true` + moderator JWT  
- **Joiner** (`POST .../join`) → participant JWT (`moderator: false` unless they are the starter)

If `jwtConfigured: false`, you are still on anonymous `meet.jit.si` and the lobby/moderator wait will persist.

---

## Env (Render / `.env`)

### Option A — 8x8 JaaS (recommended for React SDK `JaaSMeeting`)

```
JITSI_DOMAIN=8x8.vc
JAAS_APP_ID=vpaas-magic-cookie-xxxxxxxx
JAAS_API_KEY_ID=your-api-key-id
JAAS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Or `JAAS_PRIVATE_KEY_PATH=/path/to/key.pem`

### Option B — Self-hosted Jitsi (HS256)

```
JITSI_DOMAIN=jitsi.yourschool.edu
JITSI_APP_ID=studysync
JITSI_JWT_SECRET=long-random-secret
```

(Your Prosody must enable JWT auth with the same app id/secret.)

### Not enough alone

```
JITSI_DOMAIN=meet.jit.si
```

…without JAAS/JWT keys → no moderator token → “waiting for moderator”.

---

## Frontend (`@jitsi/react-sdk`)

```bash
npm install @jitsi/react-sdk
```

```jsx
import { JitsiMeeting, JaaSMeeting } from '@jitsi/react-sdk'

const sdk = call.embed.reactSdk

{sdk.component === 'JaaSMeeting' ? (
  <JaaSMeeting
    appId={sdk.appId}
    roomName={sdk.roomName}
    jwt={sdk.jwt}
    userInfo={sdk.userInfo}
    configOverwrite={sdk.configOverwrite}
    interfaceConfigOverwrite={sdk.interfaceConfigOverwrite}
    getIFrameRef={(iframe) => {
      iframe.style.height = '70vh'
      iframe.style.width = '100%'
    }}
  />
) : (
  <JitsiMeeting
    domain={sdk.domain}
    roomName={sdk.roomName}
    jwt={sdk.jwt}
    userInfo={sdk.userInfo}
    configOverwrite={sdk.configOverwrite}
    interfaceConfigOverwrite={sdk.interfaceConfigOverwrite}
    getIFrameRef={(iframe) => {
      iframe.style.height = '70vh'
      iframe.style.width = '100%'
    }}
  />
)}
```

Pass `jwt={call.jwt}` always when present.

---

## Camera error `gum.general`

Still requires HTTPS (or localhost), camera permission, and nothing else using the webcam. Separate from moderator JWT.

---

## WebRTC fallback

`{ "provider": "webrtc" }` uses in-app Socket.IO signaling (`call:join-room`, `webrtc:signal`) — no Jitsi JWT. See signaling section in older notes / `socket.js`.
