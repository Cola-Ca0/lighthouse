# Lighthouse · 灯塔

[中文说明](README.zh-CN.md) · **English**

> A desktop AI assistant that speaks plain language — chat with it, and it actually handles your files.

Built for people who are *not* good with computers: no settings panel, no terminal, no jargon.
Open it and you get a chat window. Talk to it like you'd text a friend.

## What it does

- **Chat** — study questions, writing, lookups (web search is available through the built-in work engine)
- **Handle documents** — drag a Word / Excel / PowerPoint / image file into the window and say what you want
  - Read, create, rewrite. Output always lands in the workspace's `成品/` (finished-goods) folder; **your originals are never modified**
- **Read images** — drop a picture in and ask "what does this say?"
- **Asks before acting** — anything that creates, changes or deletes a file shows you the plan first; it only runs after you click "go ahead"
- **Learn your rules** — say "reply shorter from now on" and it writes that into the workspace's rules file itself

## Getting started

```bash
npm install

# 1) Provide an API key: create config.json in the project root
echo '{ "apiKey": "your-deepseek-api-key" }' > config.json
#    (falls back to ~/.dsh/settings.json — see readKey() in main.js)

# 2) The work engine needs a real Node (console-subsystem), not Electron's node mode.
#    Grab a win-x64 build from https://npmmirror.com/mirrors/node/ and put node.exe in runtime/
mkdir -p runtime && cp /path/to/node.exe runtime/

npm start
```

Before launching, run `unset ELECTRON_RUN_AS_NODE` if that variable is set globally —
Electron would otherwise start in plain Node mode and no window would appear.

## Building

```bash
# Behind the GFW you need both mirrors
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win nsis
```

Provide these three before packaging (they are not in the repo — see below):

| File | Notes |
|---|---|
| `runtime/node.exe` | Runtime for the work engine (~92 MB, download from the mirror above) |
| `src/assets/avatar.png` | Assistant avatar; falls back to the letter "C" when missing |
| `build/icon.ico` / `icon.png` | App icon (can be generated from the avatar with Pillow, multiple sizes) |

## How it's put together

```
Electron shell (frameless window)
├─ Chat   → talks straight to the DeepSeek API (streaming)
├─ Work   → spawns a bundled headless DSH agent:
│            it has file read/write, shell and web-search tools, fenced to the workspace
└─ Tools  → tools/office.js: docx/xlsx/pptx read & write (Node, no external installs)
```

- Workspace (the fence): `./workspace` in dev, `Documents/灯塔工作区` when packaged
- Data: chat log / memory / wallpaper live in the user-data dir; **the engine's config tree lives inside the app too** (`DSH_HOME`), never touching `~/.dsh`
- Rules file: `workspace/AGENTS.md` — the user can edit it any time; both the chat and the work engine read it

## Not in this repo (on purpose)

- `config.json` (API key), `data/` (chat logs), `workspace/` (user files), `dsh-home/` (engine state)
- `runtime/` (third-party binary), avatar and icons (**copyrighted assets**)

> Shipped installers embed the API key — anyone who has the file can extract it.
> Always set a spending cap on the key.

## License

MIT
