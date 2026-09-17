import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const spotifyPattern = /^https?:\/\/(?:open\.)?spotify\.com\/(track|playlist)\/([A-Za-z0-9]+)(?:[/?].*)?$/i
const spotifyLinkInfo = (value) => {
  const match = value.trim().match(spotifyPattern)
  return match ? { kind: match[1], id: match[2] } : null
}

function App() {
  const [spotifyUrl, setSpotifyUrl] = useState('')
  const [matches, setMatches] = useState([])
  const [message, setMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [playlists, setPlaylists] = useState([])
  const [showPlaylists, setShowPlaylists] = useState(false)
  const [activePlaylist, setActivePlaylist] = useState(null)
  const [selectedTrackIds, setSelectedTrackIds] = useState([])
  const [credentials, setCredentials] = useState({ spotifyClientId: '', spotifyClientSecret: '', youtubeApiKey: '', rapidApiKey: '' })
  const [downloadConfigured, setDownloadConfigured] = useState(false)
  const [trackStatus, setTrackStatus] = useState({})
  const [selectedMatchIds, setSelectedMatchIds] = useState([])
  const [batchProgress, setBatchProgress] = useState(null)
  const [etaSeconds, setEtaSeconds] = useState(null)
  const [, forceTick] = useState(0)
  const [theme, setTheme] = useState(() => localStorage.getItem('spoticon-theme') || 'light')
  const desktopApi = window.trackFinder

  useEffect(() => {
    if (!desktopApi) return setMessage('This page is the desktop app interface. Run npm run dev to open it in SpotiCon.')
    desktopApi.credentialStatus().then(({ configured, connected, downloadConfigured }) => { setIsConfigured(configured); setIsConnected(connected); setDownloadConfigured(downloadConfigured) })
  }, [desktopApi])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('spoticon-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!batchProgress) return
    const id = setInterval(() => {
      forceTick((tick) => tick + 1)
      setEtaSeconds((current) => (current === null ? null : Math.max(0, current - 1)))
    }, 1000)
    return () => clearInterval(id)
  }, [batchProgress])

  useEffect(() => {
    if (!desktopApi) return
    return desktopApi.onDownloadProgress(({ id, status, total, completed }) => {
      setTrackStatus((current) => ({ ...current, [id]: status }))
      if (typeof total !== 'number') return
      setBatchProgress((current) => {
        const startedAt = current?.startedAt || Date.now()
        if (!current || completed > current.completed) {
          const remaining = total - completed
          const elapsedMs = Date.now() - startedAt
          setEtaSeconds(completed > 0 && remaining > 0 ? Math.round(((elapsedMs / completed) * remaining) / 1000) : null)
        }
        return { total, completed, startedAt }
      })
    })
  }, [desktopApi])

  function formatEta(seconds) {
    if (seconds === null || seconds === undefined) return 'Estimating time remaining…'
    if (seconds <= 0) return 'Finishing up…'
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `About ${minutes > 0 ? `${minutes}m ` : ''}${secs}s remaining`
  }

  function batchFillPercent(progress) {
    const remaining = progress.total - progress.completed
    const inProgress = Math.min(remaining, Object.values(trackStatus).filter((status) => status === 'downloading').length)
    return Math.max(4, Math.round(((progress.completed + inProgress * 0.5) / progress.total) * 100))
  }

  function addMatches(items, { autoSelect = false } = {}) {
    setMatches((current) => [...items, ...current.filter((existing) => !items.some((item) => item.id === existing.id))])
    if (autoSelect && items.length) setSelectedMatchIds((current) => [...new Set([...items.map((item) => item.id), ...current])])
  }

  async function importPlaylist(playlistId, { download = false } = {}) {
    setIsLoading(true)
    setMessage('Matching this playlist to YouTube…')
    try {
      const result = await desktopApi.findPlaylistMatches(playlistId)
      addMatches(result.items, { autoSelect: true })
      setShowPlaylists(false)
      setActivePlaylist(null)
      const failureNote = result.failures?.length ? ` ${result.failures.length} searches failed: ${result.failures[0]}` : ''
      setMessage(`${result.playlistName}: matched ${result.items.length} of ${result.processed} songs.${result.truncated ? ' Only the first 50 were processed.' : ''}${failureNote}`)
      if (download && result.items.length) await downloadTracksList(result.items)
    } catch (error) { setMessage(error.message || 'Could not import that playlist.') } finally { setIsLoading(false) }
  }

  async function openPlaylist(playlist) {
    setIsLoading(true)
    setMessage(`Loading ${playlist.name}…`)
    try {
      const loaded = await desktopApi.playlistTracks(playlist.id)
      setActivePlaylist(loaded)
      setSelectedTrackIds(loaded.tracks.map((track) => track.id))
      setShowPlaylists(false)
      setMessage(`${loaded.name}: select the tracks you want to match.`)
    } catch (error) { setMessage(error.message || 'Could not load that playlist.') } finally { setIsLoading(false) }
  }

  function toggleTrack(trackId) {
    setSelectedTrackIds((current) => current.includes(trackId) ? current.filter((id) => id !== trackId) : [...current, trackId])
  }

  async function generateSelectedTracks() {
    if (!selectedTrackIds.length) return setMessage('Select at least one track first.')
    const selectedTracks = activePlaylist?.tracks.filter((track) => selectedTrackIds.includes(track.id)) || []
    setIsLoading(true)
    setShowPlaylists(false)
    setActivePlaylist(null)
    setMessage(`Matching ${selectedTrackIds.length} selected songs to YouTube…`)
    try {
      const result = await desktopApi.findTracksMatches(selectedTracks)
      addMatches(result.items, { autoSelect: true })
      const failureNote = result.failures.length ? ` ${result.failures.length} searches failed: ${result.failures[0]}` : ''
      setMessage(`Matched ${result.items.length} of ${result.processed} selected songs.${result.truncated ? ' Only the first 50 selected songs were processed.' : ''}${failureNote}`)
    } catch (error) { setMessage(error.message || 'Could not match those songs.') } finally { setIsLoading(false) }
  }

  async function saveCredentials(event) {
    event.preventDefault()
    if (!desktopApi) return setMessage('Credential setup is available only inside the SpotiCon desktop app.')
    try {
      await desktopApi.saveCredentials(credentials)
      setIsConfigured(true)
      setDownloadConfigured(Boolean(credentials.rapidApiKey?.trim()))
      setShowSettings(false)
      setMessage('Credentials saved securely. Log in with Spotify to load your playlists.')
    } catch (error) { setMessage(error.message) }
  }

  async function downloadTrack(item) {
    if (!desktopApi) return
    if (!downloadConfigured) { setShowSettings(true); return setMessage('Add your RapidAPI key in Settings to enable MP3 downloads.') }
    setTrackStatus((current) => ({ ...current, [item.id]: 'downloading' }))
    setMessage(`Downloading “${item.title}”…`)
    try {
      const result = await desktopApi.downloadTrack(item)
      setTrackStatus((current) => ({ ...current, [item.id]: result.canceled ? undefined : 'done' }))
      setMessage(result.canceled ? 'Download canceled.' : `Saved “${item.title}” to ${result.filePath}.`)
    } catch (error) {
      setTrackStatus((current) => ({ ...current, [item.id]: 'error' }))
      setMessage(error.message || 'Could not download this track.')
    }
  }

  function toggleMatchSelection(trackId) {
    setSelectedMatchIds((current) => current.includes(trackId) ? current.filter((id) => id !== trackId) : [...current, trackId])
  }

  async function downloadTracksList(tracksToDownload) {
    if (!desktopApi) return
    if (!downloadConfigured) { setShowSettings(true); return setMessage('Add your RapidAPI key in Settings to enable MP3 downloads.') }
    if (!tracksToDownload.length) return setMessage('Select at least one track to download.')
    setIsLoading(true)
    setBatchProgress({ total: tracksToDownload.length, completed: 0, startedAt: Date.now() })
    setMessage(`Choose a folder, then downloading ${tracksToDownload.length} tracks (up to 8 at a time)…`)
    try {
      const result = await desktopApi.downloadTracks(tracksToDownload)
      if (result.canceled) { setMessage('Download canceled.'); return }
      const failed = result.results.filter((entry) => !entry.ok).length
      setMessage(`Saved ${result.results.length - failed} of ${result.results.length} tracks to ${result.destDir}.${failed ? ` ${failed} failed.` : ''}`)
      setSelectedMatchIds((current) => current.filter((id) => !tracksToDownload.some((track) => track.id === id)))
    } catch (error) { setMessage(error.message || 'Could not download the selected tracks.') } finally { setIsLoading(false); setBatchProgress(null); setEtaSeconds(null) }
  }

  function downloadSelectedTracks() {
    return downloadTracksList(matches.filter((item) => selectedMatchIds.includes(item.id)))
  }

  async function downloadPlaylist(playlist) {
    if (!desktopApi) return
    if (!downloadConfigured) { setShowSettings(true); return setMessage('Add your RapidAPI key in Settings to enable MP3 downloads.') }
    await importPlaylist(playlist.id, { download: true })
  }

  async function loginToSpotify() {
    if (!desktopApi) return setMessage('Spotify login is available only in the SpotiCon desktop app.')
    if (!isConfigured) { setShowSettings(true); return setMessage('Add your Spotify Client ID and YouTube API key first.') }
    setIsLoading(true)
    setMessage('Your browser will open so you can approve Spotify access…')
    try {
      await desktopApi.loginToSpotify()
      setIsConnected(true)
      setMessage('Spotify connected. You can now load all of your playlists.')
    } catch (error) { setMessage(error.message || 'Spotify login could not be completed.') } finally { setIsLoading(false) }
  }

  async function logoutFromSpotify() {
    if (!desktopApi) return
    setIsLoading(true)
    try {
      await desktopApi.logoutFromSpotify()
      setIsConnected(false)
      setPlaylists([])
      setShowPlaylists(false)
      setActivePlaylist(null)
      setMessage('Logged out of Spotify.')
    } catch (error) { setMessage(error.message || 'Could not log out of Spotify.') } finally { setIsLoading(false) }
  }

  async function loadPlaylists() {
    if (!isConnected) return loginToSpotify()
    setIsLoading(true)
    setMessage('Loading your Spotify playlists…')
    try {
      const list = await desktopApi.userPlaylists()
      setPlaylists(list)
      setShowPlaylists(true)
      setMessage(`Loaded ${list.length} playlists.`)
    } catch (error) { setMessage(error.message || 'Could not load your playlists.') } finally { setIsLoading(false) }
  }

  async function findOnYouTube(event) {
    event.preventDefault()
    const linkInfo = spotifyLinkInfo(spotifyUrl)
    if (!linkInfo) return setMessage('Paste a public Spotify song or playlist link.')
    if (!desktopApi) return setMessage('Open SpotiCon (the Electron window) to find and download songs.')
    if (!isConfigured) { setShowSettings(true); return setMessage('Add your API credentials to enable song matching.') }
    if (linkInfo.kind === 'playlist') { await importPlaylist(linkInfo.id); setSpotifyUrl(''); return }
    setIsLoading(true)
    setMessage('Getting the exact artist and title, then finding the best YouTube match…')
    try {
      addMatches([await desktopApi.findMatch(linkInfo.id)], { autoSelect: true })
      setMessage('Match ready — download it below.')
      setSpotifyUrl('')
    } catch (error) { setMessage(error.message || 'Could not match that song.') } finally { setIsLoading(false) }
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">↗</span> SpotiCon</div><div className="header-actions"><div className="status"><i className={isConnected ? '' : 'offline'} /> {isConnected ? 'Spotify connected' : 'Spotify not connected'}</div><button className="settings-button theme-toggle" onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')} aria-label="Toggle dark mode">{theme === 'light' ? '🌙 Dark' : '☀️ Light'}</button>{isConnected && <button className="settings-button" onClick={logoutFromSpotify} disabled={isLoading}>Log out</button>}<button className="settings-button" onClick={() => setShowSettings((open) => !open)}>Settings</button></div></header>
    <section className="hero"><p className="eyebrow">SPOTIFY → MP3</p><h1>Your playlists.<br />Downloaded as MP3s.</h1><p className="lede">Log in to Spotify, pick any songs or playlists, and SpotiCon matches them to YouTube and saves them straight to your laptop as MP3s.</p><div className="hero-actions"><button className="primary small-primary" onClick={loginToSpotify} disabled={isLoading || isConnected}>{isConnected ? 'Spotify connected' : 'Log in with Spotify'}</button><button className="settings-button" onClick={loadPlaylists} disabled={isLoading}>{showPlaylists ? 'Refresh playlists' : 'Show my playlists'}</button></div></section>
    {showSettings && <section className="settings-card"><button className="panel-close" onClick={() => setShowSettings(false)} aria-label="Close settings">×</button><div><p className="eyebrow">ONE-TIME SETUP</p><h2>Connect your API keys</h2><p>Add <code>http://127.0.0.1:43819/callback</code> as a Redirect URI in your Spotify app dashboard before logging in.</p></div><form onSubmit={saveCredentials}><label>Spotify Client ID<input value={credentials.spotifyClientId} onChange={(event) => setCredentials({ ...credentials, spotifyClientId: event.target.value })} required /></label><label>Spotify Client Secret <em>optional</em><input type="password" value={credentials.spotifyClientSecret} onChange={(event) => setCredentials({ ...credentials, spotifyClientSecret: event.target.value })} /></label><label>YouTube Data API key<input type="password" value={credentials.youtubeApiKey} onChange={(event) => setCredentials({ ...credentials, youtubeApiKey: event.target.value })} required /></label><label>RapidAPI key <em>optional, enables MP3 downloads</em><input type="password" value={credentials.rapidApiKey} onChange={(event) => setCredentials({ ...credentials, rapidApiKey: event.target.value })} /></label><button className="primary" type="submit">Save credentials</button></form><p className="setup-links"><a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Create Spotify app ↗</a><a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">Enable YouTube Data API ↗</a><a href="https://rapidapi.com/elisbushaj2/api/youtube-mp310" target="_blank" rel="noreferrer">Get a RapidAPI key ↗</a></p></section>}
    {showPlaylists && <section className="playlist-card"><div className="section-heading"><div><p className="eyebrow">MY SPOTIFY</p><h2>{playlists.length} playlists</h2></div></div><div className="playlist-grid">{playlists.map((playlist) => <article className="playlist" key={playlist.id}>{playlist.artwork ? <img src={playlist.artwork} alt="" /> : <div className="playlist-art">♫</div>}<div><h3>{playlist.name}</h3><p>{playlist.total} tracks</p></div><div className="playlist-actions"><button className="ghost import-button" disabled={isLoading} onClick={() => openPlaylist(playlist)}>View songs →</button>{downloadConfigured && <button className="ghost import-button" disabled={isLoading} onClick={() => downloadPlaylist(playlist)}>Download all ↓</button>}</div></article>)}</div></section>}
    {activePlaylist && <section className="playlist-card track-picker"><div className="section-heading"><div><p className="eyebrow">PLAYLIST TRACKS</p><h2>{activePlaylist.name}</h2><p className="picker-count">{selectedTrackIds.length} of {activePlaylist.tracks.length} selected</p></div><button className="ghost" onClick={() => { setActivePlaylist(null); setShowPlaylists(true) }}>← All playlists</button></div><div className="picker-actions"><label><input type="checkbox" checked={selectedTrackIds.length === activePlaylist.tracks.length} onChange={(event) => setSelectedTrackIds(event.target.checked ? activePlaylist.tracks.map((track) => track.id) : [])} /> Select all</label><button className="primary small-primary" disabled={isLoading || !selectedTrackIds.length} onClick={generateSelectedTracks}>Match {selectedTrackIds.length} songs →</button></div><div className="song-list">{activePlaylist.tracks.map((track, index) => <label className="song-choice" key={track.id}><input type="checkbox" checked={selectedTrackIds.includes(track.id)} onChange={() => toggleTrack(track.id)} /><span className="track-number">{String(index + 1).padStart(2, '0')}</span>{track.album.images?.[2]?.url ? <img src={track.album.images[2].url} alt="" /> : <span className="song-art">♫</span>}<span><strong>{track.name}</strong><small>{track.artists.map((artist) => artist.name).join(', ')}</small></span></label>)}</div></section>}
    <section className="add-card" aria-label="Find and download Spotify tracks"><form onSubmit={findOnYouTube}><label htmlFor="spotify-link">Or paste a Spotify song or playlist link</label><div className="input-row"><input id="spotify-link" type="url" value={spotifyUrl} onChange={(event) => { setSpotifyUrl(event.target.value); setMessage('') }} placeholder="https://open.spotify.com/track/… or /playlist/…" autoComplete="off" disabled={isLoading} /><button type="submit" className="primary" disabled={isLoading}>{isLoading ? 'Matching…' : 'Find matches'}</button></div></form><p className={message ? 'notice' : 'hint'} aria-live="polite">{message || 'Playlist imports process up to 50 songs at a time. Add a RapidAPI key in Settings to download MP3s in one click.'}</p></section>
    <section className="library"><div className="section-heading"><div><p className="eyebrow">READY TO DOWNLOAD</p><h2>{matches.length ? `${matches.length} ${matches.length === 1 ? 'song' : 'songs'} matched` : 'Nothing matched yet'}</h2></div><button className="ghost" onClick={() => setMatches([])} disabled={!matches.length}>Clear all</button></div>
      {matches.length > 0 && <div className="picker-actions"><label><input type="checkbox" checked={selectedMatchIds.length === matches.length} onChange={(event) => setSelectedMatchIds(event.target.checked ? matches.map((item) => item.id) : [])} /> Select all</label><button className="primary small-primary" disabled={isLoading || !selectedMatchIds.length} onClick={downloadSelectedTracks}>Download {selectedMatchIds.length} selected →</button></div>}
      {batchProgress && <div className="progress-panel"><div className="progress-bar"><div className="progress-fill" style={{ width: `${batchFillPercent(batchProgress)}%` }} /></div><div className="progress-meta"><span>{batchProgress.completed} / {batchProgress.total} downloaded</span><span>{formatEta(etaSeconds)}</span></div></div>}
      {matches.length === 0 ? <div className="empty"><div className="empty-icon">♫</div><h3>Your matched songs will show up here.</h3><p>Log in to Spotify or paste a public track link to get started.</p></div> : <div className="queue">{matches.map((item, index) => <article className="track" key={item.id}><input type="checkbox" checked={selectedMatchIds.includes(item.id)} onChange={() => toggleMatchSelection(item.id)} /><span className="track-number">{String(index + 1).padStart(2, '0')}</span>{item.artwork ? <img className="art artwork" src={item.artwork} alt="" /> : <div className="art">♫</div>}<div className="track-copy"><h3>{item.title}</h3><p>{item.artist}</p></div><div className="track-actions"><a className="spotify-link" href={item.spotifyLink} target="_blank" rel="noreferrer">Spotify ↗</a><a className="open-link" href={item.youtubeLink} target="_blank" rel="noreferrer">Open video ↗</a><button className="ghost download-button" disabled={trackStatus[item.id] === 'downloading'} onClick={() => downloadTrack(item)}>{trackStatus[item.id] === 'downloading' ? 'Downloading…' : trackStatus[item.id] === 'done' ? 'Saved ✓' : trackStatus[item.id] === 'error' ? 'Retry download' : 'Download MP3'}</button></div></article>)}</div>}</section>
    <footer>SpotiCon only requests read-only access to your Spotify playlists. MP3 downloads only happen when you add a RapidAPI key and choose to download a song.</footer>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
