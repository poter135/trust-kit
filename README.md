# trust-kit

與專案無關、可重用的「可信度」工具：Node ESM CLI（純 `.mjs` + JSDoc，免 build，Node >= 22，測試用 `node:test`）。

## 用法

```sh
trust-kit <subcommand> [--flags]
trust-kit config --root <repo>   # 驗證並印出 trust.config.json
trust-kit red-green --base <rev> --head <rev> [--out <path>]
```

未知子指令 exit 2，並列出可用子指令；設定錯誤 exit 1，訊息含欄位路徑與修正方式。

### red-green

證明這次新增／修改的測試在改動前的程式碼上以「行為失敗」結束、改動後通過；載入／編譯失敗不算紅燈。

- **有效 base＝`git merge-base <base> <head>`**：diff 與 base checkout 都用 merge-base，所以 base 分支在分岔後自己改的測試不會被算進這次改動（傳 PR 目標分支的最新 SHA 也安全）。報告 `base` 是 merge-base，`requestedBase` 是呼叫者傳入的 rev 解析後的 SHA。
- 變更測試＝merge-base→head 間 `A`／`M` 且符合 runner `testGlobs` 的檔案（刪除不算，改名視為新增）。
- head 與 base 都在暫存 git worktree 跑（呼叫端未 commit 的改動不影響結果；設定檔讀 head commit 的版本）；base 那邊會先把 head 版本的變更測試檔複製進去。跑完一定移除 worktree。
- 判定依序：無變更測試 `no_tests`；head 上有變更測試不是 pass／skip `head_fail`；base 上有 behavior_fail `valid_red`；只有 load_fail `invalid_red`；其餘 `no_red`。
- `--out` 寫 JSON 檔，否則 JSON 印到 stdout；一行結論印到 stderr。只有 `head_fail` 或工具錯誤（含 setup 失敗）exit 1。

### packet／approve／check-approval（審查包與核准）

```sh
trust-kit packet --items B1,B2 --base <rev> [--head <rev>] --out review.md   # stdout 印出審查包 id
trust-kit approve --packet <id> --numbers 1,3 [--allow-flagged]
trust-kit check-approval --kind <deploy-function|hosting|app-release|batch-write> --target <t> --commit <sha>
```

- `packet`：讀 `.trust/items/<id>.json` 與 `<evidence.outDir>/<id>.json`，並以 merge-base 偵測驗證系統改動。產出繁中 markdown：最上方「需要注意」（證據不完整、紅綠燈非 `valid_red`、沒有證據包、證據包不是 head 的 commit、驗證系統改動），接著逐項列出編號、標題、紅綠燈與 CI 連結、截圖、需要的核准（kind／target／commit 前 12 碼）。每個（項目, 核准）一個編號；沒有列核准的項目仍有編號但無法核准。審查包 id＝markdown 的 sha256 前 12 碼；另寫 `<out>.json` 與 `.trust/packets/<id>.json`（`{ id, entries, generatedAt, head }`）。核准一律綁定審查包的 head（預設 `HEAD`）。
- `approve`：把核准寫進 `.trust/approvals/<id>.json`（`approvedBy: "user-chat"`、`approvedAt`；同一審查包再次核准會合併）。審查包不存在、編號不存在、項目沒有核准種類時丟錯且不寫檔；有「需要注意」的編號要加 `--allow-flagged` 才能核准（驗證系統有改動時，所有編號都算需要注意）。
- `check-approval`：掃 `.trust/approvals/*.json`，只有 kind、target、commit 完全相同才 exit 0；不符 exit 1，原因列出核准的 commit 與目前的 commit，或「未核准」。`batch-write` 的 `--commit` 是寫入計畫的雜湊，原字串比對；其他種類若不是 40 碼 SHA 會先解析成完整 commit。
- 第一階段核准紀錄由 Claude 依使用者在對話中的回覆寫入，只防 commit 漂移、不防偽造；偽造由第三階段身份分離處理。

## trust.config.json（放在被檢查 repo 的根目錄）

```json
{
  "version": 1,
  "runners": [
    { "id": "backend", "adapter": "jest", "cwd": "server", "testGlobs": ["test/**/*.test.ts"] }
  ],
  "protectedPaths": ["ci/**"],
  "evidence": { "outDir": ".trust/evidence", "screensDir": ".trust/screens" },
  "ledger": { "path": ".trust/ledger.md" }
}
```

- `adapter`：`flutter`、`jest`、`node-test` 之一；`command`（字串陣列）可選。
- `setup`（可選）：argv 陣列的陣列，例如 `[["npm", "ci"]]`、`[["flutter", "pub", "get"]]`。暫存 worktree 沒有安裝好的依賴，所以 red-green 會在 base 與 head 兩個 checkout 的 `<checkout>/<cwd>` 依序執行（不經 shell），只對有變更測試的 runner 執行，跑完才跑測試。任一指令失敗＝工具錯誤，訊息含 runner id、base／head、指令與 stderr 結尾。
- `protectedPaths` 一律自動加入 `trust.config.json`、`tools/trust-kit.version`、`.trust/rules.json`。

## 邊界

`test/boundaries.test.mjs` 強制：`src/runners/` 以外只能 import `src/runners/index.mjs`；`src/` 不得出現任何特定專案名稱或路徑。

## 開發

```sh
npm install
npm test
```
