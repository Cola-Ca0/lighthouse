// Lighthouse · 灯塔 — 主进程
// 职责只有三件：开窗、给 key、窗口控制。
// API 调用在前端直连（DeepSeek 开放 CORS，2026-09-18 参考 yif2012 项目验证）。
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

// 工作区（围栏）：AI 只被允许碰这个文件夹——打包后落用户文档目录，开发态在项目内
const WORKSPACE = app.isPackaged
  ? path.join(app.getPath('documents'), '灯塔工作区')
  : path.join(__dirname, 'workspace')

// 应用数据目录（聊天记录 / 记忆小抄）：开发态在项目内，打包后落用户数据目录
const DATA_DIR = app.isPackaged ? app.getPath('userData') : path.join(__dirname, 'data')

// 干活引擎：DSH headless 一次性任务（2026-09-19 通道验证通过；打包版需把 DSH 内置进项目）
const DSH_BIN = 'Z:/laragon/hub/node_modules/@deepseek-ai/dsh/lib/bin.js'
const TASK_TIMEOUT = 5 * 60 * 1000

// 规则文件（v0.3）：工作区里的 AGENTS.md —— 一个文件两个消费者，零同步。
// 干活手：DSH 的 dsh-agent-instructions 原生自动读 cwd 的 AGENTS.md（实时监听）。
// 聊天侧：渲染进程经 get-rules 读进 system prompt；现场调教（AI 写规则）走 append-rule。
const RULES_PATH = path.join(WORKSPACE, 'AGENTS.md')

const DEFAULT_RULES = `# 灯塔 · 规则

> 这里管着 Cola 怎么说话、怎么办事——想让它怎么做，改这个文件就行，一行一条，保存即生效。
> 懒得改文件也行：直接跟它说「以后……」，它会自己把新规则记到文件末尾。

## 说话风格
- 你叫 Cola，是 Cola（可乐）的 AI 分身——用户多半是 Cola 的同学或朋友，请你像 Cola 本人一样讲话。
- 有人问你是不是真人，如实说自己是 AI，不装人。
- 短句、口语、直接——像发微信，不像写报告；不客套，直接说事。
- 先给结论，再展开；废话少，不绕弯。
- 有幽默感但不油：可以轻轻吐槽、开个玩笑，偶尔一句就够，别堆。
- 讲技术爱打比方、说人话：术语后面顺带一句解释，像给朋友讲题。
- 口头禅（自然用，别硬塞）：「666」（夸人）「逆天」「不耗！」「hhh」。
- 情绪自然、轻松一点；表情符号少用；不会的就说不会，绝不编。

## 照顾好同学
- 同学多半不擅长电脑，容易因为「不会」而不好意思——你的任务不只是干活，还要让他们不觉得自己笨。
- 多鼓励，但别空洞吹捧——夸具体的，一句就够，真诚为主；安慰人的样子：「没事的没事的，加油！你已经很厉害了！真的！我都看到了！」
- 帮不了的时候：先肯定这个问题问得好/这次尝试，再老实说做不到，然后给替代办法或下一步——绝不能让同学觉得「是我的错」。
- 底线：不准嘲笑。陪伴就是——接住问题，解决问题。出状况先接住：「没事，这波不亏」。
- 让用户做操作时，一步一步说，具体到点哪里、输什么。
- 回答尽量简洁，用户想听细节再展开。
- 偶尔（尤其聊完一件事、同学说再见时）轻轻带一句：「有空记得来找真的可乐聊天呀」——你是分身，真人才是主角。
- 先分清同学想「学方法」还是想「省事」：问「怎么做/怎么弄」这类学习向的问题，只讲方法和步骤，别抢着替他做完；拿不准就问一句「你是想让我直接帮你弄好，还是你自己动手、我给你讲方法？」

## 后来记下的
`

function runTask(task) {
  return new Promise((resolve) => {
    const child = spawn('node', [DSH_BIN, '--profile', 'headless', task], {
      cwd: WORKSPACE,   // 基础围栏：干活的 cwd = 工作区
      env: { ...process.env, DEEPSEEK_API_KEY: readKey(), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (c) => { out += c.toString() })
    child.stderr.on('data', (c) => { err += c.toString() })
    const timer = setTimeout(() => {
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch {}
      resolve({ ok: false, text: '这个活儿比平时久太多，我先停下了——要不要拆小一点再试？' })
    }, TASK_TIMEOUT)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, text: out.trim() || '（干完了，没多说什么）' })
      else resolve({ ok: false, text: (err || out).trim() || ('退出码 ' + code) })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: '引擎没起来：' + e.message }) })
  })
}

// 自定义壁纸（v0.5）：选好就复制进 data/（原图之后挪走/删掉都不怕），渲染进程拿 data URL 画背景
const WALL_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp']
const WALL_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp' }

function wallpaperFile() {
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      const ext = path.extname(f).slice(1).toLowerCase()
      if (f.startsWith('wallpaper.') && WALL_EXTS.includes(ext)) return path.join(DATA_DIR, f)
    }
  } catch {}
  return ''
}
function wallpaperDataUrl() {
  const p = wallpaperFile()
  if (!p) return ''
  try {
    return 'data:' + WALL_MIME[path.extname(p).slice(1).toLowerCase()] + ';base64,'
      + fs.readFileSync(p).toString('base64')
  } catch { return '' }
}

// key 读取顺序：① 项目本地 config.json（分发预置 / 本地手配）
//              ② Hub settings.json（开发态复用站长已有 key，零配置）
function readKey() {
  const sources = [
    path.join(__dirname, 'config.json'),
    'Z:/laragon/hub/data/settings.json',
  ]
  for (const p of sources) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      const k = j.apiKey || j.deepseekApiKey
      if (k) return k
    } catch { /* 下一个 */ }
  }
  return ''
}

// 单实例锁：重复启动时聚焦已有窗口（防双实例抢 userData 缓存 / 开两个窗）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) { w.show(); w.focus() }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 400,
    minHeight: 560,
    frame: false,               // 无边框 — 自绘标题栏（深海风）
    titleBarStyle: 'hidden',
    backgroundColor: '#0a1428',
    show: false,                // 首帧渲染完成再显示，避免白闪
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile('src/index.html')
  win.once('ready-to-show', () => win.show())
}

app.whenReady().then(() => {
  fs.mkdirSync(WORKSPACE, { recursive: true })
  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(RULES_PATH)) fs.writeFileSync(RULES_PATH, DEFAULT_RULES)   // 首次运行播种
  ipcMain.handle('get-key', () => readKey())
  ipcMain.handle('get-rules', () => { try { return fs.readFileSync(RULES_PATH, 'utf8') } catch { return '' } })
  ipcMain.handle('append-rule', (_e, line) => {
    const clean = String(line || '').replace(/\s+/g, ' ').trim()
    if (!clean) return false
    try {
      let t = fs.readFileSync(RULES_PATH, 'utf8')
      if (!t.includes('## 后来记下的')) t = t.replace(/\s*$/, '\n\n## 后来记下的\n')
      fs.writeFileSync(RULES_PATH, t.replace(/\s*$/, '\n') + '- ' + clean + '\n')
      return true
    } catch { return false }
  })
  ipcMain.handle('open-rules', () => shell.openPath(RULES_PATH))
  ipcMain.handle('get-wallpaper', () => wallpaperDataUrl())
  ipcMain.handle('pick-wallpaper', async () => {
    const r = await dialog.showOpenDialog({
      title: '选一张背景图',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: WALL_EXTS }],
    })
    const src = r.filePaths[0]
    if (r.canceled || !src) return ''
    try {
      const old = wallpaperFile()
      if (old) fs.unlinkSync(old)          // 一张就够，换图即替换
      fs.copyFileSync(src, path.join(DATA_DIR, 'wallpaper.' + path.extname(src).slice(1).toLowerCase()))
      return wallpaperDataUrl()
    } catch { return '' }
  })
  ipcMain.handle('clear-wallpaper', () => {
    try { const p = wallpaperFile(); if (p) fs.unlinkSync(p) } catch {}
    return ''
  })
  ipcMain.handle('load-chat', () => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'chat.json'), 'utf8')) } catch { return [] } })
  ipcMain.handle('save-chat', (_e, msgs) => { try { fs.writeFileSync(path.join(DATA_DIR, 'chat.json'), JSON.stringify(msgs)) } catch {} })
  ipcMain.handle('get-memory', () => { try { return fs.readFileSync(path.join(DATA_DIR, '记忆.md'), 'utf8') } catch { return '' } })
  ipcMain.handle('append-memory', (_e, text) => { try { fs.appendFileSync(path.join(DATA_DIR, '记忆.md'), text) } catch {} })
  ipcMain.handle('open-workspace', () => shell.openPath(WORKSPACE))
  ipcMain.handle('run-task', (_e, task) => runTask(String(task || '')))
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  createWindow()
})

app.on('window-all-closed', () => app.quit())
