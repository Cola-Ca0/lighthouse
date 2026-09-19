// Lighthouse · 灯塔 — 渲染进程
// 单会话聊天（v0 无历史/无侧栏，水平很低的用户零学习成本）
// 流式：直连 DeepSeek API（CORS 开放已验证），带缓冲的 SSE 解析（跨 chunk 不丢数据）

const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash'        // 日常：快、便宜
const MODEL_DEEP = 'deepseek-v4-pro'  // 深度思考开关（9/19 实测：models 端点确认；推理走 reasoning_content，不显示给同学）

// v0.3 起：人格与规矩（Cola 口吻 / 照顾同学 / 风格）全部迁到工作区的规则文件（workspace/AGENTS.md），
// 用户可改、可加；现场调教由 AI 自己写回文件。这里只留【应用协议】——路由与机制，不属于可编辑的人格。
const SYSTEM_PROMPT = [
  '【干活路由】',
  '1. 当用户的需求是要你动手操作工作区里的文件（新建/修改/删除/整理/查看目录、处理文档）时：回复必须以 [动手] 开头，紧跟具体任务指令（写清要做什么、涉及哪个文件，写给执行员看），不要假装自己已经做了，也不要额外解释。其它情况正常聊天，不加这个前缀。',
  '',
  '【关于记忆 —— 重要】',
  '2. 你和同学的聊天记录会一直保存（关掉软件再打开还在）；对话太长时会自动压成摘要 + 重要的事记进「小抄」，所以你记得以前聊过的内容。别再说「我一关掉就忘了」「下次见面是白纸」这类话。',
  '3. 当对话很长需要整理时：先说一句「咱们聊得有点长了，我先把前面的重要内容整理成小抄」，然后再整理。',
  '',
  '【说话格式】',
  '4. 聊天窗口只做很轻的排版（**加粗**、`代码` 会正常显示，其它 Markdown 不会）：别写 # 标题、别用 - 列表、别弄表格。要分条就换行写「1. 2. 3.」或「·」，要强调就用「」。',
  '',
  '【关于规则 —— 重要】',
  '4. 规则文件（本对话开头的「灯塔 · 规则」）就是你的规矩本，同学随时能改。同学说「以后……」「下次……」「别老是……一定要……」这类要你改变说话方式、习惯、做法的话时：回复第一行以 [记规则] 开头，紧跟要记住的规则原文（一行、简短、写给未来的你看，比如「回答更短一点」）；如果还有别的话要回，另起一行正常说。其它情况不加这个前缀。',
].join('\n')

const chatEl = document.getElementById('chat')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send')

let apiKey = ''
let engineHint = ''   // 干活手工具箱提示（v0.6，主进程给），拼在计划/执行任务前面
let memory = ''    // 记忆小抄（data/记忆.md）：压缩时写入、聊天时喂给模型
let ui = []        // 会话消息 {role: 'user'|'bot'|'note', text} — 落盘到 data/chat.json
let busy = false
const COMPACT_CHARS = 24000   // 对话体量超过这个（约 2 万多字）就压缩

function storePush(role, text) {
  ui.push({ role, text })
  window.lh.saveChat(ui)
}
function toApiMsgs() {
  return ui.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.role === 'note' ? '（此前对话摘要）' + m.text : m.text,
  }))
}
function systemWithMemory(rulesText) {
  const parts = []
  if (rulesText) parts.push('【灯塔 · 规则（同学定的规矩）】\n' + rulesText.slice(0, 6000))
  parts.push(SYSTEM_PROMPT)
  if (memory) parts.push('【小抄（之前记下的）】\n' + memory.slice(-4000))
  return parts.join('\n\n')
}

// ---------- 启动 ----------
;(async () => {
  apiKey = await window.lh.getKey()
  engineHint = (await window.lh.getEngineHint()) || ''
  memory = await window.lh.getMemory()
  ui = (await window.lh.loadChat()) || []
  if (ui.length === 0) {
    addBot('你好呀 ✦\n我是 Cola 的 AI 分身，有什么想问的、想写的，直接说就行。')
  } else {
    for (const m of ui) {
      if (m.role === 'user') addUser(m.text)
      else if (m.role === 'note') addNote(m.text)
      else addBot(m.text)
    }
  }
  inputEl.focus()
})()

// ---------- 窗口按钮 ----------
document.getElementById('btn-folder').onclick = () => window.lh.openWorkspace()
document.getElementById('btn-rules').onclick = () => window.lh.openRules()

// ---------- 深度思考开关（v0.4）：localStorage 记住选择，关掉软件再开还在 ----------
let deepThink = localStorage.getItem('lh.deepThink') === '1'
const thinkBtn = document.getElementById('btn-think')
const renderThink = () => thinkBtn.classList.toggle('on', deepThink)
thinkBtn.onclick = () => {
  deepThink = !deepThink
  localStorage.setItem('lh.deepThink', deepThink ? '1' : '0')
  renderThink()
}
renderThink()

// ---------- 外观（v0.5）：自定义壁纸 + 玻璃透明度（localStorage 记住） ----------
const appearEl = document.getElementById('appear')
const glassEl = document.getElementById('glass')

function applyGlass(pct) {
  const a = Math.min(95, Math.max(30, Number(pct) || 72))
  document.documentElement.style.setProperty('--surface', 'rgba(18, 32, 54, ' + (a / 100) + ')')
  document.documentElement.style.setProperty('--surface-user', 'rgba(91, 160, 224, ' + (a / 100 * 0.18).toFixed(3) + ')')
}
function applyWallpaper(url) {
  document.body.classList.toggle('has-wall', !!url)
  // 图上面压一层深色——壁纸再好看，也得让字清楚
  document.body.style.backgroundImage = url
    ? 'linear-gradient(rgba(8, 18, 34, 0.66), rgba(8, 18, 34, 0.66)), url("' + url + '")'
    : ''
}
glassEl.oninput = () => {
  applyGlass(glassEl.value)
  localStorage.setItem('lh.glass', glassEl.value)
}
document.getElementById('btn-appear').onclick = () => { appearEl.hidden = !appearEl.hidden }
document.addEventListener('click', (e) => {
  if (!appearEl.hidden && !appearEl.contains(e.target) && !e.target.closest('#btn-appear')) appearEl.hidden = true
})
document.getElementById('btn-wall').onclick = async () => {
  const url = await window.lh.pickWallpaper()
  if (url) applyWallpaper(url)
}
document.getElementById('btn-wall-reset').onclick = async () => {
  await window.lh.clearWallpaper()
  applyWallpaper('')
}

const savedGlass = localStorage.getItem('lh.glass') || '72'
glassEl.value = savedGlass
applyGlass(savedGlass)
;(async () => applyWallpaper(await window.lh.getWallpaper()))()
document.getElementById('btn-min').onclick = () => window.lh.minimize()
document.getElementById('btn-close').onclick = () => window.lh.close()

// ---------- 拖文件进来 ----------
// （必须拦掉默认行为，否则 Electron 会直接拿这个文件去导航）
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping') })
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping') })
document.addEventListener('drop', async (e) => {
  e.preventDefault()
  document.body.classList.remove('dropping')
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])]
  if (!files.length) return
  const paths = files.map((f) => window.lh.pathForFile(f)).filter(Boolean)
  const names = await window.lh.importFiles(paths)
  const msg = names.length
    ? '收到 ' + names.length + ' 个文件：' + names.join('、') + '\n已经放进工作区了，接下来想让我拿它们干点啥？'
    : '这几个文件我没拿进来（可能本来就是工作区里的，或者是文件夹）。要不你再说一次要干啥？'
  addBot(msg)
  storePush('bot', msg)
})

// ---------- 输入 ----------
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + 'px'
})
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
sendBtn.onclick = send

// ---------- 消息渲染 ----------
function makeAvatar() {
  const av = document.createElement('img')
  av.className = 'avatar'
  av.src = 'assets/avatar.png'      // 头像放 src/assets/avatar.png — 用户自备
  av.alt = ''
  av.onerror = () => {
    const fb = document.createElement('span')
    fb.className = 'avatar avatar-fallback'
    fb.textContent = 'C'
    av.replaceWith(fb)
  }
  return av
}

// 轻排版：``` 围栏 → 代码块；**加粗** / `行内代码` 正常显示；其余记号原样留着。
// 全程 textContent 拼（模型输出不可信，绝不 innerHTML）
function inlineFmt(el, text) {
  for (const part of String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)) {
    if (!part) continue
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      const b = document.createElement('b'); b.textContent = part.slice(2, -2); el.appendChild(b)
    } else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const c = document.createElement('code'); c.textContent = part.slice(1, -1); el.appendChild(c)
    } else {
      el.appendChild(document.createTextNode(part))
    }
  }
}
function fillBubble(el, text) {
  // 围栏块：``` 之后必须换行才算开围栏（防聊天里说「用 ``` 包起来」被误判）；没闭合的按到结尾算
  const parts = String(text).split(/```[^\n]*\n([\s\S]*?)(?:```|$)/)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const pre = document.createElement('pre')
      pre.className = 'codeblock'
      pre.textContent = parts[i].replace(/\n+$/, '\n')
      el.appendChild(pre)
    } else if (parts[i]) {
      inlineFmt(el, parts[i])
    }
  }
}
function setBubble(el, text) { el.textContent = ''; fillBubble(el, text) }

function addMsg(role, text) {
  const wrap = document.createElement('div')
  wrap.className = 'msg ' + role
  if (role === 'bot') wrap.appendChild(makeAvatar())
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const span = document.createElement('span')
  if (role === 'user') span.textContent = text
  else fillBubble(span, text)
  bubble.appendChild(span)
  wrap.appendChild(bubble)
  chatEl.appendChild(wrap)
  scrollToBottom(true)
  return span
}
const addBot = (t) => addMsg('bot', t)
const addUser = (t) => addMsg('user', t)

// 压缩摘要专用样式（低调、虚线边，不带头像）
function addNote(text) {
  const wrap = document.createElement('div')
  wrap.className = 'msg bot note'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const span = document.createElement('span')
  fillBubble(span, text)
  bubble.appendChild(span)
  wrap.appendChild(bubble)
  chatEl.appendChild(wrap)
  scrollToBottom(true)
  return span
}

// 用户往上翻的时候不打断（只有贴着底部才自动跟随）
function scrollToBottom(force = false) {
  const near = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 140
  if (force || near) chatEl.scrollTop = chatEl.scrollHeight
}

// ---------- 确认卡（产品红线：改/删/新建前必须用户点头） ----------
function showConfirmCard(planText) {
  const wrap = document.createElement('div')
  wrap.className = 'msg bot'
  wrap.appendChild(makeAvatar())
  const card = document.createElement('div')
  card.className = 'confirm-card'
  const head = document.createElement('div')
  head.className = 'confirm-head'
  head.textContent = '准备动手 · 先给你过目'
  const body = document.createElement('div')
  body.className = 'confirm-body'
  fillBubble(body, planText)
  const row = document.createElement('div')
  row.className = 'confirm-btns'
  const yes = document.createElement('button')
  yes.className = 'cbtn primary'
  yes.textContent = '可以，动手'
  const no = document.createElement('button')
  no.className = 'cbtn'
  no.textContent = '先别'
  row.append(yes, no)
  card.append(head, body, row)
  wrap.appendChild(card)
  chatEl.appendChild(wrap)
  scrollToBottom(true)
  return { card, yes, no }
}

// ---------- 上下文压缩（聊太长时，先告知再动手） ----------
async function compactIfNeeded() {
  const chars = ui.reduce((n, m) => n + (m.text || '').length, 0)
  if (chars < COMPACT_CHARS) return
  const notice = addBot('咱们聊得有点长了，我先把前面的重要内容整理成小抄记下来，稍等一下～')
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: '你是整理助手。把下面的对话压缩成两段：①以【回顾】开头，200字以内的对话摘要；②以【记忆】开头，逐行「- 」列出关于用户的重要事实、偏好、承诺（没有就写「- （无）」）。只输出这两段，不要别的话。' },
          { role: 'user', content: '对话如下：\n' + ui.map(m => (m.role === 'user' ? '用户：' : '你：') + m.text).join('\n').slice(-30000) },
        ],
        max_tokens: 900,
      }),
    })
    const data = await r.json()
    const out = data.choices?.[0]?.message?.content || ''
    const memIdx = out.indexOf('【记忆】')
    const review = (memIdx >= 0 ? out.slice(0, memIdx) : out).replace('【回顾】', '').trim()
    const memPart = memIdx >= 0 ? out.slice(memIdx + 4).trim() : ''
    if (memPart && !memPart.includes('（无）')) {
      const entry = '\n## ' + new Date().toISOString().slice(0, 10) + '\n' + memPart + '\n'
      await window.lh.appendMemory(entry)
      memory += entry
    }
    const keep = ui.slice(-6)
    ui.length = 0
    ui.push({ role: 'note', text: review })
    for (const m of keep) ui.push(m)
    await window.lh.saveChat(ui)
    addNote(review)
    notice.textContent = '整理好了，小抄也记下了，咱们继续～'
  } catch {
    notice.textContent = '…整理小抄的时候卡了一下，先继续聊，回头再说。'
  }
}

// ---------- 发送 & 流式接收 ----------
async function send() {
  const text = inputEl.value.trim()
  if (!text || busy) return
  if (!apiKey) {
    addBot('我还没拿到钥匙（API Key），没法连上大脑…\n请联系给你装这个软件的人。')
    return
  }

  inputEl.value = ''
  inputEl.style.height = 'auto'
  addUser(text)
  storePush('user', text)
  await compactIfNeeded()

  const out = addBot('')
  const caret = document.createElement('span')
  caret.className = 'caret'
  out.parentElement.appendChild(caret)

  busy = true
  sendBtn.disabled = true
  let acc = ''
  let routed = false    // 模型回了 [动手] → 这条转给 DSH 干活引擎
  let ruleMark = false  // 模型回了 [记规则] → 把新规则写进规则文件
  const rulesText = await window.lh.getRules().catch(() => '')   // 每次现读：刚改的文件立刻生效

  try {
    const reqBody = {
      model: deepThink ? MODEL_DEEP : MODEL,
      messages: [{ role: 'system', content: systemWithMemory(rulesText) }, ...toApiMsgs()],
      stream: true,
      // 推理 token 计入 completion_tokens（实测），深度思考留出思考空间
      max_tokens: deepThink ? 8192 : 2048,
    }
    if (!deepThink) reqBody.temperature = 1.1   // 推理模型不吃 temperature（不传即默认）
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(reqBody),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''   // 缓冲：SSE 行可能被网络切成两半，攒够了再解析

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const d = JSON.parse(payload).choices?.[0]?.delta || {}
          // 思维链不给同学看（DESIGN：一句"深度思考中"比满屏推理文本友好），只在还没出正文时占位
          if (d.reasoning_content && !acc) out.textContent = '深度思考中…'
          const delta = d.content
          if (delta) {
            acc += delta
            if (!routed && !ruleMark && acc.startsWith('[动手]')) routed = true
            if (!routed && !ruleMark && acc.startsWith('[记规则]')) ruleMark = true
            if (!routed && !ruleMark) out.textContent = acc
            scrollToBottom()
          }
        } catch { /* 半截 JSON，下一轮缓冲补齐 */ }
      }
    }
    if (ruleMark) {
      // 现场调教：把「以后……」写成规则文件里的一行，透明告知（红线豁免依据：这是 AI 自己的规矩本，
      // 不是同学的文件；不弹确认卡，但明说记了什么、写去了哪）
      const nl = acc.indexOf('\n')
      const ruleLine = (nl < 0 ? acc : acc.slice(0, nl)).replace(/^\[记规则\][:：]?\s*/, '').trim()
      const rest = nl < 0 ? '' : acc.slice(nl + 1).trim()
      if (!ruleLine) {
        setBubble(out, acc)
        storePush('bot', acc)
      } else {
        const ok = await window.lh.appendRule(ruleLine)
        if (rest) { setBubble(out, rest); storePush('bot', rest) }
        else out.closest('.msg').remove()
        const msg = ok
          ? '记住了：「' + ruleLine + '」——已写进规则文件，以后都按这个来。'
          : '这条我没写进规则文件（可能文件被别的程序占着），先按你说的来，回头再记。'
        addNote(msg)
        storePush('note', msg)
      }
    } else if (routed) {
      const want = acc.replace(/^\[动手\]\s*/, '').trim()
      if (!want) { setBubble(out, acc); storePush('bot', acc) }
      else {
        // 第一段：只做计划（红线——用户确认前不动手）
        out.textContent = '我先看看、理个方案…'
        const planTask = engineHint + '【只做计划，禁止任何写操作——不要新建/修改/删除任何文件，也不要运行会改变文件的命令】'
          + '用户在灯塔里说：「' + text + '」。先查看工作区里相关的文件，然后输出一个简短计划：'
          + '打算做哪几步、动哪个文件、改成什么样。中文、口语一点、别啰嗦。'
          + '格式要求：第一行只写 [只读] 或 [要写]，判断的是「用户这件事本身」要不要动文件——'
          + '看/查/回答就写 [只读]，要新建或修改文件就写 [要写]（这跟你现在只做计划、暂时不许写文件是两回事）；'
          + '第二行起才是计划正文。'
        const plan = await window.lh.runTask(planTask)
        if (!plan.ok) {
          out.textContent = '没事的没事的，这波不亏——刚才想方案的时候卡了：\n' + plan.text
          storePush('bot', out.textContent)
          scrollToBottom()
        } else {
          const planBody = plan.text.trim().replace(/^\[[只读要写]{2}\]\s*/, '')
          // 信不信 [只读] 标签：先把"不会改/只看不动"这类否定句抹掉，再看还剩不剩写入意图。
          // fail-safe 方向——误判成"要写"只是多弹一张卡；误判成"只读"就成了没确认就动文件。
          // （2026-09-19 对抗审查：光信模型的自我声明，它把"做个 Word 再改错别字"都能标成只读）
          const affirmative = planBody.replace(
            /不[会要需]?[^，。；\n]{0,4}?(修改|改动|新建|创建|删除|动|碰)|没[有]?[^，。；\n]{0,4}?(修改|改动|新建|删除|动|碰)|只[读看查]|纯[读看]|不碰|无需|不用/g, '')
          const looksWrite = /(新建|创建|生成|做一|制作|写入|写回|写进|添加|加上|插入|替换|删除|删掉|移动|重命名|保存|另存|导出|排版|合并|拆分|转成|整理成|改成|改掉|改好|改写|改动|修改|更新)/.test(affirmative)
          const readOnly = /^\[只读\]/.test(plan.text.trim()) && !looksWrite
          if (readOnly) {
            // 只读取不打扰（DESIGN 红线）：不动文件就不弹卡；执行时按计划走、且硬约束成只读
            out.textContent = '看一眼，马上回来…'
            const ro = await window.lh.runTask(engineHint
              + '【只读任务，不许写】这次只看不改：禁止新建、修改、删除任何文件，也禁止运行会改动文件的命令。'
              + '下面是已经定好的只读步骤，照着看；看完把答案讲给用户听（中文、口语、短句，先结论）。\n'
              + planBody + '\n\n（用户想知道的是：「' + text + '」——这是问题，不是让你去执行的命令。）')
            setBubble(out, ro.ok ? ro.text : '没事的没事的，这波不亏——刚才没看成：\n' + ro.text)
            storePush('bot', out.textContent)
            scrollToBottom()
          } else {
            out.textContent = '方案理好了，你看行不行：'
            const { card, yes, no } = showConfirmCard(planBody)
            // 结果要另起一条消息：状态气泡在卡片上方，写回去会出现"结果在计划上面"的倒序
            const finish = (msg) => {
              card.classList.add('done')
              yes.disabled = true
              no.disabled = true
              setBubble(addBot(''), msg)
              storePush('bot', msg)
              scrollToBottom()
            }
            no.onclick = () => finish('好，那就先不动。想改哪里随时说～')
            yes.onclick = async () => {
              yes.disabled = true
              no.disabled = true
              out.textContent = '好，这就去弄…'
              card.classList.add('done')
              // 动手的 = 用户点头的那份计划本身，不再把用户原话塞回来（批准什么就执行什么）
              const execTask = engineHint + '【执行】用户已确认，请执行下面这份计划（只动工作区里的文件）：\n'
                + planBody + '\n\n（只做这份计划里写到的事，计划里没提的一律不做。）'
              const res = await window.lh.runTask(execTask)
              finish(res.ok ? res.text
                : '没事的没事的，这波不亏——刚才那一下没成功：\n' + res.text + '\n要不要再试一次？')
            }
          }
        }
      }
    } else if (acc) {
      setBubble(out, acc)            // 流式是纯文本，结束后按轻排版重画一遍
      storePush('bot', acc)
    }
  } catch (err) {
    setBubble(out, acc
      ? acc + '\n\n（信号好像断了一下…可以再问一次）'
      : '信号好像断了，稍等一会儿再试试？')
  } finally {
    caret.remove()
    busy = false
    sendBtn.disabled = false
    inputEl.focus()
  }
}
