# 灯塔 · Lighthouse

[English](README.md) · **中文**

> 一个说人话的桌面 AI 小助手：打开就能聊，也能真的帮你处理文件。

写给「不太懂电脑」的人用的 —— 没有设置面板、没有命令行、没有英文术语。
双击打开就是一个聊天窗口，像发微信一样说话。

## 它能做什么

- **聊天问答**：学习、写东西、查资料（联网搜索走内置的干活引擎）
- **处理文档**：把 Word / Excel / PPT / 图片**拖进窗口**，说一句要干什么
  - 读取、生成、改写都可以；产出一律进工作区的 `成品/` 文件夹，**原文件只读不动**
- **看懂图片**：拖张图进来说「这上面写了啥」
- **动手之前先问你**：涉及新建/修改/删除文件时，会先把计划摆出来，你点「可以，动手」才执行
- **能教它规矩**：说一句「以后回答短一点」，它会自己把规矩记进工作区的规则文件

## 怎么跑起来

```bash
npm install

# 1) 放钥匙：在项目根目录建 config.json
echo '{ "apiKey": "你的 DeepSeek API Key" }' > config.json
#    （没有的话会退回读 ~/.dsh 的 settings.json，见 main.js 的 readKey）

# 2) 干活引擎需要一个「控制台子系统」的真 Node（不是 Electron 的 node 模式）
#    从 https://npmmirror.com/mirrors/node/ 下一个 win-x64 包，把 node.exe 放到 runtime/
mkdir -p runtime && cp /path/to/node.exe runtime/

npm start
```

启动前记得 `unset ELECTRON_RUN_AS_NODE`（本机若有这个全局变量，Electron 会进纯 Node 模式、窗口不出现）。

## 打包

```bash
# GitHub 被墙环境要带两个镜像
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win nsis
```

打包前**自备**这三样（本仓库不含，原因见下）：

| 需要放的 | 说明 |
|---|---|
| `runtime/node.exe` | 干活引擎的运行时（92MB，从上面那个镜像下） |
| `src/assets/avatar.png` | 助手头像；缺了会退化成字母「C」 |
| `build/icon.ico` / `icon.png` | 应用图标（可从头像用 Pillow 生成，多尺寸档） |

## 它是怎么搭的

```
Electron 壳（无边框小窗）
├─ 聊天   → 直连 DeepSeek API（流式）
├─ 干活   → 起一个自带的内嵌 DSH（headless）当 agent：
│           它有文件读写、跑命令、联网搜索等工具，跑在「工作区」围栏内
└─ 工具箱 → tools/office.js：docx/xlsx/pptx 的读写（Node，零外部安装）
```

- 工作区（围栏）：开发态 `./workspace`，打包态 `我的文档/灯塔工作区`
- 数据：聊天记录/记忆/壁纸在用户数据目录；**引擎的配置树也在应用自己家里**（`DSH_HOME`），不碰 `~/.dsh`
- 规则文件：`工作区/AGENTS.md`，用户随时可改，聊天与干活引擎都读它

## 不进仓库的东西（重要）

- `config.json`（API Key）、`data/`（聊天记录）、`workspace/`（用户文件）、`dsh-home/`（引擎状态）
- `runtime/`（第三方二进制）、头像与图标（**版权素材**）

> 分发出的安装包里会嵌 API Key —— 拿到包的人都能扒出来，务必给 key 设消费限额。

## License

MIT
