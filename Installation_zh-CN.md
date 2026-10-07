# 课堂同传插件 · 安装说明

>宇宙安全声明：安装说明由蓝色胖鲸鱼生成，实际安装时请自行斟酌各步骤操作
> 
> 适用于 DeepSeek Harness（DSH）。插件是**自包含的一个目录**：13 个文件、约 204 KB、**零运行时依赖**。

---

## 1. 这个插件做什么

大学全英文课堂（高等数学、计算机类课程）的实时助手：

- 按下按钮开始录音，**英文实时转写 + 中文翻译**逐句显示
- 再按一次结束，自动整理出**复习笔记**：课堂主线、逻辑链、知识点、公式速查、术语对照表
- 可把笔记**导出到本机 OneNote**（仅 Windows，见第 7 节）

---

## 2. 需要什么

| 项目 | 要求 |
|---|---|
| DeepSeek Harness | 已安装并能正常启动 |
| 麦克风 | 浏览器会请求权限，需允许 |
| OneNote 导出 | **仅 Windows**，且本机装有桌面版 OneNote |
| Node / pnpm | **不需要另装** —— 两者都由 DSH 自带 |

---

## 3. 找到插件目录

插件就在你的工作区里：

```
<工作区>\dsh-lecture-copilot\
```

例如本机是：

```
C:\Users\21888\Documents\deepseek-harness\default-workspace\dsh-lecture-copilot\
```

**把这个目录整个复制走。** 目录内容：

```
package.json            包声明（dsh.bundle.patch + dsh.client）
cordis.patch.yml        bundle 补丁：往 profile 根插一行
lib\index.js            Host 半：配置、会话、12 个 HTTP 路由
lib\client.js           浏览器半：悬浮按钮、面板、麦克风采集
lib\state.js            面板状态（client.js 内联同一块，脚本逐字符比对）
lib\notes.js            模型调用：翻译、复习笔记、页面标题
lib\prompts.js          两条提示词 + 标题提示词
lib\tools.js            两个面向模型的工具
lib\onenote.js          OneNote 桥（Node 侧，调 PowerShell）
lib\note-xml.js         复习笔记 Markdown → OneNote XML
lib\onenote-store.js    记住用过的笔记本/分区/页面
host\onenote.ps1        OneNote COM 自动化（PowerShell 侧）
README.md               完整文档
```

> ⚠️ **`host\` 在 `lib\` 外面**，别只复制 `lib`，否则导出功能会缺文件。

---

## 4. 安装（四步）

下面用 `<PLUGIN>` 表示**复制后**的插件绝对路径，`<HARNESS>` 表示 DSH 的安装目录。

### 第 1 步：放好目录

放到一个**不会随手删掉**的位置，例如：

- Windows：`C:\dsh-plugins\dsh-lecture-copilot`
- macOS / Linux：`~/dsh-plugins/dsh-lecture-copilot`

### 第 2 步：在 profile 里建立链接

用 DSH 自带的 pnpm（不需要另装 Node 或 pnpm）。

**Windows（PowerShell）**

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "<HARNESS>\DeepSeek Harness.exe" `
  "<HARNESS>\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" "link:<PLUGIN>"
```

本机实测命令（可直接照抄改路径）：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\deepseekHarness\DeepSeek Harness.exe" `
  "D:\deepseekHarness\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" `
  "link:C:\dsh-plugins\dsh-lecture-copilot"
```

**macOS / Linux（bash/zsh）**

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "<HARNESS>/resources/runtime/pnpm/bin/pnpm.cjs" \
  add --dir "$HOME/.dsh/profiles/desktop" "link:<PLUGIN>"
```

**pnpm 走不通就手写符号链接**，效果完全一样：

```powershell
# Windows（管理员 PowerShell 或已开启开发者模式）
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-lecture-copilot-plugin" `
  -Target "<PLUGIN>"
```

```bash
# macOS / Linux
ln -s "<PLUGIN>" "$HOME/.dsh/profiles/desktop/node_modules/dsh-lecture-copilot-plugin"
```

### 第 3 步：改两个文件

都在 `~/.dsh/profiles/desktop/` 下（Windows 是 `C:\Users\<你>\.dsh\profiles\desktop\`）。

**3a. `package.json`** —— 加依赖，并把插件加进 `bundles`：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-lecture-copilot-plugin": "link:<PLUGIN>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "……保留原有的……",
        "dsh-lecture-copilot-plugin"
      ]
    }
  }
}
```

> `bundles` 里**原有的条目一个都不能删**，只在末尾追加一行。

**3b. `cordis.patch.yml`** —— 末尾追加：

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  disabled: false
```

> ⚠️ **`name` 必须逐字等于 `package.json` 里的 `name`**：`dsh-lecture-copilot-plugin`。
> 写错时这一行会以 `failed to import` 结束，而且**不会有更具体的提示** —— 这是最容易踩的一步。

### 第 4 步：冷启动 Harness

**完全退出再重新启动**。`dsh.profile.bundles` 的改动只在下一次启动时生效。

---

## 5. 确认装好了

### 5a. 看路由是否活着

浏览器打开：

```
http://127.0.0.1:19387/lecture-copilot/health
```

应当返回 `plugin: "dsh-lecture-copilot"`，且 `services` 里几个都是 `true`：

```json
{
  "ok": true,
  "plugin": "dsh-lecture-copilot",
  "services": { "speechToText": true, "llm": true, "tools": true, "webServer": true }
}
```

### 5b. 看面板是否出现

Harness 页面右下角应出现 **🎧 课堂同传** 按钮。点它会请求麦克风权限并开始听课。

### 5c. 跑自检脚本（可选，推荐）

插件旁边目录 `dsh-lecture-copilot-verify\` 里是自检脚本。用 DSH 自带的 Node 运行：

```powershell
# Windows
$node = "C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "<工作区>\dsh-lecture-copilot-verify\verify.mjs"        # 预期：173/173 checks passed
& $node "<工作区>\dsh-lecture-copilot-verify\cold-boot-check.mjs"  # 预期：READY: 0 failure(s)
```

```bash
# macOS / Linux
node "<工作区>/dsh-lecture-copilot-verify/verify.mjs"
node "<工作区>/dsh-lecture-copilot-verify/cold-boot-check.mjs"
```

---

## 6. 常见问题

**面板没出现，或 `/lecture-copilot/health` 404**

按顺序查：

1. `cordis.patch.yml` 里那一行的 `name` 是否**逐字**等于 `dsh-lecture-copilot-plugin`
2. `package.json` 的 `bundles` 里是否加上了 `dsh-lecture-copilot-plugin`
3. `node_modules/dsh-lecture-copilot-plugin` 这个链接是否**真的存在**且指向正确目录
4. 是否**真的冷启动**过（改完 bundles 不重启不生效）

**改了源码但没生效**

插件是从磁盘加载的，但 **Node 的 ESM 模块缓存按 URL 且进程内不失效** —— 改了 `lib/*.js` **必须重启 Harness**，禁用再启用那一行也没用。

客户端（面板）那一半不用管浏览器缓存：模块 URL 里带了由文件修改时间算出的 `rev`，文件一变 URL 就变。

**识别很慢**

第一次调用有 15～20 秒的**冷启动**（本地模型懒加载），之后每句约 0.5 秒。这是正常现象，不是卡住。

**转写把术语听错**

在 `cordis.patch.yml` 的 `lecture-copilot` 行里加这两项，会随每段一起送给模型：

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  disabled: false
  config:
    language: en
    context: 线性代数，全英文授课，教师为中文母语
    glossary:
      - eigenvalue
      - gradient descent
      - squeeze theorem
```

**清空面板会不会把正在生成的笔记一起砍掉？**

会，而且这是刻意的：整理过程中点「清空并中断」会**立即中止**笔记生成，不产出任何笔记。

---

## 7. 平台差异：macOS 上能用吗

**大部分能用，OneNote 导出不能用。**

| 功能 | 依赖 | macOS |
|---|---|---|
| 录音、切句、上传 | 浏览器 API | ✅ 可用 |
| 本地语音识别 | 宿主自带的 `speechToText` 服务 | ✅ 可用 |
| 实时翻译、生成复习笔记 | 宿主的 `llm` 服务 | ✅ 可用 |
| 面板与全部按钮 | React | ✅ 可用 |
| **导出到 OneNote** | Windows PowerShell + OneNote **COM 自动化** | ❌ **不可用** |

原因：那一半靠 `New-Object -ComObject OneNote.Application`，是 Windows 的组件模型。macOS 上的 OneNote 是沙盒应用，没有 COM，也没有等价的本地自动化接口。**这是平台限制，不是能修的 bug。**

失败方式是**干净的**：`/onenote` 返回 `available: false` 加一条原因，面板显示原因而不是崩掉；录音、翻译、复习笔记**完全不受影响**。

将来若要在 macOS 上导出，需要走 **Microsoft Graph API**（HTTP 接口 + 一次 OAuth 授权），那是另一块功能。

---

## 8. 卸载

1. 从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里删掉 `dsh-lecture-copilot-plugin`
2. 删掉同文件 `dependencies` 里那一行
3. 删掉 `cordis.patch.yml` 末尾的 `lecture-copilot` 条目
4. 删掉 `~/.dsh/profiles/desktop/node_modules/dsh-lecture-copilot-plugin` 这个链接
5. 删除插件目录本身（可选，其中 `~/.dsh/storages/lecture-copilot/onenote-destinations.json` 是导出功能记住的目的地，也可一并删）
6. 重启 Harness

---

## 9. 文件清单（复制这些就够）

```
dsh-lecture-copilot/
├── package.json
├── cordis.patch.yml
├── README.md
├── lib/
│   ├── index.js
│   ├── client.js
│   ├── state.js
│   ├── notes.js
│   ├── prompts.js
│   ├── tools.js
│   ├── onenote.js
│   ├── note-xml.js
│   └── onenote-store.js
└── host/
    └── onenote.ps1
```

共 13 个文件，约 204 KB。
