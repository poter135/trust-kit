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
