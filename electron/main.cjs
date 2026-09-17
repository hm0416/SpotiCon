const { app, BrowserWindow, shell, ipcMain, safeStorage, dialog } = require('electron')
const crypto = require('crypto')
const fs = require('fs/promises')
const { createWriteStream } = require('fs')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const http = require('http')
const path = require('path')

const redirectUri = 'http://127.0.0.1:43819/callback'
const configPath = () => path.join(app.getPath('userData'), 'credentials.json')
let pendingAuthorization

async function readCredentials() {
  try {
    const stored = JSON.parse(await fs.readFile(configPath(), 'utf8'))
    return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, safeStorage.decryptString(Buffer.from(value, 'base64'))]))
  } catch { return {} }
}

async function writeCredentials(credentials) {
  const encrypted = Object.fromEntries(Object.entries(credentials).filter(([, value]) => value).map(([key, value]) => [key, safeStorage.encryptString(String(value)).toString('base64')]))
  await fs.writeFile(configPath(), JSON.stringify(encrypted), { mode: 0o600 })
}

const base64Url = (value) => value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const tokenRequest = async (params) => {
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  if (!response.ok) throw new Error('Spotify could not authorize this request.')
  return response.json()
}

async function spotifyAppToken(credentials) {
  if (!credentials.spotifyClientId || !credentials.spotifyClientSecret) throw new Error('Log in with Spotify, or add a Spotify Client Secret for public-link matching.')
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${credentials.spotifyClientId}:${credentials.spotifyClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!response.ok) throw new Error('Spotify rejected the configured API credentials.')
  return (await response.json()).access_token
}

async function spotifyUserToken(credentials) {
  if (!credentials.spotifyAuth) throw new Error('Log in to Spotify to view your playlists.')
  const saved = JSON.parse(credentials.spotifyAuth)
  if (saved.expiresAt > Date.now() + 30_000) return saved.accessToken
  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: credentials.spotifyClientId })
  const updated = { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || saved.refreshToken, expiresAt: Date.now() + refreshed.expires_in * 1000 }
  await writeCredentials({ ...credentials, spotifyAuth: JSON.stringify(updated) })
  return updated.accessToken
}

async function spotifyReadToken(credentials) {
  if (credentials.spotifyAuth) return spotifyUserToken(credentials)
  return spotifyAppToken(credentials)
}

async function findYouTubeMatch(track, youtubeApiKey) {
  const artist = track.artists.map(({ name }) => name).join(', ')
  const query = `${track.name} ${artist} official audio`
  const params = new URLSearchParams({ part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '1', q: query, key: youtubeApiKey })
  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
  if (!response.ok) throw new Error('YouTube could not search with the configured API key.')
  const videoId = (await response.json()).items?.[0]?.id?.videoId
  if (!videoId) throw new Error('No embeddable YouTube video was found for this track.')
  return { id: track.id, title: track.name, artist, query, spotifyLink: track.external_urls.spotify, youtubeLink: `https://www.youtube.com/watch?v=${videoId}`, artwork: track.album.images?.[1]?.url || track.album.images?.[0]?.url }
}

async function findTrackMatch(trackId) {
  const credentials = await readCredentials()
  if (!credentials.youtubeApiKey) throw new Error('Add your YouTube Data API key in Settings first.')
  const token = await spotifyReadToken(credentials)
  const response = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error('Spotify could not find that track.')
  return findYouTubeMatch(await response.json(), credentials.youtubeApiKey)
}

async function findPlaylistMatches(playlistId) {
  const playlist = await getPlaylistTracks(playlistId)
  const credentials = await readCredentials()
  const result = await matchTracks(playlist.tracks, credentials)
  return { ...result, playlistName: playlist.name, total: playlist.total, truncated: playlist.total > playlist.tracks.length }
}

async function getPlaylistTracks(playlistId) {
  const credentials = await readCredentials()
  const token = await spotifyReadToken(credentials)
  const headers = { Authorization: `Bearer ${token}` }
  const playlistResponse = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=name`, { headers })
  let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items?limit=50`
  if (!playlistResponse.ok) throw new Error('Spotify could not find that playlist.')
  const playlist = await playlistResponse.json()
  const tracks = []
  let total = 0
  while (url) {
    const response = await fetch(url, { headers })
    if (!response.ok) throw new Error('Spotify could not load this playlist’s tracks.')
    const page = await response.json()
    total = page.total
    tracks.push(...page.items.map((playlistItem) => playlistItem.item || playlistItem.track).filter((track) => track?.type === 'track' && track.id))
    url = page.next
  }
  return { name: playlist.name, total, tracks }
}

async function matchTracks(tracks, credentials) {
  if (!credentials.youtubeApiKey) throw new Error('Add your YouTube Data API key in Settings first.')
  const seen = new Set()
  const selected = tracks.filter((track) => track?.id && !seen.has(track.id) && seen.add(track.id)).slice(0, 50)
  if (!selected.length) throw new Error('Select at least one track.')
  const items = []
  const failures = []
  for (const track of selected) {
    try { items.push(await findYouTubeMatch(track, credentials.youtubeApiKey)) }
    catch (error) { failures.push(error.message || `No match for ${track.name}.`) }
  }
  return { items, failures, processed: selected.length, truncated: tracks.length > selected.length }
}

async function fetchTrackMp3(track, credentials) {
  if (!credentials.rapidApiKey) throw new Error('Add your RapidAPI key in Settings first.')
  if (!track?.youtubeLink) throw new Error('This track has no YouTube link to download.')
  const infoResponse = await fetch(`https://youtube-mp310.p.rapidapi.com/download/mp3?${new URLSearchParams({ url: track.youtubeLink })}`, {
    headers: { 'x-rapidapi-key': credentials.rapidApiKey, 'x-rapidapi-host': 'youtube-mp310.p.rapidapi.com' },
  })
  if (!infoResponse.ok) throw new Error(`The MP3 download service could not process this video (${infoResponse.status} ${infoResponse.statusText}).`)
  const { downloadUrl } = await infoResponse.json()
  if (!downloadUrl) throw new Error('The MP3 download service did not return a download link.')
  const mp3Response = await fetch(downloadUrl)
  if (!mp3Response.ok || !mp3Response.body) throw new Error('Could not download the MP3 file from the provided link.')
  return mp3Response
}

function trackFileName(track) {
  return `${[track.artist, track.title].filter(Boolean).join(' - ') || 'track'}.mp3`.replace(/[/\\?%*:|"<>]/g, '')
}

async function uniqueFilePath(destDir, fileName) {
  const ext = path.extname(fileName)
  const base = fileName.slice(0, -ext.length)
  let candidate = path.join(destDir, fileName)
  for (let attempt = 1; ; attempt++) {
    try { await fs.access(candidate); candidate = path.join(destDir, `${base} (${attempt})${ext}`) }
    catch { return candidate }
  }
}

async function downloadTrack(track) {
  const credentials = await readCredentials()
  const fileName = trackFileName(track)
  const window = BrowserWindow.getFocusedWindow()
  const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: path.join(app.getPath('downloads'), fileName), filters: [{ name: 'MP3 audio', extensions: ['mp3'] }] })
  if (canceled || !filePath) return { canceled: true }
  const mp3Response = await fetchTrackMp3(track, credentials)
  await pipeline(Readable.fromWeb(mp3Response.body), createWriteStream(filePath))
  return { canceled: false, filePath }
}

const DOWNLOAD_CONCURRENCY = 8

async function downloadTracksBatch(tracks, event) {
  const credentials = await readCredentials()
  if (!credentials.rapidApiKey) throw new Error('Add your RapidAPI key in Settings first.')
  const window = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder for the downloaded MP3s' })
  if (canceled || !filePaths[0]) return { canceled: true }
  const destDir = filePaths[0]
  const queue = [...tracks]
  const total = queue.length
  let cursor = 0
  let completed = 0
  const results = []
  async function worker() {
    while (cursor < queue.length) {
      const track = queue[cursor++]
      event.sender.send('tracks:download-progress', { id: track.id, status: 'downloading', total, completed })
      try {
        const mp3Response = await fetchTrackMp3(track, credentials)
        const filePath = await uniqueFilePath(destDir, trackFileName(track))
        await pipeline(Readable.fromWeb(mp3Response.body), createWriteStream(filePath))
        results.push({ id: track.id, ok: true, filePath })
        completed += 1
        event.sender.send('tracks:download-progress', { id: track.id, status: 'done', filePath, total, completed })
      } catch (error) {
        results.push({ id: track.id, ok: false, error: error.message })
        completed += 1
        event.sender.send('tracks:download-progress', { id: track.id, status: 'error', error: error.message, total, completed })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, worker))
  return { canceled: false, destDir, results }
}

async function getUserPlaylists() {
  const credentials = await readCredentials()
  const token = await spotifyUserToken(credentials)
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50'
  const playlists = []
  while (url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error('Spotify could not load your playlists.')
    const page = await response.json()
    playlists.push(...page.items.filter((item) => item?.id).map((item) => ({ id: item.id, name: item.name || 'Untitled playlist', total: item.tracks?.total ?? item.items?.total ?? 0, artwork: item.images?.[0]?.url, spotifyLink: item.external_urls?.spotify })))
    url = page.next
  }
  return playlists
}

async function completeAuthorization(url) {
  const callback = new URL(url)
  if (callback.pathname !== '/callback' || !pendingAuthorization) return
  const { code, state, error } = Object.fromEntries(callback.searchParams)
  const pending = pendingAuthorization
  pendingAuthorization = undefined
  pending.callbackServer.close()
  if (error || !code || state !== pending.state) return pending.reject(new Error(error || 'Spotify login was cancelled or could not be verified.'))
  try {
    const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: pending.clientId, code_verifier: pending.verifier })
    const credentials = await readCredentials()
    const auth = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 }
    await writeCredentials({ ...credentials, spotifyAuth: JSON.stringify(auth) })
    pending.resolve({ connected: true })
  } catch (error) { pending.reject(error) }
}

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const callbackUrl = new URL(request.url, redirectUri)
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<h2>Spotify is connected.</h2><p>You can close this tab and return to SpotiCon.</p>')
      completeAuthorization(callbackUrl.toString())
    })
    server.once('error', reject)
    server.listen(43819, '127.0.0.1', () => { server.off('error', reject); resolve(server) })
  })
}

ipcMain.handle('credentials:status', async () => {
  const credentials = await readCredentials()
  return { configured: Boolean(credentials.spotifyClientId && credentials.youtubeApiKey), connected: Boolean(credentials.spotifyAuth), downloadConfigured: Boolean(credentials.rapidApiKey) }
})
ipcMain.handle('spotify:logout', async () => {
  const credentials = await readCredentials()
  delete credentials.spotifyAuth
  await writeCredentials(credentials)
  return { connected: false }
})
ipcMain.handle('credentials:save', async (_event, values) => {
  if (!values.spotifyClientId?.trim() || !values.youtubeApiKey?.trim()) throw new Error('Spotify Client ID and YouTube API key are required.')
  const credentials = await readCredentials()
  await writeCredentials({ ...credentials, spotifyClientId: values.spotifyClientId.trim(), spotifyClientSecret: values.spotifyClientSecret?.trim(), youtubeApiKey: values.youtubeApiKey.trim(), rapidApiKey: values.rapidApiKey?.trim() })
  return { configured: true }
})
ipcMain.handle('spotify:login', async () => {
  const credentials = await readCredentials()
  if (!credentials.spotifyClientId) throw new Error('Add your Spotify Client ID in Settings first.')
  if (pendingAuthorization) throw new Error('Spotify login is already waiting for approval.')
  const verifier = base64Url(crypto.randomBytes(64))
  const state = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  const params = new URLSearchParams({ client_id: credentials.spotifyClientId, response_type: 'code', redirect_uri: redirectUri, code_challenge_method: 'S256', code_challenge: challenge, state, scope: 'playlist-read-private playlist-read-collaborative' })
  const callbackServer = await startCallbackServer()
  const promise = new Promise((resolve, reject) => { pendingAuthorization = { resolve, reject, verifier, state, clientId: credentials.spotifyClientId, callbackServer }; setTimeout(() => { if (pendingAuthorization) { pendingAuthorization.callbackServer.close(); pendingAuthorization = undefined; reject(new Error('Spotify login timed out. Please try again.')) } }, 300_000) })
  await shell.openExternal(`https://accounts.spotify.com/authorize?${params}`)
  return promise
})
ipcMain.handle('spotify:playlists', getUserPlaylists)
ipcMain.handle('track:find-match', (_event, trackId) => findTrackMatch(trackId))
ipcMain.handle('playlist:find-matches', (_event, playlistId) => findPlaylistMatches(playlistId))
ipcMain.handle('playlist:tracks', (_event, playlistId) => getPlaylistTracks(playlistId))
ipcMain.handle('tracks:find-matches', async (_event, tracks) => matchTracks(Array.isArray(tracks) ? tracks : [], await readCredentials()))
ipcMain.handle('track:download', (_event, track) => downloadTrack(track))
ipcMain.handle('tracks:download', (event, tracks) => downloadTracksBatch(Array.isArray(tracks) ? tracks : [], event))

function createWindow() {
  const window = new BrowserWindow({ width: 1000, height: 720, minWidth: 760, minHeight: 560, backgroundColor: '#101111', titleBarStyle: 'hiddenInset', webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') } })
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
  window.loadURL(app.isPackaged ? `file://${path.join(__dirname, '../dist/index.html')}` : devUrl)
  window.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
