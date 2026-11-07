// Where the Madovai backend (the API this app talks to) lives. Change this one line to point the app at another server.
//   - external address (the default):    https://madovai.gab8bit.net/api/v1
//   - same-origin behind a reverse proxy: /madovai/api/v1   (relative paths are resolved against this page)
// The backend must allow this app's origin in its CORS settings (CORS_ORIGINS, default "*").
window.MADOVAI_CONFIG = {
  apiBase: 'https://madovai.gab8bit.net/api/v1',
};
