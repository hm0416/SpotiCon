# SpotiCon

SpotiCon is a desktop app that logs into your Spotify account, matches your songs or playlists to their direct YouTube video, and downloads them straight to your laptop as MP3s.

## Requirements

- macOS or Windows
- [Node.js](https://nodejs.org) 18 or later (includes `npm`)
- A free [Spotify Developer](https://developer.spotify.com/dashboard) account and app
- A free [Google Cloud](https://console.cloud.google.com/) project with the YouTube Data API v3 enabled
- (Optional, for MP3 downloads) A [RapidAPI](https://rapidapi.com/elisbushaj2/api/youtube-mp310) account subscribed to the "YouTube MP3" API

## 1. Get the code

```bash
git clone https://github.com/hm0416/spoticon.git
cd spoticon
npm install
```

## 2. Set up your API credentials

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create an app, and copy the **Client ID** (and Client Secret, optional).
2. In the app's Spotify dashboard settings, add this Redirect URI: `http://127.0.0.1:43819/callback`
3. Go to [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com), enable the **YouTube Data API v3**, and create an API key.
4. (Optional) Subscribe to the [YouTube MP3 RapidAPI](https://rapidapi.com/elisbushaj2/api/youtube-mp310) and copy your RapidAPI key to enable one-click MP3 downloads.

You'll paste these values into the app's **Settings** panel the first time you run it — nothing needs to be hardcoded.

## 3. Run it in development

```bash
npm run dev
```

This starts the Vite dev server and opens the Electron app window. Open **Settings**, paste in your Spotify Client ID, YouTube API key, and (optionally) your RapidAPI key, then click **Log in with Spotify**.

## 4. Build an installer (.dmg / .exe)

To get a standalone app you (or anyone else) can just double-click and install, build an installer for your platform:

**macOS (.dmg)** — run this on a Mac:

```bash
npm run dist:mac
```

**Windows (.exe)** — run this on a Windows machine:

```bash
npm run dist:win
```

Each command builds the app and packages it with [electron-builder](https://www.electron.build/). When it finishes, look inside the `dist/` folder in the project for:

- macOS: `SpotiCon-<version>.dmg`
- Windows: `SpotiCon Setup <version>.exe`

## 5. Install it on your laptop

**macOS**

1. Double-click the `.dmg` file to open it.
2. Drag **SpotiCon** into the `Applications` folder.
3. Since the app isn't notarized by Apple, the first time you open it macOS Gatekeeper may block it. Right-click (or Control-click) the app in `Applications` and choose **Open**, then confirm **Open** in the dialog. You only need to do this once.

**Windows**

1. Double-click the `.exe` installer.
2. If Windows SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway** (this appears because the installer isn't code-signed).
3. Follow the installer prompts. SpotiCon will be added to your Start Menu.

## Notes

- SpotiCon only requests read-only access to your Spotify playlists (`playlist-read-private`, `playlist-read-collaborative`).
- MP3 downloads are entirely optional and only run when you add a RapidAPI key and click a download button.
- Your Spotify/YouTube/RapidAPI credentials are stored locally and encrypted on your machine (via Electron's `safeStorage`) — they are never sent anywhere except the respective APIs.
