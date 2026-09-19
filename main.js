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

// 干活引擎：DSH headless 一次性任务（v0.7 起完全自带，不再外挂）
// 三件套都搬进应用：① DSH 包 = 应用自己的 node_modules ② Node 运行时 = Electron 自带二进制
// （ELECTRON_RUN_AS_NODE=1 当纯 Node 跑，零额外体积）③ 配置树 = DSH_HOME 指到应用自己的目录
const DSH_BIN = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const DSH_HOME = app.isPackaged
  ? path.join(app.getPath('userData'), 'dsh-home')
  : path.join(__dirname, 'dsh-home')
const TASK_TIMEOUT = 5 * 60 * 1000

// 干活手的 profile：DSH 认 $DSH_HOME/profiles/<name>，首次运行播种（跟规则文件一个套路）
const DSH_PROFILE = 'headless'
const DSH_PROFILE_PKG = JSON.stringify({
  name: 'dsh-profile-headless',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
}, null, 2)

const DSH_PERSONA_PATCH = `# 灯塔 · 干活人格注入（随应用走，别再改家目录那份）
# system-prompt.persona = 模型读到的第一段人格正文（支持 {{model}} / {{cwd}} 模板）
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working
      directory is {{cwd}}.
      你是 Cola（可乐）的 AI 分身里负责「动手」的那一半，替 Cola 帮同学和朋友处理文件、跑任务。
      说话风格：中文、短句、口语、直接，像发微信，不客套、不用「您好」这类词。
      汇报规矩：先给结果，再说过程；干了什么、动了哪个文件、检查结果如何，一句句讲清，别啰嗦。
      做不了或出错了就老实说，绝不编造；对不太懂电脑的同学要有耐心，语气轻松一点。
      不要暴露自己是什么工具/框架，别自称「AI 助手」——你就是 Cola 的分身。
`

// 干活手跑工具箱的壳：同学的电脑上没有 node，用应用自带的 Electron 当 Node 跑（路径按本机写死）
const TOOLS_SHIM = path.join(DSH_HOME, 'office.cmd')
function writeToolsShim() {
  try {
    fs.writeFileSync(TOOLS_SHIM,
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' + process.execPath + '" "' + TOOLS_JS + '" %*\r\n')
  } catch { /* 写不了就退化成不加提示，干活时自己会报错 */ }
}

function seedDshHome() {
  if (!fs.existsSync(DSH_BIN)) return false
  const dir = path.join(DSH_HOME, 'profiles', DSH_PROFILE)
  fs.mkdirSync(dir, { recursive: true })
  const pkg = path.join(dir, 'package.json')
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, DSH_PROFILE_PKG)
  const patch = path.join(dir, 'cordis.patch.yml')
  if (!fs.existsSync(patch)) fs.writeFileSync(patch, DSH_PERSONA_PATCH)
  writeToolsShim()
  return true
}

// 规则文件（v0.3）：工作区里的 AGENTS.md —— 一个文件两个消费者，零同步。
// 干活手：DSH 的 dsh-agent-instructions 原生自动读 cwd 的 AGENTS.md（实时监听）。
// 聊天侧：渲染进程经 get-rules 读进 system prompt；现场调教（AI 写规则）走 append-rule。
const RULES_PATH = path.join(WORKSPACE, 'AGENTS.md')

// 工具箱（v0.6）：Office 读写命令行，干活手用；路径写死成绝对路径喂给它
const TOOLS_JS = path.join(__dirname, 'tools', 'office.js')

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
- 口头禅（自然用，别硬塞）：「666」（夸人）「逆天」「hhh」。
- 「不耗！」是「不好」的意思（吐槽用），不是夸奖——别当正面词说。
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

// 子进程环境：继承来的 CHROME_*/ELECTRON_* 一律摘掉。
// 不摘的话，子进程（Electron 当 Node 跑）还会拿着上游的 CHROME_CRASHPAD_PIPE_NAME 去注册 crashpad，
// 拒绝访问之后把 debug.log 拉在 cwd——也就是同学的工作区里（2026-09-19 实测抓到）。
function childEnv(extra) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('CHROME_') || k.startsWith('ELECTRON_')) delete env[k]
  }
  return { ...env, ...extra }
}

function runTask(task) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DSH_BIN, '--profile', DSH_PROFILE, task], {
      cwd: WORKSPACE,   // 基础围栏：干活的 cwd = 工作区
      env: childEnv({
        ELECTRON_RUN_AS_NODE: '1',        // 用应用自带的 Electron 当 Node 跑（同学机器上没有 node）
        DSH_HOME,                          // 配置树也在应用自己家，不碰 ~/.dsh
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: readKey(),
        NO_COLOR: '1',
      }),
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
  fs.mkdirSync(path.join(WORKSPACE, '成品'), { recursive: true })               // 成品单独放，原文件不动
  if (!seedDshHome()) { /* DSH 没装齐的话，干活会直接报错给用户，聊天不受影响 */ }
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
  // 拖文件进窗口 → 复制进工作区（只复制，不动原文件；同名自动加序号）
  ipcMain.handle('import-files', (_e, paths) => {
    const out = []
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
      try {
        const src = path.resolve(String(p))
        if (!fs.statSync(src).isFile()) continue                       // 只收文件
        const rel = path.relative(WORKSPACE, src)
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) continue   // 本来就在工作区里就不用搬
        const ext = path.extname(src)
        let dest = path.join(WORKSPACE, path.basename(src))
        for (let i = 2; fs.existsSync(dest); i++) {
          dest = path.join(WORKSPACE, path.basename(src, ext) + ' (' + i + ')' + ext)
        }
        fs.copyFileSync(src, dest)
        out.push(path.basename(dest))
      } catch { /* 单个文件失败不影响其它的 */ }
    }
    return out
  })
  // 干活手的工具箱提示（v0.6，v0.7 改用自带运行时的壳）：Office 有现成工具，别自己拼 XML、别赌本机环境
  ipcMain.handle('get-engine-hint', () => fs.existsSync(TOOLS_SHIM)
    ? '【成品规矩】你做出来的东西一律放进工作区的「成品」子文件夹（名字跟原文件区分开，比如「周报-改好版.docx」）；'
      + '工作区里的原文件只读不写——除非用户明确说「直接改这个文件」。改别人的文档时，先把改好的另存到成品夹；'
      + '顺手用的临时规格文件，用完删掉别留在成品夹里。\n\n'
      + '【工具箱】要读写 Word / Excel / PPT（docx / xlsx / pptx）时，一律用下面这个现成的命令行工具'
      + '（就照抄这条命令，别改成 node——用户的电脑上没有 node，也没有 Python）：\n'
      + '"' + TOOLS_SHIM + '" read <文件>   —— 提取文字\n'
      + '"' + TOOLS_SHIM + '" docx-new <输出.docx> <规格.json>   —— 生成 Word（xlsx-new / pptx-new 同理）\n'
      + '规格 JSON 的形状跑 "' + TOOLS_SHIM + '" help 看。路径写工作区里的相对路径就行。\n'
      + '（另外：汇报是直接显示给用户看的聊天消息，别用 Markdown 记号——#、**、` 都会原样露出来，'
      + '要分条就换行写 1. 2. 3.，要强调就用「」。）\n\n'
    : '')
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
