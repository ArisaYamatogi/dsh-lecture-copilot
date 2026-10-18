# DSH Lecture Copilot
### 一款服务于Deepseek Harness桌面端的实时翻译同传+一键生成课堂笔记的插件

### 能做什么？
按下麦克风按钮 → 实时把老师讲的英文讲解转写成文字并翻译成中文
→ 再次按下结束录音 → 自动整理出**逻辑链 + 知识点**的复习笔记
→ 还可**自动导出至OneNote**（仅限Windows）

特化场景：全英文授课的**高等数学 (Advanced Mathematics) / 线性代数 / 概率统计**以及**计算机科学与技术Computer Science**类课程

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

插件是**自包含的一个目录**（没有依赖文件）
复制目录 + 两处配置就是完整安装。

要复制的目录：

```
dsh-lecture-copilot/
  package.json            包声明：dsh.bundle.patch + dsh.client + engines + dsh.compatibility
  cordis.patch.yml        bundle 补丁：往 profile 根插入一行
  LICENSE                 GPL-3.0 全文（与 package.json 的 license 一致）
  lib/  index.js client.js state.js notes.js tools.js prompts.js
        onenote.js note-xml.js onenote-store.js latex-mathml.js
  host/ onenote.ps1       OneNote COM 桥（仅 Windows 有用）
                         （但无论是否对你有用，也请务必复制）
```

**不要**把 IDE 目录（`.idea/`）或本地验证目录（`dsh-lecture-copilot-verify/`）放进这个仓库：
它们会让 DSH STORE 的固定源扫描判定为不完整（原因见 §5.6）。

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
| 模型 | 分三行独立选择：**识别**（转写引擎 + 语言）、**翻译**（模型 + 推理等级）、**整理并生成笔记**（模型 + 推理等级） |
| 导出OneNote <br/>**（仅Windows有效）** | 在整理完笔记后自动将整理好的笔记导出到OneNote指定笔记本/分区/页面 |
| 清空 | 丢弃当前课堂内容（本地与后台一起清） |
| 收起 | 收起面板，回到悬浮按钮 |

### 识别与翻译是两件事

面板的「模型」里有三行，对应流水线上三个独立阶段：

| 行 | 控制什么 | 可选项 |
|---|---|---|
| **识别（转写引擎）** | 谁把音频转成英文原文 | `本机识别`（Harness 的 `speechToText`，即本机 SenseVoice）+ profile 里登记的 HTTP ASR 引擎（见 §4 `asrProviders`） |
| **翻译（每段实时）** | 谁把英文原文翻成中文 | `llm` 模型目录里的任意模型 + 该模型的推理等级 |
| **整理并生成笔记（结束录音后）** | 谁在课后写复习笔记 | 同上，独立选择 |

识别引擎没有「推理等级」可选——ASR 不做推理，这个选项属于下面两行。三行都随时可改：下一次转写/翻译就生效，
笔记那一行因为要等你按「结束并整理」才开始，总是来得及。

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
    provider: deepseek-official   # 通用兜底路由
    model: deepseek-flash
    reasoningEffort: max
    # 识别：除本机 SenseVoice 外，再登记本地 HTTP ASR 引擎（OpenAI 兼容）
    asrEngine: harness            # 只写默认引擎；'harness' = Harness speechToText
    asrProviders:
      - id: whisper-npu
        label: Whisper Large V3 Turbo (NPU)
        baseURL: http://127.0.0.1:8022/v1
        model: whisper-large-v3-turbo-int8-ov
      - id: qwen-asr
        label: Qwen3 ASR (GPU)
        baseURL: http://127.0.0.1:8020/v1
        model: qwen3-asr
        languages: [auto, en, zh]   # 可选：若不写则用内置语言表
    # 翻译/笔记：各自的路由（不写则跟随上面的通用路由）
    translationProvider: deepseek-official
    translationModel: deepseek-flash
    translationReasoningEffort: off
    reviewProvider: deepseek-official
    reviewModel: deepseek-v4-pro
    reviewReasoningEffort: high
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `asrEngine` | `''`（= `harness`） | 默认识别引擎 id；`harness`（或 `speechToText`）表示用 Harness 自带的 `speechToText` |
| `asrProviders` | `[]` | 额外识别引擎列表，每个是一个 OpenAI 兼容 `/audio/transcriptions` 服务：`id`/`baseURL`/`model` 必填，`label`、`apiKeyEnv`、`languages` 可选 |
| `provider` / `model` | 跟随组合默认模型 | 翻译与笔记的**通用兜底**路由 |
| `reasoningEffort` | 跟随默认模型 | 通用推理强度兜底 |
| `translationProvider` / `translationModel` / `translationReasoningEffort` | 跟随通用路由 | 实时翻译这一路的路由 |
| `reviewProvider` / `reviewModel` / `reviewReasoningEffort` | 跟随通用路由 | 课后笔记这一路的路由 |
| `recognitionProvider` / `recognitionModel` / `recognitionReasoningEffort` | 跟随通用路由 | **已废弃**：拆分前的旧名字，实际一直控制翻译；仍然生效，优先级低于 `translation*` |
| `language` | `auto` | 识别语言提示 |
| `minSegmentBytes` | 6400 | 短于此的片段丢弃（约 0.2 秒） |
| `maxSegments` | 2000 | 单次课堂保留的最大段数 |
| `statusMinMs` | 900 | 一段最短显示“翻译中”的时间，避免闪烁 |
| `translationTemperature` | 0 | 翻译采样温度 |
| `translationTimeoutMs` / `translationMaxTokens` | 60000 / 4096 | 单段翻译预算（同时用作单次识别的超时上限） |
| `reviewTimeoutMs` / `reviewMaxTokens` | 300000 / 32000 | 整堂笔记预算 |

识别引擎的失败边界：地址连不上、返回非 2xx、返回的不是 JSON、或返回空文本，都会在面板上给出**带引擎名**的原因，
不会假装“老师这段没说话”。

配置字段有下限保护：手填的值过小会被抬到下限，非数字会退回默认值，未知字段会被拒绝——插件本身只可能损失调参，
不会因为一处配置写错而整行不加载。

---

## 5. 兼容范围与权限声明

### 5.1 仓库与许可证

| 项目 | 值 |
|---|---|
| canonical 仓库 | `https://github.com/ArisaYamatogi/dsh-lecture-copilot`|
| 许可证 | **GPL-3.0** |
| 第三方代码 | 只有开发验证目录 `dsh-lecture-copilot-verify/vendor/` 内置了 React 18 的 UMD 构建（Facebook，MIT），仅用于离线渲染验证，不进入插件运行时，也不进入 `files` 清单 |

### 5.2 兼容范围

| 维度 | 声明 | 说明 |
|---|---|---|
| Node.js | `engines.node: ">=22.19.0"` | 与 DSH 桌面版自带运行时一致（随包 Node **24.18.1**，`libreoffice-kit` 要求 `>=22.19.0`）。`.github/workflows/node.js.yml` 的 CI 矩阵与之下限一致 |
| DSH | `engines.dsh: ">=0.2.0-rc.2 <0.3.0"`，同时在 `dsh.compatibility.dsh` 里重复声明同一范围 | 范围与逐版本声明必须一致；有精确记录的版本以 `dshReleases` 为准 |
| 逐版本记录 | `dsh.compatibility.dshReleases`：`0.2.0-rc.2 = compatible`（本机验证环境），`0.2.1-alpha.1/2/3 = unknown`（尚未验证），`0.1.x` 与 `rc.7/rc.8 = incompatible` | **范围命中不等于运行验收**：未经一次性 Profile 实测的版本一律记 `unknown`，不写成 `compatible` |
| 插件形态 | Host 半 + 浏览器半（`dsh.client.platform: web`），Bundle 入口 ID `lecture-copilot` | 不加载、不禁用、不替换任何 `@deepseek-ai/*` 官方组件 |
| 平台 | Windows (功能完整)；macOS/Linux 可录音、识别、翻译、生成笔记，**OneNote 导出不可用** | / |

### 5.3 权限声明（按固定 Commit 源码保守填写）

| 访问类型 | 实际能力 | 具体位置 |
|---|---|---|
| 文件 | **write**（仅插件自己的状态文件） | `lib/onenote-store.js` 在 `$DSH_HOME/storages/lecture-copilot/onenote-destinations.json` 读写"用过的笔记本/分区/页面"；不触碰 Profile、会话目录或其他 storages |
| 网络 | specified-services：同源 loopback + **仅** profile 登记过的 ASR 地址 | `lib/client.js` 以 `credentials: 'same-origin'` 请求 Harness 本地路由（`http://127.0.0.1:<port>/lecture-copilot/*`）；配置了 `asrProviders` 时，Host 半只向**这些登记的 baseURL** 发 `POST /audio/transcriptions`（默认不配置，即完全不发）；**不访问任何其他地址**，没有遥测与上报 |
| 命令 | restricted | `lib/onenote.js` 用固定参数数组 `spawn` 本机 PowerShell 执行 `host/onenote.ps1`（`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>`，无 shell 字符串拼接），驱动 OneNote 的 COM 自动化；该子进程只在用户点击"导出 OneNote"时才启动 |
| 凭据 | **none**（不读取、不存储、不转发） | `lib/notes.js` 的模型调用走 Harness 的 `llm` 服务，由宿主管模型路由与凭据；插件自身不读环境里的密钥、token 或系统钥匙串 |
| 汇总等级 | **high** | 触及插件私有持久状态、会启动本机子进程；均在本节逐项披露 |

### 5.4 外部依赖与外部服务

| 依赖 | 用途 | 缺失时的行为 |
|---|---|---|
| Node.js ≥ 22.19.0 | 宿主运行时（DSH 自带） | — |
| Windows PowerShell（`pwsh.exe` 或 `powershell.exe`）+ 桌面版 OneNote | 仅"导出 OneNote" | 按钮不可用，面板显示"OneNote is not available on this machine"，其余功能不受影响 |
| 模型服务（DeepSeek 等，经 Harness 的 `llm`） | 翻译与生成复习笔记 | 转写仍可用，翻译/笔记给出失败原因 |
| 本机语音识别（Harness 的 `speechToText` / SenseVoice） | 默认的英文转写 | 面板提示识别失败，不产出错误文本 |
| 可选的本地 ASR 服务（如 Whisper / Qwen3-ASR，OpenAI 兼容 `/audio/transcriptions`） | 由 `asrProviders` 登记后作为识别引擎 | 该引擎不可用时面板报“识别引擎 X 连接失败/返回 HTTP …”，可切回本机识别；不影响翻译与笔记 |
| GitHub | 仅发布与上架验证时使用 | 与插件运行无关 |

### 5.5 失败边界

- **配置**：数值型字段低于下限时抬到下限，非数字退回默认，未知字段被拒绝；一行配置写错只会损失调参，不会让整行加载失败。
- **翻译 / 笔记**：单段翻译有 `translationTimeoutMs`（默认 60s）与 `translationMaxTokens`；整堂笔记有 `reviewTimeoutMs`（默认 300s）与 `reviewMaxTokens`；课堂段数上限 `maxSegments`（默认 2000）。
- **导出**：OneNote 桥调用 60s 超时，超时杀子进程并返回可读原因。
- **写入**：导出流程是"只增不减"——先读页面、再追加一个 `one:Outline` 写回，从不删页、删元素或覆盖整页；找不到笔记本/分区/页面时直接拒绝并说明，不做猜测替代。
- **网络**：只使用同源 loopback，失败即报错，没有外部重试与回退上报。
- **记忆的导出目的地**：只是提示，不是权威；每次展示与实际写入前都会重新对照实时笔记本树，已改名/已关闭的项会被丢弃。

### 5.6 仓库扫描面卫生

DSH STORE 的固定源扫描会走**完整仓库树**（不是 `files` 白名单），只要树里出现不是
源码、不是静态资源、也不是元数据的文件，扫描就被判定为"不完整"，项目会被推回人工审阅——
即使插件本身没问题。已实测踩过的两个坑：

| 坑 | 后果 | 现状 |
|---|---|---|
| 把本地验证目录 `dsh-lecture-copilot-verify/` 提交进插件仓库 | 验证脚本自己的文件/网络/命令信号会被算进插件能力面，还会被判为"本地模块不在分发面内" | 已从版本库移除（验证套件留在插件仓库的**兄弟目录**） |
| 仓库根目录的 `.gitattributes` / `.gitignore` | 它们自身不是可扫描源码，会被列为"不支持的制品"，扫描直接不完整 | 已删除；`.gitignore` 只作为**本机**忽略规则存在，刻意不提交 |

清理前后（用 Store 的真实 `reviewFixedSource` 对本地树跑）：

```
清理前：scanComplete=false，能力证据 30 条（含 verify/ 与 vendor/ 的开发工具）
清理后：scanComplete=true， 能力证据  6 条，全部在 lib/ 与真实功能一一对应
```

**因此：不要往这个仓库里提交 IDE 目录、验证脚本、备份文件或本地截图。**

### 5.7 本仓库的上架自检

```powershell
node ../dsh-lecture-copilot-verify/store-contract-check.mjs
```

按 DSH STORE 固定源自动策略的同一组判定，逐条检查本仓库 manifest
`repository` / `license` / `files` / `engines.dsh` / `engines.node` / `dsh.compatibility`，
并确认声明与仓库身份、许可证文件、CI 矩阵、仓库扫描面一致

---

## 6. 源码结构（适用于开发者）

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
| `../dsh-lecture-copilot-verify/store-contract-check.mjs` | DSH STORE 上架契约自检（repository / license / files / engines / dsh.compatibility） |
