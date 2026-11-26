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
- 判定依序：無變更測試 `no_tests`；head 上有變更測試不是 pass／skip `head_fail`；有一個測試在 base 上 behavior_fail、在 head 上 pass `valid_red`；base 上只有 load_fail，或 behavior_fail 的測試在 head 上已不存在（改名／刪除）`invalid_red`；其餘 `no_red`。
- **找不到模組不算行為失敗**：測試本體裡 `import`／`require` 一個不存在的檔案（訊息含 `ERR_MODULE_NOT_FOUND`、`MODULE_NOT_FOUND`、`Cannot find module`、`Cannot find package`）一律算 `load_fail`，等同「被測的程式還不存在」。斷言訊息剛好含這些字也會被算成 load_fail（寧可不算紅燈）。
- `--out` 寫 JSON 檔，否則 JSON 印到 stdout；一行結論印到 stderr。只有 `head_fail` 或工具錯誤（含 setup 失敗）exit 1。
- 在 GitHub Actions 裡報告的 `ciRunUrl` 由 `GITHUB_SERVER_URL`／`GITHUB_REPOSITORY`／`GITHUB_RUN_ID` 產生。0.4.0 起**沒有** `--ci-run-url`（傳了直接報錯）：本機報告不能被蓋上 CI 章。

#### 新的檢查程式（new-checker）規則怎麼拿到真的紅燈

把散文規則改成新的檢查程式時，base 上還沒有那支檢查程式，若測試直接 `import` 它，base 上只會得到 load_fail（`invalid_red`），不算紅燈。正確做法：

1. 測試先寫在 base 也存在的東西上：讓測試對 **base 上已經違反規則的內容**（真實檔案或固定的樣本）執行檢查，斷言「必須回報這些違規」或「必須拒絕」。
2. 檢查程式還不存在時，測試要能以**斷言**失敗，而不是載入失敗，例如：
   - 以子行程執行檢查（`spawnSync(node, [checker, ...])`），斷言 exit code／輸出：base 上檔案不存在 → exit code 不符 → behavior_fail；
   - 或把檢查邏輯寫在測試會呼叫的既有入口（hook、CLI 子指令）後面，base 上入口存在但不攔截 → 斷言失敗。
3. head 上同一個測試通過，`.trust/rules.json` 的 `check.testName` 要寫這個測試的名稱：規則證據只認該 testName 那一列 `behavior_fail → pass`，同檔其他測試變綠不算。

### item-gate（產品改動必須附項目）

```sh
trust-kit item-gate --base <rev> --head <rev> [--out <path>]
```

- merge-base→head 之間有檔案符合 `trust.config.json` 的 `itemGate.productPaths`，就必須**新增或修改**至少一個合法的 `.trust/items/<id>.json`（格式同項目檔；刪除、壞掉的項目檔不算），否則判定 `missing`。
- 不需要項目的產品改動（例如只改註解、搬檔），改為新增或修改 `.trust/exemptions/<名稱>.json`：`{ "reason": "為什麼不需要項目" }`，理由去空白後至少 10 個字。base 上已經有的豁免檔不算（每次改動都要寫自己的理由）。豁免理由會寫進報告與 CI summary。
- **設定從 merge-base 讀**，不讀這次改動本身：PR 不能替自己移除 `itemGate` 或把 `enforce` 改成 `warn`；新加的設定合併後才生效。base 沒有 `itemGate` → `not_configured`。
- 判定：`not_configured`、`no_product_change`、`item`、`exempt`、`missing`。`--out` 寫 JSON 報告（`trust-kit/item-gate@1`）。只有 `missing` 且 `mode: "enforce"` 時 exit 1；`warn` 仍 exit 0。在 GitHub Actions 裡 `missing` 會輸出 `::warning::`（warn）或 `::error::`（enforce）註記。
- reusable workflow 先跑輕量的 `item-gate` job（不裝 Flutter／專案依賴），不合格時重的 `red-green` job 直接跳過。base 的 trust-kit 版本早於 0.5.0（沒有 item-gate）時略過並在 summary 註明。

### evidence（證據包）

```sh
trust-kit evidence --item <id> --run <GitHub Actions run id 或網址> [--screens <dir>] [--out <path>]
```

- **只接受 GitHub Actions run 產生的紅綠燈報告**：用 `gh api repos/<origin>/actions/runs/<id>` 查 run，必須是 `origin` 這個 repo、`head_sha` 等於目前 commit、已完成的 `pull_request` run，且其中的 red-green job（名稱 `red-green` 或 `<job> / red-green`）成功（紅綠燈 head_fail、protected 或 ledger verify 失敗的 run 都不算；同一 run 的其他 job 失敗不影響）；再用 `gh run download` 從該 run 下載 `trust-red-green` artifact，報告的 `head` 必須等於目前 commit，`ciRunUrl` 必須等於該 run 的網址。本機檔案一律不收（0.4.0 起沒有 `--red-green`）。需要已登入的 `gh`。
- **逐項證明**：項目檔 `.trust/items/<id>.json` 要列出證明它的測試 `tests: [{ "runnerId", "file", "testName" }]`。每個測試都要在報告中 `behavior_fail → pass`。`testName` 寫完整名稱，或巢狀名稱尾端的完整段落（node:test 與 Jest 都以 `describe > test` 表示巢狀）；名稱只是字尾相同的兄弟測試不算，對到不只一個測試也不算。整個 PR 的 `valid_red` 不能代替項目自己的紅燈；沒有列 tests 的項目永遠不完整。
- 項目有 `app`／`web` 時還要截圖證據（`screens collect` 產生、commit 相同、雜湊相符）。
- 證據包格式 `trust-kit/evidence@2`：`redGreen` 記 run id、repo、run 網址（取自 GitHub API），`tests` 記每個測試的 base／head 結果。
- 證據包另記 `redGreen.base`（CI 判定用的 merge-base）與 `screensDir`（repo 內相對路徑），審查包重新驗證時使用。
- 限制：一個 PR 若同時修改 workflow 讓它上傳假的 artifact，該 run 仍是「這個 repo 的 run」；`.github/workflows/**` 一律屬於受保護路徑，會在審查包標出，但不會被擋下（結構性修正在第三階段）。

### packet／approve／check-approval（審查包與核准）

```sh
trust-kit packet --items B1,B2 [--head <rev>] --out review.md   # stdout 印出審查包 id
trust-kit approve --packet <id> --numbers 1,3 [--allow-flagged]
trust-kit check-approval --kind <deploy-function|hosting|app-release|batch-write> --target <t> --commit <sha>
```

- `packet`：**base 一律是 head 與預設分支的 merge-base**（`trust.config.json` 的 `defaultBranch`，預設 `main`；有 `origin/<分支>` 就用它，否則用本機分支）。base 寫進 markdown（因此也在審查包 id 裡）與紀錄；傳 `--base` 時其 merge-base 必須與此相同，否則拒絕（例如 `--base HEAD`）。base 等於 head（已合進預設分支、看不到任何改動）時所有編號都標為需要注意。
- 讀 `.trust/items/<id>.json`；`<evidence.outDir>/<id>.json` 只用來取得 CI run id 與截圖目錄，**每個項目的證據都在產生審查包時向 CI run 重新驗證**（因此需要已登入的 `gh`），手寫或過期的 `complete: true` 不會進到審查包。沒有 run id 的證據包標為需要注意。並從 base 偵測驗證系統改動。產出繁中 markdown：最上方「需要注意」（證據不完整、紅綠燈非 `valid_red`、沒有證據包、證據包不是 head 的 commit、證據包是 0.4.0 以前的格式、項目沒有列測試、CI 紅綠燈的 base 不是審查包的 base（例如疊在別的 PR 上）、base 等於 head、驗證系統改動），接著逐項列出編號、標題、完成條件、證明它的測試與其 base → head 結果、紅綠燈與 CI 連結、截圖、需要的核准（kind／target／commit 前 12 碼）。每個（項目, 核准）一個編號；沒有列核准的項目仍有編號但無法核准。審查包 id＝markdown 的 sha256 前 12 碼；另寫 `<out>.json` 與 `.trust/packets/<id>.json`（`{ id, entries, generatedAt, base, baseRef, head }`）。核准一律綁定審查包的 head（預設 `HEAD`）：部署的就是 head，所以每個項目的證據包也必須是 head 的。
- `approve`：審查包紀錄沒有 `base`（0.4.0 以前產生）時拒絕。把核准寫進 `.trust/approvals/<id>.json`（`approvedBy: "user-chat"`、`approvedAt`；同一審查包再次核准會合併）。審查包不存在、編號不存在、項目沒有核准種類時丟錯且不寫檔；有「需要注意」的編號要加 `--allow-flagged` 才能核准（驗證系統有改動時，所有編號都算需要注意）。
- `check-approval`：掃 `.trust/approvals/*.json`，只有 kind、target、commit 完全相同才 exit 0；不符 exit 1，原因列出核准的 commit 與目前的 commit，或「未核准」。`--commit` 若不是 40 碼 SHA 會先解析成完整 commit。
- **`batch-write` 第一階段不可核准**：核准只綁 git head，批次寫入需要以寫入計畫 hash 核准，要等第二階段。審查包對每個 `batch-write` 編號加上「批次寫入計畫 hash 尚未支援（第二階段），不可核准」；`approve` 即使加 `--allow-flagged` 也拒絕；`check-approval --kind batch-write` 一律 exit 1。
- 第一階段核准紀錄未綁定 session（哪個對話核准的不記錄、不比對），留待後續階段。
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
  "ledger": { "path": ".trust/ledger.md" },
  "defaultBranch": "main"
}
```

- `defaultBranch`（可選，預設 `main`）：審查包 base 用的預設分支。
- `itemGate`（可選）：`{ "productPaths": ["src/**"], "mode": "warn" | "enforce" }`，見上方 item-gate。建議先 `warn` 一段時間觀察誤判再改 `enforce`。

- `adapter`：`flutter`、`jest`、`node-test` 之一；`command`（字串陣列）可選。
- `setup`（可選）：argv 陣列的陣列，例如 `[["npm", "ci"]]`、`[["flutter", "pub", "get"]]`。暫存 worktree 沒有安裝好的依賴，所以 red-green 會在 base 與 head 兩個 checkout 的 `<checkout>/<cwd>` 依序執行（不經 shell），只對有變更測試的 runner 執行，跑完才跑測試。任一指令失敗＝工具錯誤，訊息含 runner id、base／head、指令與 stderr 結尾。
- `protectedPaths` 一律自動加入 `trust.config.json`、`tools/trust-kit.version`、`.trust/rules.json`、`.github/workflows/**`。

## 邊界

`test/boundaries.test.mjs` 強制：`src/runners/` 以外只能 import `src/runners/index.mjs`；`src/` 不得出現任何特定專案名稱或路徑。

## 開發

```sh
npm install
npm test
```

## 升級到 0.5.0

- 新增 `item-gate` 子指令與 `itemGate` 設定（可選，沒設定就不檢查）。
- reusable workflow 改為兩個 job：`item-gate` → `red-green`（`needs`）。呼叫端把 `red-green.yml@v0.5.0` 與 `tools/trust-kit.version` 一起升級；版本仍由 base 決定，所以 item-gate 在升級合併後的下一個 PR 才開始判定。

## 升級到 0.4.0（不相容變更）

- `red-green --ci-run-url` 移除；呼叫端 workflow 要同時改用 `red-green.yml@v0.4.0`（它不再傳這個參數），並與 `tools/trust-kit.version` 一起升級。
- `evidence --red-green <file>` 改為 `evidence --run <run id|URL>`，需要已登入的 `gh`。
- 項目檔要加 `tests`；舊的 `evidence@1` 證據包與沒有 `base` 的審查包會被標出／不能核准，請重新產生。
- `packet --base` 變成可省略，且只能等於與預設分支的 merge-base。
- 測試本體裡找不到模組改算 `load_fail`；`valid_red` 需要同一個測試 `behavior_fail → pass`；規則證據只認 `check.testName` 那一列（名稱要唯一）。
- Jest 的測試名稱改為 `describe > test`（與 node:test 相同），`check.testName` 若寫了以空白連接的 Jest fullName 要改。
- `.github/workflows/**` 一律受保護；`packet` 會向 CI run 重新驗證每個證據包，需要 `gh`。
