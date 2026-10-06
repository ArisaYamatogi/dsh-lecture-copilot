# 講義同時通訳プラグイン · インストール手順

> DeepSeek Harness（DSH）用です。プラグインは**自己完結した 1 つのディレクトリ**です —— 13 ファイル、約 204 KB、**実行時依存ゼロ**。

---

## 1. このプラグインは何をするか

英語で行われる大学の講義（微積分、情報系科目）のためのリアルタイム支援ツールです。

- ボタンを押すと録音を開始し、**英語の文字起こしと中国語訳**を 1 文ずつ表示します
- もう一度押すと終了し、**復習ノート**を自動整理します —— 講義の流れ、論理の連鎖、知識ポイント、公式早見表、用語対照表
- ノートを**ローカル OneNote にエクスポート**できます（Windows のみ。第 7 節を参照）

---

## 2. 必要なもの

| 項目 | 要件 |
|---|---|
| DeepSeek Harness | インストール済みで正常に起動できること |
| マイク | ブラウザが権限を要求します。許可してください |
| OneNote エクスポート | **Windows のみ**、デスクトップ版 OneNote が必要 |
| Node / pnpm | **別途インストール不要** —— DSH が同梱しています |

---

## 3. プラグインの場所

プラグインはワークスペース内にあります。

```
<ワークスペース>\dsh-lecture-copilot\
```

この環境では次の場所です。

```
C:\Users\21888\Documents\deepseek-harness\default-workspace\dsh-lecture-copilot\
```

**このディレクトリを丸ごとコピーしてください。** 中身は次のとおりです。

```
package.json            パッケージ宣言（dsh.bundle.patch + dsh.client）
cordis.patch.yml        bundle パッチ：profile のルートに 1 行挿入する
lib\index.js            Host 側：設定、セッション、12 個の HTTP ルート
lib\client.js           ブラウザ側：フローティングボタン、パネル、マイク取得
lib\state.js            パネルの状態（client.js が同じブロックを内包。スクリプトが 1 文字単位で比較）
lib\notes.js            モデル呼び出し：翻訳、復習ノート、ページタイトル
lib\prompts.js          2 つのプロンプトとタイトル用プロンプト
lib\tools.js            モデル向けツール 2 つ
lib\onenote.js          OneNote ブリッジ（Node 側。PowerShell を起動する）
lib\note-xml.js         復習ノートの Markdown → OneNote XML
lib\onenote-store.js    使用したノートブック / セクション / ページを記憶する
host\onenote.ps1        OneNote COM 自動化（PowerShell 側）
README.md               詳細ドキュメント
```

> ⚠️ **`host\` は `lib\` の外にあります。** `lib` だけをコピーしないでください。エクスポート機能のファイルが欠けます。

---

## 4. インストール（4 ステップ）

以下、`<PLUGIN>` は**コピー先**の絶対パス、`<HARNESS>` は DSH のインストールディレクトリを指します。

### ステップ 1：ディレクトリを配置する

うっかり消さない場所に置いてください。

- Windows：`C:\dsh-plugins\dsh-lecture-copilot`
- macOS / Linux：`~/dsh-plugins/dsh-lecture-copilot`

### ステップ 2：profile にリンクを張る

DSH 同梱の pnpm を使います（Node や pnpm を別途入れる必要はありません）。

**Windows（PowerShell）**

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "<HARNESS>\DeepSeek Harness.exe" `
  "<HARNESS>\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" "link:<PLUGIN>"
```

この環境で動作確認済みのコマンド（パスを書き換えて使えます）：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "D:\deepseekHarness\DeepSeek Harness.exe" `
  "D:\deepseekHarness\resources\runtime\pnpm\bin\pnpm.cjs" `
  add --dir "$env:USERPROFILE\.dsh\profiles\desktop" `
  "link:C:\dsh-plugins\dsh-lecture-copilot"
```

**macOS / Linux（bash / zsh）**

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "<HARNESS>/resources/runtime/pnpm/bin/pnpm.cjs" \
  add --dir "$HOME/.dsh/profiles/desktop" "link:<PLUGIN>"
```

**pnpm がうまくいかない場合は、通常のシンボリックリンクでまったく同じ結果になります。**

```powershell
# Windows（管理者 PowerShell、または開発者モードを有効化）
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-lecture-copilot-plugin" `
  -Target "<PLUGIN>"
```

```bash
# macOS / Linux
ln -s "<PLUGIN>" "$HOME/.dsh/profiles/desktop/node_modules/dsh-lecture-copilot-plugin"
```

### ステップ 3：2 つのファイルを編集する

どちらも `~/.dsh/profiles/desktop/` にあります（Windows では `C:\Users\<ユーザー名>\.dsh\profiles\desktop\`）。

**3a. `package.json`** —— 依存を追加し、`bundles` にプラグインを加えます。

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
        "……既存の項目はすべて残す……",
        "dsh-lecture-copilot-plugin"
      ]
    }
  }
}
```

> `bundles` の**既存項目は 1 つも削除しないでください。** 末尾に 1 行追加するだけです。

**3b. `cordis.patch.yml`** —— 末尾に追記します。

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  disabled: false
```

> ⚠️ **`name` は `package.json` の `name` と完全に一致させる必要があります**：`dsh-lecture-copilot-plugin`。
> 一致しないと、その行は `failed to import` で終わり、**それ以上具体的なエラーは出ません** —— ここが最も間違えやすい箇所です。

### ステップ 4：Harness をコールドスタートする

**完全に終了してから起動し直してください。** `dsh.profile.bundles` の変更は次回起動時にのみ反映されます。

---

## 5. インストールの確認

### 5a. ルートが生きているか確認する

ブラウザで次を開きます。

```
http://127.0.0.1:19387/lecture-copilot/health
```

`plugin: "dsh-lecture-copilot"` が返り、`services` がすべて `true` であれば正常です。

```json
{
  "ok": true,
  "plugin": "dsh-lecture-copilot",
  "services": { "speechToText": true, "llm": true, "tools": true, "webServer": true }
}
```

### 5b. パネルが出ているか確認する

Harness のページ右下に **🎧 课堂同传** ボタンが表示されます。押すとマイク権限を要求し、聴講を開始します。

### 5c. セルフチェックを実行する（任意・推奨）

隣のディレクトリ `dsh-lecture-copilot-verify\` にテストスクリプトがあります。DSH 同梱の Node で実行します。

```powershell
# Windows
$node = "C:\Users\<ユーザー名>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "<ワークスペース>\dsh-lecture-copilot-verify\verify.mjs"           # 期待値：173/173 checks passed
& $node "<ワークスペース>\dsh-lecture-copilot-verify\cold-boot-check.mjs"  # 期待値：READY: 0 failure(s)
```

```bash
# macOS / Linux
node "<ワークスペース>/dsh-lecture-copilot-verify/verify.mjs"
node "<ワークスペース>/dsh-lecture-copilot-verify/cold-boot-check.mjs"
```

---

## 6. トラブルシューティング

**パネルが出ない、または `/lecture-copilot/health` が 404 を返す**

次の順に確認してください。

1. `cordis.patch.yml` の `name` は `dsh-lecture-copilot-plugin` と**完全に**一致していますか
2. `package.json` の `bundles` に `dsh-lecture-copilot-plugin` を加えましたか
3. `node_modules/dsh-lecture-copilot-plugin` は**実際に存在**し、正しいディレクトリを指していますか
4. `bundles` を編集したあと、**本当にコールドスタート**しましたか

**ソースを変更したのに反映されない**

プラグインはディスクから読み込まれますが、**Node の ESM キャッシュは URL 単位で、プロセス内では無効化されません** —— `lib/*.js` を変更したら **Harness の再起動が必須**です。その行を無効化 → 有効化しても効きません。

ブラウザ側（パネル）はキャッシュ対策が不要です。モジュール URL にファイルの更新時刻から算出した `rev` が付くため、ファイルが変われば URL も変わります。

**認識が遅い**

初回呼び出しには 15～20 秒の**コールドスタート**がかかります（ローカルモデルを遅延読み込みするため）。以降は 1 文あたり約 0.5 秒です。これは正常な動作で、フリーズではありません。

**専門用語を聞き間違える**

`cordis.patch.yml` の `lecture-copilot` 行に次を追加してください。各セグメントと一緒にモデルへ送られます。

```yaml
- id: lecture-copilot
  name: "dsh-lecture-copilot-plugin"
  disabled: false
  config:
    language: en
    context: 線形代数、英語のみで授業、講師は中国語母語話者
    glossary:
      - eigenvalue
      - gradient descent
      - squeeze theorem
```

**パネルを消去すると、生成中のノートも消えますか**

消えます。これは意図的な動作です。整理中に「消去して中断」を押すと、ノート生成を**即座に中止**し、ノートは一切生成されません。

---

## 7. プラットフォーム差：macOS で使えるか

**大部分は使えますが、OneNote エクスポートは使えません。**

| 機能 | 依存先 | macOS |
|---|---|---|
| 録音、文の分割、アップロード | ブラウザ API | ✅ 動作する |
| ローカル音声認識 | Host 同梱の `speechToText` サービス | ✅ 動作する |
| リアルタイム翻訳、復習ノート | Host の `llm` サービス | ✅ 動作する |
| パネルとすべてのボタン | React | ✅ 動作する |
| **OneNote へのエクスポート** | Windows PowerShell + OneNote の **COM 自動化** | ❌ **動作しない** |

理由は単純です。この部分は `New-Object -ComObject OneNote.Application` に依存しており、これは Windows のコンポーネントモデルです。macOS の OneNote はサンドボックスアプリで、COM も等価なローカル自動化インターフェースも存在しません。**これはプラットフォームの制約であり、修正できるバグではありません。**

失敗の仕方は**クリーン**です。`/onenote` は `available: false` と理由を返し、パネルはクラッシュせずに理由を表示します。録音・翻訳・復習ノートは**まったく影響を受けません**。

将来 macOS でエクスポートするなら **Microsoft Graph API**（HTTP インターフェース + 一度きりの OAuth 認可）を使うことになりますが、それは別の機能です。

---

## 8. アンインストール

1. `~/.dsh/profiles/desktop/package.json` の `dsh.profile.bundles` から `dsh-lecture-copilot-plugin` を削除する
2. 同じファイルの `dependencies` から該当行を削除する
3. `cordis.patch.yml` 末尾の `lecture-copilot` エントリを削除する
4. リンク `~/.dsh/profiles/desktop/node_modules/dsh-lecture-copilot-plugin` を削除する
5. プラグインディレクトリ自体を削除する（任意。エクスポート先を記憶する `~/.dsh/storages/lecture-copilot/onenote-destinations.json` も一緒に削除してかまいません）
6. Harness を再起動する

---

## 9. ファイル一覧（コピーするのはこれだけ）

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

合計 13 ファイル、約 204 KB。
