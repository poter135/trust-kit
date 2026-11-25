# trust-kit

與專案無關、可重用的「可信度」工具：Node ESM CLI（純 `.mjs` + JSDoc，免 build，Node >= 22，測試用 `node:test`）。

## 用法

```sh
trust-kit <subcommand> [--flags]
trust-kit config --root <repo>   # 驗證並印出 trust.config.json
```

未知子指令 exit 2，並列出可用子指令；設定錯誤 exit 1，訊息含欄位路徑與修正方式。

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
- `protectedPaths` 一律自動加入 `trust.config.json`、`tools/trust-kit.version`、`.trust/rules.json`。

## 邊界

`test/boundaries.test.mjs` 強制：`src/runners/` 以外只能 import `src/runners/index.mjs`；`src/` 不得出現任何特定專案名稱或路徑。

## 開發

```sh
npm install
npm test
```
