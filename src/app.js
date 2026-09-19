// Lighthouse · 灯塔 — 渲染进程
// 单会话聊天（v0 无历史/无侧栏，水平很低的用户零学习成本）
// 流式：直连 DeepSeek API（CORS 开放已验证），带缓冲的 SSE 解析（跨 chunk 不丢数据）

const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash'   // 2026-09-19 修正: deepseek-chat 已失效; 现行=deepseek-flash / deepseek-v4-pro(深度思考,待接)

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
  '【关于规则 —— 重要】',
  '4. 规则文件（本对话开头的「灯塔 · 规则」）就是你的规矩本，同学随时能改。同学说「以后……」「下次……」「别老是……一定要……」这类要你改变说话方式、习惯、做法的话时：回复第一行以 [记规则] 开头，紧跟要记住的规则原文（一行、简短、写给未来的你看，比如「回答更短一点」）；如果还有别的话要回，另起一行正常说。其它情况不加这个前缀。',
].join('\n')

const chatEl = document.getElementById('chat')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send')

let apiKey = ''
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
document.getElementById('btn-min').onclick = () => window.lh.minimize()
document.getElementById('btn-close').onclick = () => window.lh.close()

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

function addMsg(role, text) {
  const wrap = document.createElement('div')
  wrap.className = 'msg ' + role
  if (role === 'bot') wrap.appendChild(makeAvatar())
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const span = document.createElement('span')
  span.textContent = text
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
  span.textContent = text
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
  body.textContent = planText
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
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemWithMemory(rulesText) }, ...toApiMsgs()],
        stream: true,
        temperature: 1.1,
        max_tokens: 2048,
      }),
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
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content
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
        out.textContent = acc
        storePush('bot', acc)
      } else {
        const ok = await window.lh.appendRule(ruleLine)
        if (rest) { out.textContent = rest; storePush('bot', rest) }
        else out.closest('.msg').remove()
        const msg = ok
          ? '记住了：「' + ruleLine + '」——已写进规则文件，以后都按这个来。'
          : '这条我没写进规则文件（可能文件被别的程序占着），先按你说的来，回头再记。'
        addNote(msg)
        storePush('note', msg)
      }
    } else if (routed) {
      const want = acc.replace(/^\[动手\]\s*/, '').trim()
      if (!want) { out.textContent = acc; storePush('bot', acc) }
      else {
        // 第一段：只做计划（红线——用户确认前不动手）
        out.textContent = '我先看看、理个方案…'
        const planTask = '【只做计划，禁止任何写操作——不要新建/修改/删除任何文件，也不要运行会改变文件的命令】'
          + '用户在灯塔里说：「' + text + '」。先查看工作区里相关的文件，然后输出一个简短计划：'
          + '打算做哪几步、动哪个文件、改成什么样。中文、口语一点、别啰嗦。'
        const plan = await window.lh.runTask(planTask)
        if (!plan.ok) {
          out.textContent = '没事的没事的，这波不亏——刚才想方案的时候卡了：\n' + plan.text
          storePush('bot', out.textContent)
          scrollToBottom()
        } else {
          out.textContent = '方案理好了，你看行不行：'
          const { card, yes, no } = showConfirmCard(plan.text)
          const finish = (msg) => {
            card.classList.add('done')
            yes.disabled = true
            no.disabled = true
            out.textContent = msg
            storePush('bot', msg)
            scrollToBottom()
          }
          no.onclick = () => finish('好，那就先不动。想改哪里随时说～')
          yes.onclick = async () => {
            yes.disabled = true
            no.disabled = true
            out.textContent = '好，这就去弄…'
            card.classList.add('done')
            const execTask = '【执行】用户已确认，请执行下面的计划（只动工作区里的文件）：\n'
              + plan.text + '\n\n（用户原话：「' + text + '」）'
            const res = await window.lh.runTask(execTask)
            finish(res.ok ? res.text
              : '没事的没事的，这波不亏——刚才那一下没成功：\n' + res.text + '\n要不要再试一次？')
          }
        }
      }
    } else if (acc) {
      storePush('bot', acc)
    }
  } catch (err) {
    out.textContent = acc
      ? acc + '\n\n（信号好像断了一下…可以再问一次）'
      : '信号好像断了，稍等一会儿再试试？'
  } finally {
    caret.remove()
    busy = false
    sendBtn.disabled = false
    inputEl.focus()
  }
}
