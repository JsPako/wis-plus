# WIS+ — ui (Layer 3)

React Native (Web) desktop shell for the W201 workshop assistant, wrapped in **Tauri v2**.
Runs on Arch Linux (Wayland/X11) and Windows 11. Talks to the Python sidecar on
`127.0.0.1:8321` — never the LAN.

## Stack
- `react-native-web` + `react-native-reanimated` + TypeScript, bundled by **Vite**
- Tauri v2 shell (`src-tauri/`) that **auto-spawns and auto-cleans** the backend
  sidecar (`python -m backend.main`) on startup/exit — see `src-tauri/src/main.rs`

## Setup
```bash
# from ui/
npm install
npm run icon      # regenerate src-tauri/icons from ../assets/app-icon.png
                  # (equivalent: scripts/generate-icons.sh | .ps1)
```

## Run / build
| Command         | What it does                                            |
|-----------------|---------------------------------------------------------|
| `npm run dev`   | Tauri desktop app in dev mode (Vite on :1420 + sidecar) |
| `npm run web`   | Vite only — UI in a plain browser (for layout work)     |
| `npm run build` | Typecheck + production bundle into `dist/`              |
| `npm run app:build` | Full packaged installer (AppImage/deb/rpm/msi)      |

The backend port can be overridden with `WISPLUS_PORT` (sidecar) or
`VITE_WISPLUS_API` (UI, e.g. `http://127.0.0.1:9000`).

## Layout
```
src/
├── App.tsx                    # splash → top bar + vehicle badge shell
├── index.tsx                  # RNW bootstrap + global CSS injection
├── api/client.ts              # typed fetch client for /api/*
├── components/
│   ├── SplashScreen.tsx       # WIS fade-in + springing amber "+"
│   └── ProfileModal.tsx       # engine / transmission selector (never assumes your car)
├── theme/tokens.ts            # "W201 Workshop Dark" palette + motion tokens
└── types/api.ts               # TS mirrors of shared/models.py
```
