#!/usr/bin/env node
// 灯塔工具箱 · Office 读写（v0.6）
// 给干活手用的命令行工具：node tools/office.js <命令> [参数]
//
//   read <文件>              把 docx / xlsx / pptx 里的文字提出来（打印到标准输出）
//   docx-new <输出> <json>   从 JSON 生成 Word
//   xlsx-new <输出> <json>   从 JSON 生成 Excel
//   pptx-new <输出> <json>   从 JSON 生成 PPT
//   help
//
// JSON 形状（写进一个临时文件再传给命令，别在命令行里塞）：
//   docx-new: {"title":"标题","blocks":[{"type":"h1|h2|p|bullet","text":"…"},
//                                         {"type":"table","rows":[["a","b"],["1","2"]]}]}
//   xlsx-new: {"sheets":[{"name":"表1","rows":[["姓名","分数"],["小明",95]]}]}
//   pptx-new: {"slides":[{"title":"标题","bullets":["要点一","要点二"]}]}
//
// 安全：一切路径必须在当前工作目录（灯塔工作区）之内——越界直接拒绝（含软链/junction 绕道）。
//
// ponytail: 只做「取文字 / 生成基础文档」两件事；要改现有文档的样式和排版，
//           以后再加 edit 系列命令，别提前写。

const fs = require('fs')
const path = require('path')

const ROOT = fs.realpathSync(process.cwd())   // 工作区根（干活手 spawn 时 cwd=工作区）

function safe(p, mustExist) {
  const abs = path.resolve(ROOT, p)
  if (mustExist && !fs.existsSync(abs)) fail('文件不存在：' + p)
  // 越界校验：取「最深的已存在祖先」做 realpath，必须仍在工作区内。
  // 关键在「不存在的末段也要查父目录」——只查已存在的目标，会漏掉「经软链父目录新建文件」这条逃逸路
  // （2026-09-19 对抗审查实测：junction 指向 Startup 能写进去）。
  let probe = fs.existsSync(abs) ? abs : path.dirname(abs)
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe)
  const rel = path.relative(ROOT, fs.realpathSync(probe))
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail('路径超出工作区了：' + p)
  return abs
}

// 只在工作区里生成这三种文件——防手滑把 AGENTS.md 之类的文件覆盖成 zip
function safeOut(p, allowed) {
  const abs = safe(p, false)
  if (!allowed.includes(ext(abs))) fail('输出文件名要用 .' + allowed.join(' / .') + ' 结尾')
  return abs
}

// XML 实体解码（Word/PPT 的文本里 & < > 都是转义存着的，不解码会原样讲给用户）
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')   // & 放最后，免得 &amp;lt; 被二次解码成 <
}
function fail(msg) { console.error('出错：' + msg); process.exit(1) }
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(safe(p, true), 'utf8')) }
  catch (e) { fail('JSON 读不了：' + e.message) }
}
const ext = (p) => path.extname(p).slice(1).toLowerCase()

// ---------------- 读 ----------------
async function read(file) {
  const abs = safe(file, true)
  const e = ext(abs)
  if (e === 'docx') return readDocx(abs)
  if (e === 'xlsx') return readXlsx(abs)
  if (e === 'pptx') return readPptx(abs)
  fail('只认得 docx / xlsx / pptx，这个是 .' + e)
}

async function readDocx(abs) {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(fs.readFileSync(abs))
  const xml = await zip.file('word/document.xml').async('string')
  const out = []
  const paraText = (p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
  // 按顺序切：表格块整块抓出来排成「| 分隔」的行，其余按段落。
  // ponytail: 非贪婪匹配——Word 里嵌套表格极少见，真遇上再换成真正的 XML 解析
  for (const part of xml.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/)) {
    if (part.startsWith('<w:tbl>')) {
      // 切分要带边界：`<w:tr` 会连 `<w:trPr` 一起切中（每个表格都有），单元格会重复
      for (const row of part.split(/<w:tr[ >]/).slice(1)) {
        const cells = row.split(/<w:tc[ >]/).slice(1).map((c) => decodeXml(paraText(c)).trim())
        out.push(cells.join(' | '))
      }
    } else {
      for (const para of part.split(/<w:p[ >]/).slice(1)) out.push(decodeXml(paraText(para)))
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() || '（这个 Word 里没有文字）'
}

async function readXlsx(abs) {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(abs)
  const out = []
  wb.eachSheet((ws) => {
    out.push('## 工作表：' + ws.name)
    ws.eachRow((row, i) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (c) => cells.push(cellText(c.value)))
      out.push('第' + i + '行\t' + cells.join('\t'))
    })
    out.push('')
  })
  return out.join('\n').trim() || '（这个表格是空的）'
}

function cellText(v) {
  if (v == null) return ''
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('')
    if (v.text) return v.text                       // 公式/超链接
    if (v.result != null) return String(v.result)
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    return ''
  }
  return String(v)
}

async function readPptx(abs) {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(fs.readFileSync(abs))
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
  const out = []
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name).async('string')
    const paras = xml.split(/<a:p>/).slice(1)
      .map((p) => decodeXml([...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')))
      .filter((t) => t.trim())
    out.push('## 第 ' + (i + 1) + ' 页')
    out.push(paras.join('\n'))
    out.push('')
  }
  return out.join('\n').trim() || '（这个 PPT 里没有文字）'
}

// ---------------- 写 ----------------
async function docxNew(out, jsonPath) {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } = require('docx')
  const spec = readJson(jsonPath)
  const children = []
  if (spec.title) children.push(new Paragraph({ text: String(spec.title), heading: HeadingLevel.TITLE }))
  for (const b of spec.blocks || []) {
    const t = String(b.text == null ? '' : b.text)
    if (b.type === 'h1') children.push(new Paragraph({ text: t, heading: HeadingLevel.HEADING_1 }))
    else if (b.type === 'h2') children.push(new Paragraph({ text: t, heading: HeadingLevel.HEADING_2 }))
    else if (b.type === 'bullet') children.push(new Paragraph({ text: t, bullet: { level: 0 } }))
    else if (b.type === 'table') {
      children.push(new Table({
        rows: (b.rows || []).map((r) => {
          // 空行会生成没有单元格的 <w:tr>，真 Word 直接打不开（对抗审查实测）——兜成空单元格
          const cells = Array.isArray(r) && r.length ? r : ['']
          return new TableRow({
            children: cells.map((c) => new TableCell({ children: [new Paragraph(String(c))] })),
          })
        }),
      }))
    } else children.push(new Paragraph(t))
  }
  if (!children.length) children.push(new Paragraph('（空文档）'))
  const buf = await Packer.toBuffer(new Document({ sections: [{ children }] }))
  fs.writeFileSync(safeOut(out, ['docx']), buf)
  return 'Word 已生成：' + out
}

async function xlsxNew(out, jsonPath) {
  const ExcelJS = require('exceljs')
  const spec = readJson(jsonPath)
  const wb = new ExcelJS.Workbook()
  for (const s of spec.sheets || []) {
    const ws = wb.addWorksheet(String((s && s.name) || '表1').slice(0, 31))   // Excel 表名上限 31 字，超了它会往 stdout 喷警告
    for (const row of (s && s.rows) || []) ws.addRow(row)
    ws.getRow(1).font = { bold: true }
  }
  if (!wb.worksheets.length) wb.addWorksheet('表1')
  await wb.xlsx.writeFile(safeOut(out, ['xlsx']))
  return 'Excel 已生成：' + out
}

async function pptxNew(out, jsonPath) {
  const PptxGenJS = require('pptxgenjs')
  const spec = readJson(jsonPath)
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  for (const s of spec.slides || []) {
    const slide = pptx.addSlide()
    slide.addText(String(s.title || ''), { x: 0.6, y: 0.5, w: 8.8, h: 1.1, fontSize: 28, bold: true, color: '1F2A3A' })
    const bullets = (s.bullets || []).map((t) => ({ text: String(t), options: { bullet: true } }))
    if (bullets.length) {
      slide.addText(bullets, { x: 0.8, y: 1.8, w: 8.4, h: 3.4, fontSize: 16, color: '33414F', lineSpacingMultiple: 1.3 })
    }
  }
  if (!spec.slides || !spec.slides.length) pptx.addSlide().addText('（空）', { x: 0.5, y: 2, w: 9, h: 1, fontSize: 20 })
  await pptx.writeFile({ fileName: safeOut(out, ['pptx']) })
  return 'PPT 已生成：' + out
}

// ---------------- 入口 ----------------
const HELP = `灯塔工具箱 · Office 读写
用法：
  node tools/office.js read <文件>               提取 docx/xlsx/pptx 里的文字
  node tools/office.js docx-new <输出> <json>    从 JSON 生成 Word
  node tools/office.js xlsx-new <输出> <json>    从 JSON 生成 Excel
  node tools/office.js pptx-new <输出> <json>    从 JSON 生成 PPT

JSON 形状：
  docx-new  {"title":"标题","blocks":[{"type":"h1|h2|p|bullet","text":"…"},
                                       {"type":"table","rows":[["a","b"],["1","2"]]}]}
  xlsx-new  {"sheets":[{"name":"表1","rows":[["姓名","分数"],["小明",95]]}]}
  pptx-new  {"slides":[{"title":"标题","bullets":["要点一","要点二"]}]}

路径必须在工作区之内（相对当前目录写就行）。`

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  let msg
  if (cmd === 'read') msg = await read(a)
  else if (cmd === 'docx-new') msg = await docxNew(a, b)
  else if (cmd === 'xlsx-new') msg = await xlsxNew(a, b)
  else if (cmd === 'pptx-new') msg = await pptxNew(a, b)
  else { console.log(HELP); return }
  console.log(msg)
}

main().catch((e) => fail(e && e.message ? e.message : String(e)))
