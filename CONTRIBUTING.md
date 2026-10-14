# 贡献指南

## 开发

```bash
npm install
npm run migrate:local   # 初始化本地 D1
npm run dev             # Worker :8788
npm run dev:web         # 后台 :5173
npm test                # 跑测试
```

## 提交前

```bash
npm test        # 必须全绿
npm run typecheck
npm run build:web
```

改动了 `packages/worker/migrations/` 下的迁移后，务必重跑 `npm test` —— 测试会用 `node:sqlite` 真实执行迁移，
SQL 写错会立即失败。

## 代码约定

- **单引号、分号、2 空格缩进**，与现有文件保持一致。
- 新增接口在 `routes/` 下实现，在 `src/index.js` 注册路由；不要在路由层写 SQL 之外的业务判断。
- 所有外部输入（body、query）都要过 `lib/validate.js`，不要信任前端。
- 注释解释**为什么**，不复述代码在做什么。
- 跳转路径上的新增逻辑要考虑失败降级：统计、通知之类不能阻塞跳转。

## 新增一种资源类型的检查清单

1. `migrations/` 加表，`slug` 加 UNIQUE。
2. `domain/resolve.js` 加解析函数，并在 `handleRedirect` 的候选列表里排好优先级。
3. `routes/` 加 CRUD，注意列表接口对非超管要按 `owner_id` 过滤。
4. `src/index.js` 注册路由。
5. `test/` 补集成测试：创建 → 跳转 → 统计 → 权限隔离。

## 安全红线

- 口令一律走 `lib/crypto.js` 的 PBKDF2，禁止自行实现哈希。
- 令牌、密钥只存哈希；明文只在创建时返回一次。
- 用户可控的 URL 必须过 `assertHttpUrl`，禁止 `javascript:` 等协议进入跳转点。
- 访客 IP 落库前必须哈希。
