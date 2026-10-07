# CamWave — Live Video Chat Rooms

Camfrog-style live video chat rooms: room directory, WebRTC video/audio (mesh),
push-to-talk + open-mic with talk timers, text chat, contacts + 1-on-1 DMs,
tiered moderation (owner › admin › moderator: mute, kick, ban, IP-ban), and DJ
music mode. English-only UI. No database — all state is in memory.

## Run locally

```bash
npm install
npm start        # serves on http://localhost:3000 (PORT env overrides)
```

## Deploy on Render (free)

Render's free tier runs this with no credit card. The free tier sleeps after
~15 minutes with no traffic (first visitor waits ~30s for it to wake) and
**in-memory state resets on sleep/restart** — rooms, bans, contacts and DMs
start fresh. That's expected for this build.

1. Push this folder to a GitHub repo (e.g. `camwave-video-chat`).
2. Go to [render.com](https://render.com) and sign up free (no card needed).
3. Dashboard → **New +** → **Web Service** → connect your GitHub account and
   pick the repo.
4. Configure:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
5. Click **Deploy**. When it's live you get a public URL like
   `https://camwave-video-chat.onrender.com` — share it anywhere; anyone with
   the link can open it in a browser and join. No install, no signup.

### Notes for going public
- The room creator is automatically the **owner** with full mod powers.
- Video calls connect peer-to-peer via WebRTC (free STUN). A small share of
  users behind strict networks may need a TURN relay, which isn't free —
  most will connect fine without it.
- Running a public video chat means **you** own moderation and the basics:
  terms of service, and keeping minors safe. Use the ban/IP-ban tools.

## Project layout

```
package.json        npm start → node server.js (PORT from env, node ≥18)
server.js           static file server + WebSocket signaling + moderation
public/
  index.html        app shell + Open Graph/Twitter preview meta tags
  style.css         vibrant dark theme
  app.js            vanilla JS client: rooms, WebRTC mesh, chat, DMs, DJ
  icon.svg / icon-*.png / favicon-32.png   branding
  og-image.png      social share preview image
```

Only dependency: [`ws`](https://www.npmjs.com/package/ws) (WebSocket server).
No API keys or secrets anywhere in this project.
