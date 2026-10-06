# Lecture Copilot Plugin — Installation Guide

> For DeepSeek Harness (DSH). The plugin is **one self-contained directory**: 13 files, about 204 KB, **zero runtime dependencies**.

---

## 1. What the plugin does

A live assistant for English-taught university lectures (calculus, computer science):

- Press the button to record; **English transcription plus Chinese translation** appear line by line
- Press it again to stop, and it writes a **review note**: lecture outline, logic chain, knowledge points, formula reference, terminology table
- The note can be **exported to local OneNote** (Windows only — see section 7)

---

## 2. Requirements

| Item | Requirement |
|---|---|
| DeepSeek Harness | Installed and starting normally |
| Microphone | The browser will ask; you must allow it |
| OneNote export | **Windows only**, with desktop OneNote installed |
| Node / pnpm | **Not needed** — DSH ships both |

---

## 3. Find the plugin directory

The plugin lives in your workspace:

```
<workspace>\dsh-lecture-copilot\
```

On this machine that is:

```
C:\Users\21888\Documents\deepseek-harness\default-workspace\dsh-lecture-copilot\
```

**Copy that whole directory.** Its contents:

```
package.json            package declaration (dsh.bundle.patch + dsh.client)
cordis.patch.yml        bundle patch: inserts one row into the profile root
lib\index.js            Host half: config, session, 12 HTTP routes
lib\client.js           Browser half: floating button, panel, microphone capture
lib\state.js            Panel state (client.js inlines the same block; a script compares them byte for byte)
lib\notes.js            Model calls: translation, review note, page title
lib\prompts.js          The two prompts plus the title prompt
lib\tools.js            Two model-facing tools
lib\onenote.js          OneNote bridge (Node side; drives PowerShell)
lib\note-xml.js         Review Markdown -> OneNote XML
lib\onenote-store.js    Remembers notebooks / sections / pages you used
host\onenote.ps1        OneNote COM automation (PowerShell side)
README.md               Full documentation
```

> ⚠️ **`host\` sits outside `lib\`** — do not copy `lib` alone, or the export feature will be missing files.

---

## 4. Installation (four steps)

Below, `<PLUGIN>` is the **absolute path of the copy** you made, and `<HARNESS>` is the DSH installation directory.

### Step 1: Put the directory somewhere

Choose a location you will not casually delete:

- Windows: `C:\dsh-plugins\dsh-lecture-copilot`
- macOS / Linux: `~/dsh-plugins/dsh-lecture-copilot`

### Step 2: Link it into the profile

Use the pnpm that DSH ships (you do not need to install Node or pnpm).

**Windows (PowerShell)**

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "<HARNESS>\DeepSeek Harness.exe" `
  "<HARNESS>\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" "link:<PLUGIN>"
```

Verified on this machine (copy it and change the paths):

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\deepseekHarness\DeepSeek Harness.exe" `
  "D:\deepseekHarness\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" `
  "link:C:\dsh-plugins\dsh-lecture-copilot"
```

**macOS / Linux (bash/zsh)**

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "<HARNESS>/resources/runtime/pnpm/bin/pnpm.cjs" \
  add --dir "$HOME/.dsh/profiles/desktop" "link:<PLUGIN>"
```

**If pnpm is awkward, a plain symlink does exactly the same job:**

```powershell
# Windows (elevated PowerShell, or Developer Mode enabled)
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-lecture-copilot-plugin" `
  -Target "<PLUGIN>"
```

```bash
# macOS / Linux
ln -s "<PLUGIN>" "$HOME/.dsh/profiles/desktop/node_modules/dsh-lecture-copilot-plugin"
```

### Step 3: Edit two files

Both live in `~/.dsh/profiles/desktop/` (on Windows: `C:\Users\<you>\.dsh\profiles\desktop\`).

**3a. `package.json`** — add the dependency and add the plugin to `bundles`:

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
        "...keep every existing entry...",
        "dsh-lecture-copilot-plugin"
      ]
    }
  }
}
```

> Do **not** remove any existing entry from `bundles`; only append one line.

**3b. `cordis.patch.yml`** — append at the end:

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  disabled: false
```

> ⚠️ **`name` must match the `name` in `package.json` exactly**: `dsh-lecture-copilot-plugin`.
> If it does not, the row ends with `failed to import` and there is **no more specific error** — this is the easiest step to get wrong.

### Step 4: Cold-start the Harness

**Quit it completely and start it again.** A change to `dsh.profile.bundles` only takes effect on the next launch.

---

## 5. Verify the installation

### 5a. Check that the route is alive

Open in a browser:

```
http://127.0.0.1:19387/lecture-copilot/health
```

It should return `plugin: "dsh-lecture-copilot"` with the services all `true`:

```json
{
  "ok": true,
  "plugin": "dsh-lecture-copilot",
  "services": { "speechToText": true, "llm": true, "tools": true, "webServer": true }
}
```

### 5b. Check that the panel appears

A **🎧 课堂同传** button should appear in the lower-right of the Harness page. Clicking it asks for microphone permission and starts listening.

### 5c. Run the self-checks (optional but recommended)

The neighbouring directory `dsh-lecture-copilot-verify\` holds the test scripts. Run them with the Node that DSH ships:

```powershell
# Windows
$node = "C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "<workspace>\dsh-lecture-copilot-verify\verify.mjs"           # expect: 173/173 checks passed
& $node "<workspace>\dsh-lecture-copilot-verify\cold-boot-check.mjs"  # expect: READY: 0 failure(s)
```

```bash
# macOS / Linux
node "<workspace>/dsh-lecture-copilot-verify/verify.mjs"
node "<workspace>/dsh-lecture-copilot-verify/cold-boot-check.mjs"
```

---

## 6. Troubleshooting

**No panel, or `/lecture-copilot/health` returns 404**

Check these in order:

1. Does the `name` in `cordis.patch.yml` match `dsh-lecture-copilot-plugin` **exactly**?
2. Is `dsh-lecture-copilot-plugin` present in the `bundles` array in `package.json`?
3. Does `node_modules/dsh-lecture-copilot-plugin` actually exist and point at the right directory?
4. Did you genuinely cold-start after editing `bundles`?

**I changed the source but nothing happened**

The plugin is loaded from disk, but **Node's ESM cache is keyed by URL and never invalidated in-process** — after editing `lib/*.js` you **must restart the Harness**. Disabling and re-enabling the row does not help.

The browser half needs no cache work: its module URL carries a `rev` derived from the file's modification time, so the URL changes whenever the file does.

**Recognition is slow**

The first call has a 15–20 second **cold start** (the local model loads lazily); after that each utterance takes about 0.5 s. That is normal, not a hang.

**It keeps mishearing technical terms**

Add these to the `lecture-copilot` row in `cordis.patch.yml`; they are sent along with every segment:

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  disabled: false
  config:
    language: en
    context: Linear algebra, taught entirely in English, Chinese-native lecturer
    glossary:
      - eigenvalue
      - gradient descent
      - squeeze theorem
```

**Does clearing the panel kill the note being generated?**

Yes, deliberately: pressing "clear and interrupt" while the review is running **aborts it immediately** and produces no note at all.

---

## 7. Platform notes: does it work on macOS?

**Most of it does; the OneNote export does not.**

| Feature | Depends on | macOS |
|---|---|---|
| Recording, segmentation, upload | Browser APIs | ✅ Works |
| Local speech recognition | The Host's `speechToText` service | ✅ Works |
| Live translation, review note | The Host's `llm` service | ✅ Works |
| Panel and all buttons | React | ✅ Works |
| **Export to OneNote** | Windows PowerShell + OneNote **COM automation** | ❌ **Does not work** |

The reason is direct: that half relies on `New-Object -ComObject OneNote.Application`, which is a Windows component model. OneNote on macOS is a sandboxed app — there is no COM and no equivalent local automation interface. **This is a platform limitation, not a bug that can be fixed.**

The failure mode is **clean**: `/onenote` returns `available: false` with a reason, the panel shows the reason instead of crashing, and recording, translation, and the review note are **completely unaffected**.

Exporting from macOS would require the **Microsoft Graph API** (an HTTP interface plus a one-off OAuth authorisation) — that is a separate feature, not a port of the existing bridge.

---

## 8. Uninstalling

1. Remove `dsh-lecture-copilot-plugin` from `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`
2. Remove that line from `dependencies` in the same file
3. Remove the `lecture-copilot` entry at the end of `cordis.patch.yml`
4. Remove the link `~/.dsh/profiles/desktop/node_modules/dsh-lecture-copilot-plugin`
5. Delete the plugin directory itself (optional; `~/.dsh/storages/lecture-copilot/onenote-destinations.json`, which remembers export destinations, can go too)
6. Restart the Harness

---

## 9. File list (this is everything you need to copy)

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

13 files, about 204 KB.
