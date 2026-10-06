# 课堂同传 Lecture Copilot — DeepSeek Harness 桌面端插件

按下麦克风按钮 → 实时把全英文课堂讲解转写成英文并翻译成中文 → 再次按下结束录音 → 自动整理出**逻辑链 + 知识点**的复习笔记。

面向场景：大学全英文授课的**高等数学 / 线性代数 / 概率统计**与**计算机科学与技术**类课程。

---

## 1. 它是怎么工作的

```
                  Harness 界面（浏览器半）
   ┌─────────────────────────────────────────────────────┐
   │  🎧 课堂同传  悬浮按钮 + 双语实时面板                  │
   │  getUserMedia → 语音活动检测分段 → 16kHz PCM16 WAV   │
   └───────────────────────┬─────────────────────────────┘
                           │ 同源 fetch（浏览器会话 Cookie 鉴权）
                           ▼
                  Harness 宿主进程（Host 半）
   ┌─────────────────────────────────────────────────────┐
   │  /lecture-copilot/audio   ← 一段音频                  │
   │        ↓ ctx.speechToText（本机 SenseVoice，离线）     │
   │      英文原文 ────────────► 立即回给面板显示            │
   │        ↓ ctx.llm（串行队列，保持讲课顺序）              │
   │      中文翻译 ────────────► 面板显示                   │
   │  /lecture-copilot/stop    ← 结束                      │
   │        ↓ 全文转写 → 复习笔记（逻辑链/知识点/公式速查）  │
   └─────────────────────────────────────────────────────┘
```

**关键取舍**

| 问题 | 处理方式 |
|---|---|
| 本机识别模型是一次性（整段）识别，没有流式接口 | 在**句间自然停顿**处切段，而不是定长切片。定长切片会切在词中间，识别率明显下降 |
| 翻译比识别慢 | 英文原文先显示，中文随后补齐；翻译**串行排队**，保证译文顺序与讲课顺序一致 |
| 老师语速快、长时间不停顿 | 每 14 秒强制切一段，保证延迟有上界 |
| 说话开头的爆破音/首字被切掉 | 保留 8 帧（约 0.7 秒）**预滚缓冲**，检测到人声时把停顿也带上 |
| 长时间课程内存增长 | 段数上限默认 2000 段，超出丢最旧的 |
| 笔记靠模型自由发挥会编造 | 复习提示词明确禁止补充转写中没有的知识，要求标注“（补充）”“（转写存疑）” |

---

## 2. 安装

> **要装到另一台机器（尤其中文/英文/日文界面）请直接看专门的手册** —— 它们是给「拿到这个目录的人」写的，不依赖本机任何背景：
>
> | 语言 | 文件 |
> |---|---|
> | 中文 | [Installation_zh-CN.md](Installation_zh-CN.md) |
> | English | [Installation_en.md](Installation_en.md) |
> | 日本語 | [Installation_jp.md](Installation_jp.md) |
>
> 三份内容等价：目录内容 → 四步安装 → 验证 → 排错 → 平台差异（macOS）→ 卸载。下面这一节是本机开发时的记录。

本插件是**零依赖**的：`lib/` 只 import Node 内建模块和自己的文件。这是刻意的设计——profile 目录里没有 `@deepseek-ai/*` 作用域，profile 安装的插件只能从启动器的运行时可解析那些包，所以不引入任何外部依赖才让「复制一个目录」成为完整的安装方式。

**安装位置**（已完成，profile 直接链接到本目录）：

```
C:\Users\21888\Documents\deepseek-harness\
        default-workspace\dsh-lecture-copilot   ← 插件本体（package.json / lib / cordis.patch.yml）
        default-workspace\dsh-lecture-copilot-verify\verify.mjs ← 自检脚本
```

`~/.dsh/profiles/desktop/node_modules/dsh-lecture-copilot-plugin` 是指向本目录的符号链接，所以改了源码只要重启 Harness 就生效。

**profile 侧的状态**（已完成）：

- `~/.dsh/profiles/desktop/package.json`
  - `dependencies["dsh-lecture-copilot-plugin"] = link:…/default-workspace/dsh-lecture-copilot`
  - `dsh.profile.bundles` 追加 `dsh-lecture-copilot-plugin`
- `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加
  ```yaml
  - id: lecture-copilot
    name: "dsh-lecture-copilot-plugin"
    disabled: false
  ```

**重新安装 / 迁移到别的机器**

```powershell
# 1. 复制本目录到任意位置（建议放在 C: 上，与 profile 同盘）
# 2. 用 Harness 自带的 pnpm 建立链接
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\deepseekHarness\DeepSeek Harness.exe" `
  "D:\deepseekHarness\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" `
  "link:<复制后的绝对路径>"
# 3. 按上面的 YAML/JSON 片段补齐 package.json 与 cordis.patch.yml
# 4. 重启 DeepSeek Harness（bundle 组成的改动需要冷启动）
```

**卸载**：从 `dsh.profile.bundles` 删掉 `dsh-lecture-copilot-plugin`，移除 `dependencies` 里那一行，删除 `cordis.patch.yml` 末尾的 `lecture-copilot` 条目，重启。

### 分享到另一台机器

插件是**自包含的一个目录**（12 个文件、约 200 KB、零依赖）。复制目录 + 两处配置就是完整安装。

要复制的目录（整个拷过去，**`host/onenote.ps1` 必须一起带上**，它在 `lib/` 外面）：

```
dsh-lecture-copilot/
  package.json            包声明：dsh.bundle.patch + dsh.client
  cordis.patch.yml        bundle 补丁：往 profile 根插入一行
  lib/  index.js client.js state.js notes.js tools.js prompts.js
        onenote.js note-xml.js onenote-store.js
  host/ onenote.ps1       OneNote COM 桥（仅 Windows 有用）
```

目标机器上的四步（`<PLUGIN>` = 复制后的绝对路径）：

**1. 放好目录**，例如 `~/dsh-plugins/dsh-lecture-copilot`。

**2. 建立链接**。用 Harness 自带的 pnpm（Node 与 pnpm 都由启动器提供，机器上不需要另装）：

```bash
# macOS / Linux
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "<Harness>/resources/runtime/pnpm/bin/pnpm.cjs" \
  add --dir "$HOME/.dsh/profiles/desktop" "link:<PLUGIN>"
```

```powershell
# Windows
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\deepseekHarness\DeepSeek Harness.exe" `
  "D:\deepseekHarness\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" "link:<PLUGIN>"
```

如果 pnpm 路径不确定，直接手写链接也行：在 `~/.dsh/profiles/desktop/node_modules/` 下建一个名为 `dsh-lecture-copilot-plugin` 的目录符号链接指向 `<PLUGIN>`。

**3. 改两个文件**（`~/.dsh/profiles/desktop/`）：

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

**4. 冷启动 Harness**，然后打开 `http://127.0.0.1:19387/lecture-copilot/health` 确认返回 `plugin: dsh-lecture-copilot`。

**为什么 `name` 必须写对**：`cordis.patch.yml` 里那一行的 `name` 必须**逐字**等于 `package.json` 的 `name`（`dsh-lecture-copilot-plugin`）。不一致时那一行会以 `failed to import` 结束，而且不会有更具体的提示。

### macOS 上能用吗

**大部分能用，OneNote 导出不能用。**

插件分成两半，跨平台能力完全不同：

| 部分 | 依赖 | macOS |
|---|---|---|
| 录音、VAD 分段、WAV 编码、上传 | 浏览器 API（`getUserMedia` / `AudioContext`） | **可用** |
| 本地识别（SenseVoice） | 宿主自带的 `speechToText` 服务 | **可用**（由 Harness 提供给两端，与平台无关） |
| 实时翻译、生成复习笔记 | 宿主的 `llm` 服务（DeepSeek） | **可用** |
| 面板与所有按钮 | React，平台无关 | **可用** |
| **导出到 OneNote** | Windows PowerShell + OneNote 的 **COM 自动化** | **不可用** |

原因很直接：那一半靠 `New-Object -ComObject OneNote.Application`，而这是 Windows 的组件模型。macOS 上 OneNote 是沙盒应用，没有 COM，也没有等价的本地自动化接口。**这是平台限制，不是能改的 bug。**

失败方式是**干净的、不拖垮插件**：

- `/onenote` 会返回 `available: false` 加一条原因，面板显示原因而不是崩掉
- 这条路径有专门的测试：`onenoteStub({ available: false })` 断言路由仍返回 200 且 `reason` 是字符串；实测「可执行文件不存在」时 `spawn` 抛 `ENOENT`，桥把它转成 `{ ok: false, error: 'PowerShell failed: …' }`，从不向上抛
- 录制、翻译、复习笔记**完全不受影响** —— 它们是另外的代码路径

如果将来要在 macOS 上导出，可行的方向是走 **Microsoft Graph API**（`POST /me/onenote/…`）：那是 HTTP 接口，需要一次 OAuth 授权，两端都能用。但那是一块新功能，不是把现有的 PowerShell 桥移植过去。


---

## 3. 使用

1. 点右下角的 **🎧 课堂同传**（在侧栏上方、输入框右侧的空白层里）。
2. 浏览器会请求麦克风权限，**允许**（Harness 页面是 `127.0.0.1`，属于安全上下文，可用）。
3. 开始上课。面板里每讲完一句就会出现：
   - 灰色小字：英文原文（便于核对教学习惯用语与专有名词）
   - 正文：中文翻译（术语会带英文原词，公式与代码标识符保持原样）
4. 课程结束，再按一次 **■ 结束并整理**。等剩余翻译排队完成后，助手会读整堂课转写生成笔记，并自动展开。
5. 课后在对话里直接问，例如：
   - “把刚才那节课的逻辑链再讲一遍”
   - “这节课讲了哪些知识点？按考试重点排序”
   - “老师推的那个结论，第二步为什么成立？”

   助手会调用插件注册的两个工具：`lecture_transcript`（取双语转写）与 `lecture_review`（取/重新生成复习笔记）。

**面板按钮**

| 按钮 | 作用 |
|---|---|
| ● 开始听课 | 开始一次新的课堂录音（会清空上一堂的内容） |
| ■ 结束并整理 | 停止录音 → 补完翻译 → 生成复习笔记 |
| 查看笔记 / 收起笔记 | 展开或收起笔记全文 |
| 清空 | 丢弃当前课堂内容（本地与后台一起清） |
| 收起 | 收起面板，回到悬浮按钮 |

---

## 4. 复习笔记的结构

停止录音后自动生成的 Markdown 笔记固定为六节：

1. **课堂主线** — 3~6 条，写清“先讲什么、再讲什么、为什么这样推进”
2. **逻辑链** — 本次课的核心。用 `前提/定义 → 构造或假设 → 关键推导 → 结论` 的箭头链，每步说明为什么能从上一步行来；含公式（行内 LaTeX）
3. **知识点** — 按主题分组，每条写成 `**中文术语（English term）**：一句话定义/结论`，必要时补“要点/易错点”
4. **公式与代码速查** — 便于背诵的清单，公式用 LaTeX，伪代码用围栏代码块
5. **术语对照表** — `| 英文 | 中文 | 说明 |`
6. **待确认与作业线索** — 转写不清处、教师留的练习、可推断的考点

---

## 5. 配置

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

配置字段有下限保护：手填的值过小会被抬到下限，非数字会退回默认值，未知字段会被拒绝——插件本身只可能损失调参，不会因为一处配置写错而整行不加载。

---

## 6. 自检与排错

**宿主端点**

| 端点 | 用途 |
|---|---|
| `GET /lecture-copilot/health` | 插件是否挂载、识别器是谁、模型路由、各服务是否可用 |
| `GET /lecture-copilot/state?since=<id>` | 面板轮询的增量状态 |
| `GET /lecture-copilot/review` | 笔记全文 |
| `POST /lecture-copilot/start` `…/audio` `…/stop` `…/clear` | 录音生命周期与音频上传 |

浏览器里直接打开 `http://127.0.0.1:19387/lecture-copilot/health` 就能看到宿主侧的自检结果。

**在线端到端自检**（对着运行中的 Harness 跑真实音频）

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
# 先合成一段英文讲课音频（Windows 内置 TTS，16kHz 单声道）
& "C:\Users\21888\Documents\deepseek-harness\default-workspace\dsh-lecture-copilot-verify\live-e2e.ps1"          # 转写 + 翻译
& "C:\Users\21888\Documents\deepseek-harness\default-workspace\dsh-lecture-copilot-verify\live-e2e.ps1" -Keep    # 保留会话，再手动调 /stop 出笔记
```

实测结果（2026-10-06，17.2 秒 TTS 讲课音频）：

| 环节 | 结果 |
|---|---|
| `GET /health` | 200，`speechToText/llm/tools/webServer` 全部 true，识别器 `sensevoice-local`（SenseVoiceSmall INT8，host-local） |
| `POST /audio` | 200，13.7 秒首次识别（模型冷加载）/ 0.4 秒热态 |
| 英文转写 | `Consider the function F of x equals x squared. Its derivative is two eggs by the power rule. Now suppose we want the limit of sine x over x as x1s to0. By the squeeze theorem that limit is equal to one.` |
| 中文翻译 | `考虑函数 F(x) = x²。根据幂法则（power rule），它的导数是 2x。现在假设我们要求 sin x / x 在 x 趋于 0 时的极限（limit）。根据夹逼定理（squeeze theorem），该极限等于 1。` |
| `POST /stop` | 200，9.7 秒出 2327 字笔记 |

笔记结构完整（六节俱全），LaTeX 正确，术语中英对照，并且**主动把 TTS 缺陷导致的识别错误标出来**：`two eggs` → 应为 $2x$、`as x1s to0` → 应为 $x\to 0$，都打了「（转写存疑）」，还指出夹逼定理的两侧函数构造「课上未展开」、是最大的逻辑跳跃点。

**离线行为自检**（不需要启动 Harness）

```powershell
# 行为：配置校验、7 个路由、健康探针、录音→转写→串行翻译、结束→笔记、两个工具、
#       降级与清理、迟到服务装配、时长口径、工具 schema 子集
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "C:\Users\21888\Documents\deepseek-harness\default-workspace\dsh-lecture-copilot-verify\verify.mjs"

# 冷启动就绪度：解析、inject、Config 的 standard-schema 校验、浏览器半的模块 id
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "C:\Users\21888\Documents\deepseek-harness\default-workspace\dsh-lecture-copilot-verify\cold-boot-check.mjs"
```

当前 **173/173**（宿主行为）＋ **61/61**（面板渲染）＋ **12/12**（浏览器布局）＋ **10/10**（bundle 加载）＋ **21/21**（真实 React 渲染与点击）＋ **15/15**（重启路径）＋ **43/43**（需求对照）＋ **19/19**（运行中服务器）＋ **18/18** ＋ **8/8**（真实 OneNote）＋ **READY: 0 failure(s)**。

> **已在运行中的 GUI 里确认可用（2026-10-06 22:06 重启后）。** 用户实测：导出正常、下拉能展开、**滚轮能滚动**、模型下拉里能看到 provider。
>
> **2026-10-06 22:35 又改了两处，需要再重启一次**：新增「分区」栏位（三栏：笔记本 → 分区 → 页面）、＋ 按钮改为由模型生成标题、分区不再靠推断。这三处都在**宿主侧**（lib/index.js、lib/notes.js），所以必须重启 Harness 才生效。实测当前运行中的 /onenote 仍返回 sections=0，正说明它跑的是改动前的宿主代码。
>
> 独立佐证：`~/.dsh/storages/lecture-copilot/onenote-destinations.json` 里出现了 `rememberedPages`（该字段只在**一次成功导出之后**才会写入），说明流程确实在运行中的应用里跑通过一次；`JNU / Adv. Maths 1 / 课堂笔记 2026-10-06 22:09` 那次导出生成的页面（16 段 / 2028 字符）也证明建页与写入都真实发生。
>
> 重启之所以必要：改动位于 `lib/*.js`，Node 的 ESM 缓存按 URL 且进程内不失效，**必须重启 Harness**（从会话内部重启会终止当前对话回合）。客户端模块 URL 带 `rev`（由 mtime 算出），所以不需要清浏览器缓存。

**五个容易踩的坑**（前三个由上面的脚本守着）

1. `cordis.patch.yml` 里那一行的 `name` 必须等于 `package.json` 的 `name`。两者不一致时那行会以 `failed to import` 结束。
2. `lib/client.js` 里 `__ModuleLoader__.load({ id })` 的 `id` 必须等于包名——客户端模块系统按包名登记与解析，写错就再也取不到这个模块。它的样式标签 id 与 `data-plugin` 也一并跟包名对齐。
3. **服务的读法**：`ctx.get(name)` 只在激活那一刻读一次，之后才出现的服务不会让它重试。任何挂到别的服务上的东西都必须走 `ctx.inject([...], (scoped) => …)`——它在依赖变化时会重新执行。这个坑的表现是「行是 active，但路由 404」，而且没有任何报错。
4. **工具 schema 的 `required`**：`@deepseek-ai/dsh-tools` 只接受它那个受控子集——`properties`/`required`/`additionalProperties` 只能出现在 `object` 上，`items` 只能出现在 `array` 上，标量字段上不能写 `required: true`，对象的 `required` 必须是**字符串数组**。写错会让整行以 `JsonSchemaError` 失败，连带 HTTP 路由一起消失。用真实校验器核对：

   ```powershell
   $env:ELECTRON_RUN_AS_NODE="1"
   & "D:\deepseekHarness\DeepSeek Harness.exe" "$env:TEMP\schema-check.mjs"
   # 脚本内容：import dsh-tools 的 assertSupportedJsonSchema，逐个过 createToolDefinitions() 的 schema
   ```

### 中式口音的识别优化，以及实测结果

本地识别器（SenseVoiceSmall INT8）是**固定模型**，不能微调、也没有热词或上下文偏置参数——我查过它的 provider 接口，只有 `languages` 与下载参数。所以「口音优化」只能落在两处：**喂给识别器的语言提示**，以及**识别之后、由 DeepSeek 承担的理解与消歧**。

**实测（`compare-accents.mjs`，5 个真人/神经语音 × 约 20 秒高数讲课音频）**

语料由 Edge 朗读服务合成：`en-HK-SamNeural`/`en-HK-YanNeural`（港式英语）、`en-SG-WayneNeural`（新加坡英语）、`zh-CN-YunxiNeural`（普通话音色读英文，最重口音）、`en-US-AndrewMultilingualNeural`（对照组）。

| 口音 | 转写结果（`language: en`） |
|---|---|
| 港式男声 | Consider the function f of x equals x squared. Its derivative is 2 x by the power rule. … sine x over x as x tends to0. … log in. |
| 港式女声 | … derivative is 2 x … as x1s to0. … log N. |
| 新加坡男声 | … derivative is2 x … as x tends to 0. … log N. |
| 普通话读英文 | … derivative is **to X** … as **x1s to 0**. … **loud an**. |
| 美音对照 | … **itss** derivative … as x tends to zero … log n. |

**三个结论**

1. **`language: en` 是纯收益**。`auto` 与 `en` 的转写几乎完全一致（模型本身多语种），但 `en` 消除了一个真实风险：中文口音下把一整段判成中文。现在这是默认值。
2. **错误是「谐音式」的**，而且高度集中在同一个位置：`log n` → `log in` / `loud an`；`2x` → `to X`；`x→0` → `x1s to0` / `tends to0`；`its` → `itss`。谐音错误恰好是**下游模型能还原的**——只要告诉它上下文。这正是提示词里那段「中式口音固定错误模式」清单要做的事，清单里的例子（`two eggs` / `x1s to0` / `n lawn`）全部来自实测。
3. **首次调用有 15.5 秒冷启动**（模型懒加载），之后每段 **0.5 秒**。面板上表现为「第一句要等一会儿」，不是故障。

**可配置的两项**（`cordis.patch.yml` 里 `lecture-copilot` 行的 config）：

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  config:
    language: en                       # 全英文课锁 en；中英混说改 auto
    context: 线性代数，全英文授课，教师为中文母语，教材 Gilbert Strang
    glossary:                          # 识别器容易听错的术语，按正确拼写写
      - eigenvalue
      - gradient descent
      - squeeze theorem
      - binary search
```

`context` 与 `glossary` 会**随每一段**一起送给翻译，也送给笔记整理——这是让模型把 `loud an` 还原成 `log n` 的唯一手段。

**如果要自建语料库**：`synth-corpus.py`（合成）＋ `Mp3ToWav.ps1`（转 16 kHz WAV）。Edge 朗读只出 24 kHz MP3，而插件只接受 16 kHz 单声道 PCM16 WAV，所以中间必须有一步转码；本机没有 ffmpeg，`Mp3ToWav.ps1` 用的是 Windows 自带的 `MediaTranscoder`。

```powershell
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py "…\dsh-lecture-copilot-verify\synth-corpus.py" "$env:TEMP\accents-mp3"     # 出 MP3
# 再用 Mp3ToWav.ps1 转 WAV（脚本文件受执行策略限制，需 -ExecutionPolicy Bypass 或内联执行）
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\deepseekHarness\DeepSeek Harness.exe" "…\dsh-lecture-copilot-verify\compare-accents.mjs" "$env:TEMP\accents"
```

---

## 6.1 中式口音优化、中断整理、按任务选模型

### 1. 整理笔记时按「清空」＝立即中断

`/clear` 现在会**中止**正在进行的笔记生成，而不是与它赛跑：

- Host 侧 `cancelReview()` 触发 `AbortController`，模型调用被中断，**产出被丢弃**——不会生成任何笔记，也不会留下半份笔记。
- 清理时把 `reviewStartedAt` 一并撤销，所以面板的等待循环也会停止；`reviewRef` 标志确保被取消的那一轮**再也无法把结果贴回已清空的界面**。
- 面板在整理阶段把这个按钮显示为红色的 **「清空并中断」**，并给出提示。

测试锁住的是：`/clear` 返回 `cancelledReview: true`、会话被清空、**放开被挂起的模型调用后 `lecture.review === undefined`**、面板既无笔记也不处于 pending。

### 2. 两个任务各自选模型与推理等级

面板底部新增 **「模型」** 按钮，展开两组选择器：

- **识别 & 翻译（每段实时）**
- **整理并生成笔记（结束录音后）**

每组都是「模型」＋「推理等级」两个下拉，第一项是 **默认 · `<组合默认>`**（跟随部署设置）。选项**不是硬编码**：宿主新增 `GET /models`，遍历 `llm.listProviders()` → `listModels()` → `resolveModelInfo()`，因此显示的就是启动器里那两个模型与那四档推理——`DeepSeek-V41-Flash` / `DeepSeek-V4-Pro`，`Off` / `Low` / `High` / `Max`。**只有声明了推理等级的模型才显示第二个下拉**，避免出现点了没反应的控件。

选择经 `POST /select` 写入会话，`resolveModel(ctx, config, task, override)` 的优先级是：**面板选择 → 任务专属配置 → 共享配置 → 组合默认 → 内置兜底**。测试断言翻译走识别档、笔记走笔记档、推理等级只落在它该去的那次调用上，且清空选择后回落到共享路由。

### 3. 课件上下文与术语表

见上一节：`context` 与 `glossary` 随每次调用下发，测试确认两段提示词都拿到了。

---


`dsh.profile.bundles` 的改动只在下一次启动时生效：正在运行的 Host 组合是在启动时装配的（本 profile 的 `hmr.config.root` 是空的，不监听目录）。另外 **Node 的 ESM 模块缓存按 URL 缓存且进程内不失效**：同一个行标识符在同一个进程里只会 import 一次，之后改磁盘上的文件、甚至禁用再启用那一行，跑的都还是第一次加载的那份代码。

| 改动 | 是否需要重启 |
|---|---|
| 第一次安装 / 改 bundle 名字 / 改 `dsh.profile.bundles` | 需要 |
| 改插件源码（`lib/*.js`） | 需要（除非把插件目录加进 `hmr.config.root`） |
| 只改 `cordis.patch.yml` 里那一行的 `config` | 不需要 |

判断是否已经生效：打开 `http://127.0.0.1:19387/lecture-copilot/health`，能返回 JSON 即为生效。

**当前运行进程与磁盘代码的差异**：这一版修掉了一个只在真机上才暴露的问题——笔记头部的时长口径。修好之前它把**绝对停止时间戳**当成时长，于是 17 秒的课被写成「课堂时长约 29854535 分钟」。现在改为：面板把自己测得的 `elapsedMs` 随 `/stop` 一起上报，没上报时回退到会话自己的起止时间差。这个修正在磁盘上、离线测试（第 9 组 4 项）已通过，但要等下一次重启才会在运行中的进程里生效。

**常见现象**

| 现象 | 原因 / 处理 |
|---|---|
| 看不到 🎧 按钮 | bundle 未选中或页面未刷新。检查 `package.json` 的 `bundles`，然后刷新页面 |
| 按钮在，但点开始后立刻报“无法连接后台服务” | Host 半没加载。访问 `/lecture-copilot/health` 应返回 JSON；404/405 说明该行没激活，需要重启 Harness 让 bundle 冷启动 |
| 首次识别很慢 | SenseVoice 模型首次使用要从 Hugging Face / HF-Mirror 下载（在「设置 → 插件 → 语音输入」可看进度、换源） |
| 只有英文没有中文 | `llm` 服务不可用或翻译调用失败；看面板顶部状态与 `/lecture-copilot/health` 的 `services.llm` |
| 面板显示“翻译失败：…” | 该段模型调用失败，后续段会继续；结束后仍可生成笔记 |
| 麦克风无权限 | 操作系统隐私设置里允许桌面应用使用麦克风 |

---

## 6.2 导出笔记到本机 OneNote

笔记生成后，面板底部出现 **「导出 OneNote」**。点开是一个两栏的对话框：**笔记本** 与 **页面**，两栏都可以直接输入，也可以从下拉里选。

**它只能增加，不能减少 —— 这是设计约束，不是当前实现状态。**

- `lib/onenote.js` 只导出 `list` / `readPage` / `create` / `append`，**代码库里没有任何删除 API**（`grep DeleteHierarchy` 为空）。
- 追加的语义是：先**读回**目标页面的完整 XML，把新内容作为一个新的大纲接在 `</one:Page>` 之前，再整页写回。原有内容原样还在。
- 每次追加都会在页面上留一个时间戳小标题（`—— 课堂同传 · 高等数学 · 课堂笔记 2026-10-06 15:30 ——`），方便日后一眼看出哪一段是哪次课加的。

**实测（`onenote-probe.mjs --append`，对一页真实笔记，201 字符）**

```
target: JNU / Temp / Academic Department: https://jwc.jnu.edu.cn
before: 201 characters
after:  573 characters
ok  the marker landed on the page that was targeted
ok  the page grew rather than being replaced
ok  the original content is still there
24/24 checks passed
```

**三个栏位与两个按钮**

对话框有三栏，顺序是**笔记本 → 分区 → 页面**，因为分区属于笔记本、页面属于分区。

| 操作 | 行为 |
|---|---|
| 输入/选择后点「导出到该页面」 | 字符串匹配（忽略大小写、子串即可，**完全相同优先**）笔记本与页面；命中则**追加** |
| 笔记本不存在 | `笔记本不存在：xxx`，**不写任何东西** |
| 页面不存在 | `「xxx」里没有这个页面：yyy`，**不写任何东西** |
| 点「＋ 新建页面」 | 在**所选笔记本 + 所选分区**内新建页面并写入；**标题由笔记内容自动生成** |
| 分区不存在 | `分区不存在：xxx`，**不写任何东西** |
| 没选分区就点 ＋ | `请先选择分区（「JNU」下有 2 个）`，**不写任何东西** |

**＋ 需要笔记本和分区同时选好**才可用（`disabled: busy || !notebook || !section`）；「导出到该页面」只需要笔记本和页面。

**分区是显式选择的，不再靠推断。** 之前是「找带今天日期的分区，否则用笔记本第一个」，实测落到了 `JNU / Adv. Maths 1` —— 一个用户从没选过的地方。现在分区必须由用户指定，选不到就报错，**不再拿默认值顶替**。

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  config:
    titleTimeoutMs: 15000     # 模型给新页面起名的最长等待；超时则回退到日期标题
```

**新页面的标题由模型读笔记内容生成**

标题不再是固定的 `课堂笔记 日期 时间`，而是让模型读笔记概括出一个很短的题目 —— 讲定积分就叫「定积分」。实现要点：

- **`reasoningEffort: 'off'`** —— 起个名字不需要推理，而且用户正在等这次点击
- **`temperature: 0`、`maxTokens: 64`**，只把笔记**前 2000 字符**发过去：为了四个字把三万字发出去是浪费
- **回复被硬性清洗**后才当页名用：去掉 `标题：` 之类前缀、`「」《》【】（）` 与成对引号、Markdown 强调、句末标点、以及 OneNote 页名不允许的 `\ / ? * [ ] :`；只取第一行；上限 24 个字符
- **模型失败不影响建页**：超时或报错时回退到日期标题，按钮照常可用；返回体里的 `namedByModel` 会说明用的是哪一种

清洗规则是纯函数（`normalizeTitle`），所以有 17 项断言钉着它 —— 包括 `标题：「定积分/极限 * 应用题？」` 这种输入必须变成一个合法的页名。

**下拉里的选项怎么来的**

- **候选列表不是 `datalist`，是本组件自己画的一层。** 一开始用的是 `<datalist>` + `<option>`，实测在你的界面上**完全不弹**、滚轮也没反应：datalist 的弹层是浏览器在**操作系统层**开的独立窗口，不受页面 CSS 控制，而面板是一个自带 `isolation:isolate` 的固定层叠上下文——弹层落在面板之外。它也不在 DOM 里，所以既没法滚也没法测。现在改成面板内渲染的列表（`.lcp-options`，`max-height:168px; overflow-y:auto`），滚轮可用、配色一致、可断言。
- 输入框右边的按钮显示**候选数量**（`▾ 3`），列表收起时也知道里面有多少东西；点它或按 `↓` 展开。
- **笔记本列表 = 记住的 ∪ 现存的**。只用「记住的」有个首次运行的坑：什么都没记过时列表是空的，看起来像控件坏了。
- **页面列表只显示当前笔记本的页面**；笔记本栏为空时列出全部，此时每项后面标注它属于哪个笔记本/分区，方便直接挑。
- 已经成功导出过的目的地会记到 `~/.dsh/storages/lecture-copilot/onenote-destinations.json`，下次置顶。
- **记住的名单每次都会被现况过滤**：笔记本被关掉或改名、页面被删掉，它就不再出现在列表里，而不是等到导出时才报错。

**三个由渲染测试逼出来的真 bug**（都锁在 `render-panel.mjs` 里）
1. `＋` 按钮**根本渲染不出来**。它作为第三个参数传给了 `h(ExportBar, {...}, '＋按钮')`，但那个 `h(` 忘了闭合——整个按钮变成了 `ExportDialog` 的一个多余 prop，被 `createElement` 丢掉了。**看代码看不出来，只有真的渲染一遍才会暴露**。现在它在按钮行里（`＋ 新建页面`）。
2. **OneNote 不可用时面板会崩**。摘要行直接读 `view.notebooks.length`，而 `view` 此时是 `null`——恰好在最需要告诉用户「本机没有 OneNote」的时候炸掉。
3. 列表按钮的候选数量与列表内容**对不上**：测试工具用 `className.includes('lcp-option')` 时同时匹配到了容器 `lcp-option**s**`。改成按**完整 class 词元**匹配后才看到真实渲染结果。

**在真实浏览器里量过布局**（`css-layout-probe.mjs`，12/12）

渲染测试能证明组件树，但证明不了浏览器**拿这段 CSS 做了什么** —— 上一轮那个「弹不出来」的 bug 正好落在这一层，任何树结构检查都看不出来。所以又做了一层：用**从 `lib/client.js` 里提取的真实 CSS 文本** + 真实元素结构，在 Edge headless 里渲染，通过 DevTools 协议读取**计算样式**并截图。

结果：候选列表 `scrollHeight > clientHeight`（确实有东西可滚）、`overflow-y:auto`、`max-height` 生效、在屏幕上真有高度；面板背景不透明且 `opacity:1`；**没有任何子元素横向溢出面板**。截图（`panel-screenshot.png`）能直接看到列表被滚到第 7–11 项，以及深色不透明面板压在灰色背景上。

这一步也解释了一件事：面板自身 `overflow:hidden`，所以展开的候选列表会把下面的按钮挤出可视区，需要滚动面板才能看到。这是**有意的**（`max-height:min(70vh,680px)` 的滚动面板），不是布局错误。

模型下拉**现在也显示 provider**：同一个模型 id 由两个 provider 提供时（实测 `deepseek-flash` 同时在 `deepseek-official` 与 `deepseek-account` 下），两条是**不同的通路**而不是重复项，所以每项都写成 `provider · 模型` 的形式。

**没有 OneNote 的机器上**，`/onenote` 返回 `available: false`，对话框显示原因，导出按钮点了也不会崩——这台机器上 OneNote 是本地桌面程序，插件通过 COM 驱动它，不需要任何账号或联网授权。

**四个踩过的坑**（都由真实报错逼出来的）

1. **`GetHierarchy` 的第二个参数是层级深度，不是 schema 版本**。写成 `2`（schema）只会返回笔记本，分区和页面全是空的。
2. **stdin 必须显式按 UTF-8 解码**。Windows PowerShell 默认用系统 ANSI 代码页读 stdin，中文全变乱码，OneNote 收到后报一个毫无信息量的 `0x80042000`。
3. **`UpdatePageContent` 只能用位置参数**。OneNote 的 type library 在普通安装上没注册，PowerShell 无法解析参数名——命名哈希表会被当成**一个位置参数**传进去，然后同样是 `0x80042000`。
4. **OneNote 的 XML 方言不接受 `one:Run`**。放在 `one:OE` 下和放在 `one:T` 下都会被拒（报错原文：`unexpected element Run according to the content model of parent element …`）。所以样式改由**文本本身**承载：标题变成 `【一、课堂主线】`、列表保留 `·` 与 `1.` 标记、代码块用缩进。表格行合并成一行文本。

**开发这个功能时留下的测试痕迹（需要手动删除）**

验证过程在你的 `JNU` 笔记本里留下了这些页面/段落。因为「这个功能永不删除」是硬约束，脚本不会自己清理，请你按需删掉：

| 位置 | 内容 |
|---|---|
| `JNU / Temp / 无标题页` × 2 | 各含一段 `—— 追加测试 PROBE-APPEND-…`（各 371 字符） |
| `JNU / Temp / Academic Department: https://jwc.jnu.edu.cn` | 末尾多了一段 `—— 追加测试 PROBE-APPEND-…`（原 201 字符 → 现 2381 字符，原有内容未动） |
| `JNU / Adv. Maths 1 / 高等数学 · 课堂笔记 2026-10-06 21:15` | ＋ 按钮建页测试生成的整页 |

**一次真实的事故（值得记下来）**

`live-onenote-routes.mjs` 里我原本假设「运行中的会话没有笔记」，于是直接 POST 了 `/onenote/export` 想验证「没有笔记时应当拒绝」。**这个假设是错的** —— 那个会话里恰好有一份真实的复习笔记（来自一次真实录音），于是导出**被正常接受并真的写进了笔记本**：在你自己的页面末尾追加了一段，还新建了一页。

两个错误，第二个更严重：

1. **断言建立在未验证的假设上。** 「没有笔记」应当先读 `/state` 确认，而不是假定。
2. **我把写入放到了 `--append` 判断之外。** 文档写着「默认只读」，代码却不是 —— 一个只读的默认路径竟然会写。这正是「文档与代码不一致」最危险的形式。

现在这个脚本**先读 `/state`，发现会话里有笔记就停下并说明原因**，并且**任何写入都不再位于 `--append` 之外**。实测：默认运行 19/19 不写入；带 `--append` 且会话有笔记时输出「Refusing to continue」并停止。

`onenote-cleanup-report.mjs` 负责列出现存痕迹并为受影响页面写备份（它自己也不删除任何东西）。

另：`onenote-probe.mjs` 与 `onenote-routes.mjs` 默认**只读**，只有显式加 `--append` 才会写入。

---

## 6.3 两个已修复的界面问题（值得记下来）

### 面板不刷新、按钮点不动

两个独立原因叠在一起，症状看起来像一个问题。

**原因 A：`useSyncExternalStore` 的快照比较。** 面板原来用
`useSyncExternalStore(subscribe, () => store)`，而 `publish()` 是在**同一个对象上**
`Object.assign`。快照 getter 每次都返回同一个引用，React 用 `Object.is` 一比认为「没变」，
于是**跳过每一次重渲染**。切工作区之所以「好使」，是因为那会重新挂载组件、重新读一次 store。

改成显式的订阅 + 版本号：

```js
const [, bumpRevision] = React.useReducer((revision) => revision + 1, 0)
const state = getStore()
React.useEffect(() => subscribe(bumpRevision), [])
```

**原因 B：z-index 被压在下面。** 面板原来是 `z-index: 61`，而 DSH 自己的浮层用到
**1000**（modal 根：`position:fixed; inset:0; pointer-events:auto` —— 一个看不见的全屏层）
和 **1100**（portal / toast）。低于 1000 的控件，点击会被那个全屏层接走 —— 这正是
「按钮按不动」。现在面板与悬浮按钮都用 `z-index: 1200`。

**另外**：`/stop` 原本会一直等到笔记生成完才回响应（实测 9.7 秒），期间面板被
`await` 卡住；最坏情况（模型超时 300 秒）客户端会直接失败。现在 `/stop` 立即返回，
笔记在后台生成，面板轮询 `/state` 的 `reviewPending` / `hasReview` 得知结果，
并带 10 分钟上限；无论成功、失败还是超时，控件都会回到可点状态。

### 面板被主界面的文字挡住

面板原来用 `--dsw-alias-bg-elevated`，在浅色主题或浮层叠错时会透出下层文字。
现在改用**自带的不透明深色**（`#1c1c1e` 面板 / `#242426` 标题栏与底栏 / `#161618` 笔记区），
不再依赖主题变量，任何主题下都是黑底白字，且不被下层内容透出。

### 翻译一直显示「翻译中…」、笔记不自动展开

这两个都在**面板取数据的方式**上。宿主侧本身是好的 —— 实测翻译每段约 5-6 秒，串行、顺序正确。
翻译用的是 **DeepSeek 模型**（走 Harness 组合的 `llm` 服务，即「设置 → 模型」里选的默认模型），
没有第二个翻译后端。

**翻译卡住的原因：状态是「合并」而不是「替换」。** `applyState` 原来按 id 合并、只追加"没见过的"段：

```js
const known = new Set(store.segments.map((s) => s.id))
const fresh = (state.segments ?? []).filter((s) => !known.has(s.id))
publish({ segments: [...store.segments, ...fresh] })
```

于是**已知段落的后续更新被整段丢弃**：段落第一次进面板时是 `translating`，之后宿主把它翻好了，
面板却永远保留第一次那一版，那一行就永久停在「翻译中…」。

改成**整表替换** —— `/state` 本来就不带 `since` 游标，返回的就是完整真相，按 id 合并没有意义：

```js
segments: Array.isArray(state.segments) ? state.segments : [],
```

**笔记不展开的原因：只设了标志、没取正文。** 笔记面板的渲染条件是

```js
state.reviewOpen && state.review !== null
```

而 `waitForReview` 原来只 `publish({ reviewOpen: true })` —— `review` 始终是 `null`，条件永假。
按钮文字却只看 `reviewOpen`，所以显示「收起笔记」；点一下走进 `openReview()` 才真正把正文取回来。
现在拿到 `hasReview` 后**同时取正文**：

```js
const body = await fetchReview()
publish({ phase: 'idle', reviewOpen: body !== null, review: body, error: '' })
```

**面板状态现在可执行测试。** 状态逻辑抽到 `lib/state.js`（纯 CommonJS），`lib/client.js` 内联同一份
代码 —— 因为 bundle 只能依赖平台表与包名，不能 `require('./…')`（若该 require 失败，整个客户端模块
加载不了、按钮直接消失，比原 bug 更糟）。verify 脚本会**逐字符比对这两块代码**，不一致即失败，
所以「被测的代码」始终等价于「发布的代码」。

---

## 7. 源码

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

**为什么改完面板不需要清浏览器缓存**：宿主把客户端模块的 URL 里带了 `rev`，而这个 rev 由 `artifactRevision()` 从文件的 **mtime** 算出（`sha1(mtimeMs + …)` 取前 12 位）。文件一改、URL 就变，所以浏览器不可能拿到旧的那份，也不会命中那个 `immutable` 缓存。`bundle-resolve-check.mjs` 专门守这一条：它从 **profile 目录**解析 `dsh-lecture-copilot-plugin/client`，并逐字节比对解析结果与工作区文件——这两个不一致时，重启后看到的还会是旧面板，而且现象和「代码没生效」一模一样。

**为什么插件不 import `@deepseek-ai/*`**：profile 安装的 bundle 由 Loader 从 profile 目录解析裸标识符，而 profile 目录没有 `@deepseek-ai` 作用域——只有启动器的不可变运行时里才有。因此宿主半用 `ctx.provide()` 发布服务（而不是 `Service` 子类）、手写 `~standard` 配置校验（而不是 schemastery），浏览器半手写 `window.__ModuleLoader__.load`（而不是构建产物）。代价是要自己写十几行样板，换来的是「复制目录即安装」。
