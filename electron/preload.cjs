const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('trackFinder', {
  credentialStatus: () => ipcRenderer.invoke('credentials:status'),
  saveCredentials: (credentials) => ipcRenderer.invoke('credentials:save', credentials),
  findMatch: (trackId) => ipcRenderer.invoke('track:find-match', trackId),
  findPlaylistMatches: (playlistId) => ipcRenderer.invoke('playlist:find-matches', playlistId),
  loginToSpotify: () => ipcRenderer.invoke('spotify:login'),
  logoutFromSpotify: () => ipcRenderer.invoke('spotify:logout'),
  userPlaylists: () => ipcRenderer.invoke('spotify:playlists'),
  playlistTracks: (playlistId) => ipcRenderer.invoke('playlist:tracks', playlistId),
  findTracksMatches: (trackIds) => ipcRenderer.invoke('tracks:find-matches', trackIds),
  downloadTrack: (track) => ipcRenderer.invoke('track:download', track),
  downloadTracks: (tracks) => ipcRenderer.invoke('tracks:download', tracks),
  onDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('tracks:download-progress', listener)
    return () => ipcRenderer.removeListener('tracks:download-progress', listener)
  },
})
