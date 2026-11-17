# Madovai monorepo

One repo, one folder per platform: `iOS/` (SwiftUI, xcodegen), `Android/` (Kotlin/Compose), `Web/` (PWA, static), `Backend/` (Node/TS/Fastify in Docker), `docs/` (GitHub Pages: hub + `ios/` + `android/`). Each folder has its own README and `.gitignore`; build and run commands are run from inside that folder.

- The old per-platform paths `~/Git-Projects/Madovai-{iOS,Android,Web,Backend}` are symlinks to these folders (kept so older Claude Code chats keep working).
- Releases: tags are prefixed per platform (`ios-vX.Y.Z`, `android-vX.Y.Z`, `web-…`, `backend-…`). When platforms ship together, one GitHub release carries all assets. iOS asset is always named `Madovai.ipa`; Android assets are versioned (`Madovai-vX.Y.Z.apk`). The Pages download buttons resolve the newest release containing each file type — never hardcode a version or `releases/latest/download/...`.
- Never commit secrets: Android keystore lives in iCloud, Backend `.env`/`secrets/`/`data/` and Web `config.php`/`data/` are gitignored.
