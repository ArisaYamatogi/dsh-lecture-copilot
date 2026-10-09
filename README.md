# DSH Lecture Copilot
### 一款服务于Deepseek Harness桌面端的实时翻译同传+一键生成课堂笔记的插件

### 能做什么？
按下麦克风按钮 → 实时把老师讲的英文讲解转写成文字并翻译成中文
→ 再次按下结束录音 → 自动整理出**逻辑链 + 知识点**的复习笔记
→ 还可**自动导出至OneNote**（仅限Windows）

特化场景：全英文授课的**高等数学 (Advanced Mathematics) / 线性代数 / 概率统计 &
计算机科学与技术 (Computer Science) **类课程

---

## 1. 安装

> **请查看安装指南**
>
> | 语言 | 文件 |
> |---|---|
> | 中文 | [Installation_zh-CN.md](Installation_zh-CN.md) |
> | English | [Installation_en.md](Installation_en.md) |
> | 日本語 | [Installation_jp.md](Installation_jp.md) |
>

### 分享/迁移到另一台机器

插件是**自包含的一个目录**（12 个文件、没有依赖文件）
复制目录 + 两处配置就是完整安装。

要复制的目录：

```
dsh-lecture-copilot/
  package.json            包声明：dsh.bundle.patch + dsh.client
  cordis.patch.yml        bundle 补丁：往 profile 根插入一行
  lib/  index.js client.js state.js notes.js tools.js prompts.js
        onenote.js note-xml.js onenote-store.js
  host/ onenote.ps1       OneNote COM 桥（仅 Windows 有用）
                         （但无论是否对你有用，也请务必复制）
```

**在目标机器上：**

**1. 将插件放置在目录中**，例如 `~/dsh-plugins/dsh-lecture-copilot`。

**2. 链接Deepseek Harness**。用 Harness 自带的 pnpm（Node 和 pnpm 启动器都给了，不用另装喵）：

```powershell
# Windows
$env:ELECTRON_RUN_AS_NODE="1"
& "你的DSH所在盘符:\deepseekHarness\DeepSeek Harness.exe" `
  "你的DSH所在盘符:\deepseekHarness\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" "link:<PLUGIN>"
```

```bash
# macOS / Linux
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "<Harness>/resources/runtime/pnpm/bin/pnpm.cjs" \
  add --dir "$HOME/.dsh/profiles/desktop" "link:<PLUGIN>"
```
如果 pnpm 路径不确定，直接手写链接也行：在 `~/.dsh/profiles/desktop/node_modules/` 下建一个名为 `dsh-lecture-copilot-plugin` 的目录符号链接指向 `<PLUGIN>`。

**3. 改动两个文件**（`~/.dsh/profiles/desktop/`）：

`package.json` —— 加依赖、并把插件加进 bundles：
```json
{
  "dependencies": { "dsh-lecture-copilot-plugin": "link:<PLUGIN>" },
  "dsh": { "profile": { "bundles": [ …, "dsh-lecture-copilot-plugin" ] } }
}
```

`cordis.patch.yml` —— 末尾追加：
```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  disabled: false
```

**4. 冷启动 Harness**

查看是否有“课堂同传”按钮

或者 

打开 `http://127.0.0.1:19387/lecture-copilot/health` 确认返回 `plugin: dsh-lecture-copilot`。

---

## 2. 使用

1. 点击右下角的 **🎧 课堂同传**（就在侧栏上方、输入框右侧的空白层里）。
2. 会请求麦克风权限，**允许**（Harness 页面是 `localhost`，所以上下文是安全的存于本地）。
3. 开始上课。面板里每讲完一句就会出现：
   - 灰色小字：英文原文
   - 正文：中文翻译（术语会带英文原词，公式与代码标识符保持原样）
4. 课程结束，再按一次 **■ 结束并整理**。等剩余翻译排队完成后，插件就会读整堂课转写生成笔记，并自动展开。
5. 课后在对话里直接问，例如：
   - “把刚才那节课的逻辑链再讲一遍”
   - “这节课讲了哪些知识点？按考试重点排序”
   - “老师推的那个结论，第二步为什么成立？”

   助手就会调用插件注册的两个工具：`lecture_transcript`（取双语转写）与 `lecture_review`（取/重新生成复习笔记）。

**面板按钮**

| 按钮 | 作用 |
|---|---|
| ● 开始听课 | 开始一次新的课堂录音（会清空上一堂的内容） |
| ■ 结束并整理 | 停止录音 → 补完翻译 → 生成复习笔记 |
| 查看笔记 / 收起笔记 | 展开或收起笔记全文 |
| 模型 | 分别选择`识别 & 翻译` 和 `整理并生成笔记` 两个功能的模型以及推理等级 |
| 导出OneNote <br/>**（仅Windows有效）** | 在整理完笔记后自动将整理好的笔记导出到OneNote指定笔记本/分区/页面 |
| 清空 | 丢弃当前课堂内容（本地与后台一起清） |
| 收起 | 收起面板，回到悬浮按钮 |

### macOS 的可用性

**OneNote导出功能不可用，其余绝大部分可用**

| 部分 | 依赖 | macOS |
|---|---|---|
| 录音、VAD 分段、WAV 编码、上传 | 浏览器 API（`getUserMedia` / `AudioContext`） | **可用** |
| 本地识别（SenseVoice） | 本机自带的 `speechToText` 服务 | **可用**（由 Harness 提供给两端） |
| 实时翻译、生成复习笔记 | `llm`提供 | **可用** |
| 面板与所有按钮 | React | **可用** |
| **导出到 OneNote** | Windows PowerShell + OneNote 的 **COM 自动化** | **不可用** |

**以后是否考虑在macOS上适配OneNote导出？**

Ans: 技术上不可行，macOS 上 OneNote 是沙盒应用，没有 COM，也没有等价的本地自动化接口

如果呼声大，潜在可行方向是**Microsoft Graph API** 但现在的我比较懒（躺

可以自行适配Graph API，祝你好运

---

## 3. 复习笔记的结构

停止录音后自动生成的 Markdown 笔记固定为六节：

1. **课堂主线** — 3~6 条，写清“先讲什么、再讲什么、为什么这样推进”
2. **逻辑链** — 本次课的核心。用 `前提/定义 → 构造或假设 → 关键推导 → 结论` 的箭头链，每步说明为什么能从上一步行来；含公式（行内 LaTeX）
3. **知识点** — 按主题分组，每条写成 `**中文术语（English term）**：一句话定义/结论`，必要时补“要点/易错点”
4. **公式与代码速查** — 便于背诵的清单，公式用 LaTeX，伪代码用围栏代码块
5. **术语对照表** — `| 英文 | 中文 | 说明 |`
6. **待确认与作业线索** — 转写不清处、教师留的练习、可推断的考点

---

## 4. 配置

配置写在 profile 的 `cordis.patch.yml` 里，覆盖 `lecture-copilot` 行：

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  config:
    language: en          # 全英文课建议 en；中英混说保持 auto
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: max
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 跟随组合默认模型 | 翻译与笔记使用的模型路由 |
| `reasoningEffort` | 跟随默认模型 | 推理强度覆盖 |
| `language` | `auto` | 识别语言提示 |
| `minSegmentBytes` | 6400 | 短于此的片段丢弃（约 0.2 秒） |
| `maxSegments` | 2000 | 单次课堂保留的最大段数 |
| `statusMinMs` | 900 | 一段最短显示“翻译中”的时间，避免闪烁 |
| `translationTemperature` | 0 | 翻译采样温度 |
| `translationTimeoutMs` / `translationMaxTokens` | 60000 / 4096 | 单段翻译预算 |
| `reviewTimeoutMs` / `reviewMaxTokens` | 300000 / 32000 | 整堂笔记预算 |

配置字段有下限保护：手填的值过小会被抬到下限，非数字会退回默认值，未知字段会被拒绝——插件本身只可能损失调参，
不会因为一处配置写错而整行不加载。

---

## 5. 源码结构（适用于开发者）

| 文件 | 职责 |
|---|---|
| `package.json` | 包声明：`dsh.bundle.patch` + `dsh.client`（web 半），零运行时依赖 |
| `cordis.patch.yml` | bundle 补丁：向 profile 根插入 `lecture-copilot` 一行 |
| `lib/index.js` | Host 半：配置校验、`Config`（standard-schema）、`lectureCopilot` 会话服务、7 个 HTTP 路由、模块装配 |
| `lib/prompts.js` | 两条提示词（同传翻译 / 复习笔记）与转写渲染 |
| `lib/notes.js` | 模型调用：解析模型路由、流式取全文、翻译与笔记封装、失败原因回传 |
| `lib/tools.js` | 两个面向模型的工具：`lecture_transcript`、`lecture_review` |
| `lib/client.js` | 浏览器半：悬浮按钮与双语面板、麦克风采集、VAD 分段、WAV 编码、同源上传、导出对话框 |
| `lib/state.js` | 面板状态（可执行测试的那一份；client.js 内联同一块，脚本逐字符比对） |
| `lib/onenote.js` | OneNote 桥（Node 半）：`list` / `readPage` / `create` / `append`，把 JSON 喂给 PowerShell 子进程 |
| `lib/note-xml.js` | 复习笔记 Markdown → OneNote XML；标题生成 |
| `lib/onenote-store.js` | 记住用过的笔记本/分区/页面，并在每次读取时按现况过滤 |
| `host/onenote.ps1` | OneNote COM 自动化（PowerShell 半）：列目录、读页、建页、追加 |
| `Installation_zh-CN.md` | 给新机器用的安装手册（中文） |
| `Installation_en.md` | 给新机器用的安装手册（English） |
| `Installation_jp.md` | 给新机器用的安装手册（日本語） |
| `../dsh-lecture-copilot-verify/verify.mjs` | 离线端到端行为验证（173 项检查） |
| `../dsh-lecture-copilot-verify/render-panel.mjs` | 面板渲染验证（61 项检查） |
| `../dsh-lecture-copilot-verify/cold-boot-check.mjs` | 冷启动就绪度检查（解析 / inject / Config schema / 客户端模块 id） |
| `../dsh-lecture-copilot-verify/live-e2e.ps1` | 在线端到端自检（真实音频） |
| `../dsh-lecture-copilot-verify/onenote-probe.mjs` | 对真实 OneNote 的读写验证（默认只读；`--append` 才写入） |
| `../dsh-lecture-copilot-verify/onenote-routes.mjs` | 真实路由 + 真实 OneNote 的联调（默认只读） |
| `../dsh-lecture-copilot-verify/bundle-resolve-check.mjs` | 重启路径检查：profile 是否解析到**当前**的客户端文件（15 项检查） |
| `../dsh-lecture-copilot-verify/css-layout-probe.mjs` | 真实浏览器（Edge headless）里的布局与滚动验证（12 项检查） |
| `../dsh-lecture-copilot-verify/client-bundle-probe.mjs` | 真实浏览器加载并运行发布的客户端 bundle（10 项检查） |
| `../dsh-lecture-copilot-verify/real-react-probe.mjs` | 真实 React 18 渲染面板并点击候选（20 项检查，`vendor/` 内置 React） |
| `../dsh-lecture-copilot-verify/requirement-audit.mjs` | 逐条需求对照实现（40 项检查） |
| `../dsh-lecture-copilot-verify/sync-state-block.mjs` | 把 `state.js` 的状态块同步进 `client.js`（改完状态一定要跑） |
