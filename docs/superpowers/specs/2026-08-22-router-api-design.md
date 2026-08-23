# Spec: Router API — 让别的应用调用 Codey 的 agent

状态：P1–P3 + 统一密钥管理已合并；session 保留期已实现；P4 待做
分支：`router-mode`
路径：`docs/superpowers/specs/2026-08-22-router-api-design.md`

## 1. 目标

让 Codey Gateway 除了聊天渠道（Telegram / Discord / iMessage / TUI / voice）之外，
再多一个**程序入口**：任何应用、脚本、CI 都能用 HTTP 把一个 prompt 交给 Codey，
由 Codey 选 workspace、选 agent、选 team，跑完把结果还回去。

非目标（本期不做）：
- 不做 MCP server（可以之后在这层之上薄薄套一层）
- 不做多租户 / 用户体系 / 计费
- 不改任何聊天渠道的行为

## 2. 现状（代码事实）

- HTTP 服务器已存在：`packages/gateway/src/health.ts` 的 `ApiServer`，
  监听 `port + 1`，路由是手写的 `if (url === ...)` 链。
- 已有端点：`/health` `/metrics` `/ready` `/config` `/voice/*`。**没有** prompt 端点。
- CORS 目前是 `Access-Control-Allow-Origin: *`，且**没有任何鉴权**。
  `/config` GET 现在就能裸读整份配置（含 API key）——加 prompt 端点之前必须先修这个。
- `/voice/*` 已有一个防浏览器的模式：带 `Origin` 头就 403（原生客户端不带 Origin）。
  Router API 复用同一招。
- 真正的执行入口是 `Gateway.sendToChat(chatId, text, sink, attachments?, origin?)`
  （`packages/gateway/src/gateway.ts:5813`），返回
  `{ response, chatId, tokens?, durationSec? }`。
- 流式事件类型已存在：`ChatStreamEvent`（`packages/gateway/src/chat-runner.ts:17`），
  sink 是 `(e: ChatStreamEvent) => void`。
- Automation 已经跑通"无人值守调用 sendToChat"的完整套路
  （`ensureAutomationChat` + collecting sink，`gateway.ts:1593`）。
  **Router API 就是把这套复用成 HTTP 版本**，不是新造一条执行路径。

## 3. 设计

### 3.1 鉴权

`gateway.json` 新增（**不含任何 token**）：

```jsonc
{
  "api": {
    "bindHost": "127.0.0.1",   // 用户可改。默认只监听本机
    "allowedOrigins": [],      // 留空 = 拒绝所有带 Origin 的请求
    "timeoutSec": 300,
    "rateLimitPerMin": 60
  }
}
```

规则：

- 所有 `/v1/*` 要求 `Authorization: Bearer <token>`。
- ~~`api.enabled` 开关~~ **实现时去掉了**（2026-08-22）。原打算默认关闭 `/v1/*`，
  但 token 才是真正的门：没有 token 谁也进不来，而"存在但未启用"这个额外状态
  只会让调用方分不清 404 是路由不存在还是开关没开。没有 token 时 `/v1/*` 一律 401。
- 带 `Origin` 且不在 `allowedOrigins` 里 → 403，沿用 `/voice/*` 的写法。
- 顺手把现有 `/config` GET/POST 也挪到同一把锁后面（**这是本期的安全修复项，不是可选项**）。
- CORS `Allow-Origin: *` 改为按 `allowedOrigins` 回显；没配就不发 CORS 头。

#### bindHost

`ApiServer.start()` 现在是 `server.listen(this.port)` —— 监听所有网卡，局域网可见。
改成 `server.listen(this.port, config.api?.bindHost ?? '127.0.0.1')`。

注意这个 host 对**整个** ApiServer 生效，`/health` `/voice/*` 也跟着只绑本机。
这是想要的：这些端点本来就没有跨机使用场景。
若有人真的要暴露到局域网，显式改 `bindHost` 为 `0.0.0.0`，
并且启动时打一条 warn 日志说明风险。

#### Token 存储：只存哈希，不存明文

Token **不进 `gateway.json`**。单独放 `~/.codey/api-tokens.json`
（沿用 `CODEY_HOME` 覆盖，同 `packages/core/src/workspace.ts:71`）：

```jsonc
{
  "version": 1,
  "tokens": [
    {
      "id": "tok_7f3a",              // 前缀，用于展示和吊销，不是秘密
      "name": "my-script",
      "hash": "<sha256 hex>",        // sha256(token)，只存这个
      "createdAt": 1755800000000,
      "lastUsedAt": 1755900000000
    }
  ]
}
```

- 文件用 `fs.writeFileSync(p, s, { mode: 0o600 })` 创建，并在每次读取时
  `fs.chmodSync(p, 0o600)` 兜底。读到权限不是 600 时打 warn。
- Token 明文格式 `codey_<32字节 base64url>`（`crypto.randomBytes(32)`）。
  **只在生成的那一刻打印一次**，之后任何地方都拿不回来。
- 校验：`sha256(收到的token)` 与存的 hash 逐一 `timingSafeEqual`。
  因为 token 是 256 bit 高熵随机串，不需要 bcrypt/argon2 那种慢哈希
  ——慢哈希是防低熵口令被爆破的，这里没有低熵口令。
- 额外覆盖：环境变量 `CODEY_API_TOKEN`。为 CI/容器准备，
  设了就作为一个额外的有效 token（同样只比对哈希）。

**为什么不用 macOS Keychain**：Gateway 要能跑在 headless daemon、
Linux、容器里；Keychain 只有 macOS，而且需要已解锁的登录会话。
代码库现在也没有任何 keychain/safeStorage 基础设施
（`grep safeStorage|keytar` 无命中），为此新引一套依赖不划算。
"哈希 + 0600" 已经挡住了本期真正的威胁：
配置文件被误提交 / 被日志打印 / 被 `/config` 端点读走。

#### CLI

```bash
npm run api-token -- create <name> [--retention unlimited|15|30|60|90]
npm run api-token -- list            # 只列 id / name / 时间 / 保留期
npm run api-token -- revoke <id>
```

#### Session 保留期（2026-08-22 加）

每次 API 调用都会在磁盘上留一个隐藏 chat，原本**永不清理**——脚本跑一万次
就是一万个 json 文件，而且在 UI 里看不见。

所以**在发 token 的时候就让用户选**：无限 / 15 / 30 / 60 / 90 天。
交互式会列出来让你选；`--retention` 可以直接指定；非交互 shell（CI、脚本）
拿不到回答，就退回"无限"——也就是原有行为——并提示怎么显式指定。

- 保留期**抄一份到 chat 上**（`Chat.retentionDays`），不是运行时回查 token。
  这样吊销 token 不会让它产生的 chat 变成没人管的孤儿。
- 只有**带了 `retentionDays` 的 chat** 会被清理。用户自己的 chat、automation chat、
  以及"无限" token 建的 chat 一律不碰。
- 计时从**最后一次活动**（`updatedAt`）算，不是从创建算。还在用的 session 不会被删。
- 清理由**请求触发**，最多每小时一次，**不开后台定时器**——闲置的 Router API
  仍然是零开销，而需要清理的堆积本来也只能由请求产生。
- 清理失败只打日志，不影响触发它的那个请求。

### 3.2 端点

#### `POST /v1/prompt` — 一发一收

请求：
```jsonc
{
  "prompt": "把 README 的安装章节翻成日文",
  "workspace": "codey",        // 可选，默认 gateway 默认 workspace
  "agent": "claude-code",      // 可选
  "model": "claude-opus-5",    // 可选
  "team": "reviewers",         // 可选，走 team 而不是单 agent
  "sessionId": "abc-123",      // 可选，见 3.3
  "stream": false              // 可选，true 见下
}
```

响应 `200`：
```jsonc
{
  "sessionId": "abc-123",
  "response": "…agent 的最终回复…",
  "tokens": 12345,
  "durationSec": 42.1
}
```

错误：`400` 参数错、`401` token 错、`404` workspace/team 不存在、
`409` 该 session 正在跑、`503` gateway 未就绪、`504` 超时。

#### `POST /v1/prompt` with `"stream": true` — 流式

响应 `200`，`Content-Type: application/x-ndjson`，每行一个 `ChatStreamEvent` 的 JSON。
沿用 `/voice/converse` 已有的 NDJSON 写法（`health.ts` 里那段），**不引入 SSE**。
最后一行一定是 `{"type":"done",...}` 或 `{"type":"error",...}`。

响应头 `X-Codey-Session-Id` 带回本轮的 session id（流式没有 JSON 信封可放它）。
另外发 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no`，
否则反向代理会把整个 body 缓冲住，流式就白做了。

客户端中途断开：不杀 agent（同 504 的取舍），只是停止写入。
未写完的那一轮结果仍然落在 session 里，可以用 `GET /v1/sessions/:id` 取回。

#### `GET /v1/sessions/:id` — 查一个 session 的最近消息

用于客户端断线后补历史。返回 chat 的 `messages` 尾部（上限 40，同 `CHAT_CONTEXT_WINDOW`）。

#### `DELETE /v1/sessions/:id` — 丢弃 session

幂等。chat 已经不在了也返回 200；正在跑的 session 返回 409。

#### `GET /v1/capabilities` — 客户端发现

返回可用 workspace 名、team 名、agent 名、默认 agent/model。
让调用方不用猜。

### 3.3 Session 模型

- 一个 API session **就是一个 kind 为 `api` 的 chat**，
  照抄 `ensureAutomationChat` 的做法建立（`chatManager.create({ kind: 'api', ... })`）。
- 不传 `sessionId` → 每次新建一个一次性 chat，跑完保留（可查、可删）。
- 传 `sessionId` → 复用，带上下文。
- 这些 chat 在 Mac app 里默认隐藏，跟 automation chat 一样处理。

### 3.4 并发与限流

- 复用现有的 `RunSemaphore` / `MAX_CONCURRENT_AGENTS = 4`，不新开一套池子。
- 同一个 `sessionId` 已有 in-flight 请求 → `409`，不排队（排队会让调用方看起来是挂死）。
- 每 token 每分钟请求数上限，可配，默认 60。

### 3.5 超时

- 单次请求默认 300s（对齐 agent adapter 的 5 分钟），可用 `api.timeoutSec` 改。
- 非流式超时 → `504`，但 agent **不杀**，session 里能查到最终结果。
- 流式超时 → 发一条 `error` 事件后 `res.end()`。

## 4. 实现落点

| 改动 | 文件 |
|---|---|
| `ApiConfig` 类型 | `packages/core/src/types/index.ts` |
| 配置读取 + 默认值 | `packages/gateway/src/config.ts` |
| 新增 `api-tokens.ts`：读写 `~/.codey/api-tokens.json`、生成/校验/吊销 | `packages/gateway/src/api-tokens.ts`（新） |
| `listen(port)` → `listen(port, bindHost)` | `packages/gateway/src/health.ts` |
| bearer / origin 中间件、`/v1/*` 路由 | `packages/gateway/src/health.ts` |
| token CLI | `scripts/` + `package.json` 的 `api-token` 脚本 |
| 新增 `router-api.ts`：session→chat 映射、参数校验、调 `sendToChat` | `packages/gateway/src/router-api.ts`（新） |
| 把 gateway 实例传进 `ApiServer` 构造函数 | `packages/gateway/src/index.ts` |
| `kind: 'api'` chat 类型 | `packages/gateway/src/chats.ts` |

`health.ts` 现在的 if-链已经 335 行了，`/v1/*` 全部下沉到 `router-api.ts`，
`health.ts` 里只留一行 `if (url?.startsWith('/v1/')) return this.routerApi.handle(req, res)`。

## 5. 测试

- 鉴权：无 token / 错 token / 关闭时 → 401 / 401 / 404
- token 文件：生成后明文不落盘（读回文件断言只有 hash）
- token 文件权限被创建为 `0o600`；权限被改宽时打 warn
- `CODEY_API_TOKEN` 环境变量作为额外有效 token
- 吊销后立刻 401
- `bindHost` 默认 `127.0.0.1`；设成 `0.0.0.0` 时打 warn
- Origin 被拒
- `/v1/prompt` 非流式：mock `sendToChat`，校验返回结构
- `/v1/prompt` 流式：校验 NDJSON 逐行可解析、末行是 done
- session 复用：两次请求打到同一个 chatId
- 同 session 并发 → 409
- 未知 workspace / team → 404
- 超时 → 504
- 回归：没挂 RouterApi 时 `/v1/*` 认证后 404（Mac/CLI 之外的嵌入场景）

## 6. 分期

1. **P1 — 已实现**（2026-08-22）。鉴权层 + `/config` 上锁 + CORS 收紧 + `bindHost`
   + `api-tokens.ts` + `api-token` CLI。`/v1/*` 已挂在鉴权后面但还没有任何路由（认证后 404）。
   附带修了 Swift helper 的 Settings 菜单：原先它在浏览器里打开 `/config`
   （等于把全部凭据倒进浏览器），现在 POST `/voice/open-settings`，由 Mac app 打开自己的设置窗口。
2. **P2 — 已实现**（2026-08-22）。`/v1/prompt`（非流式）+ `/v1/capabilities`，
   `router-api.ts` + `kind: 'api'` 隐藏 chat + session 复用 + 409/429/504/413。
   `stream: true` 显式返回 400 而不是假装支持。真机验过：curl 进去，agent 真回了。
3. **P3 — 已实现**（2026-08-22）。`stream: true` 走 NDJSON，
   `GET/DELETE /v1/sessions/:id`。真机验过：事件在 4.1s–9.5s 之间**逐条**到达，
   不是最后一口气吐出来。

   实现时改掉的两个设计细节：
   - **`done` 事件不能重复发。** `sendToChat` 自己会发终止事件，我又补了一条
     → 真机第一次跑出来两条 `done`。改成只在这一轮没发过终止事件时才补。
     但 `error` 例外：即使已经 `done` 过也要发，否则超时的一轮会被当成正常完成。
   - **匿名流式请求拿不到 sessionId。** 非流式的响应体里有，流式没有信封可放。
     改成走 `X-Codey-Session-Id` 响应头——不然调用方永远不知道自己刚创建的
     session 叫什么，既没法续聊也没法回查历史。
4. **协议兼容层 — 已实现**（2026-08-22）。`compat-api.ts`：
   `POST /v1/chat/completions`（OpenAI）、`POST /v1/messages`（Anthropic）、
   `GET /v1/models`。官方 OpenAI SDK 和官方 Anthropic SDK 都真机验证能直接调通，
   含流式和错误类型。见下面第 9 节。
5. **P4**（另开）— MCP server，内部转调 `/v1/prompt`。

## 9. 协议兼容层（2026-08-22）

目标：别的工具**不需要知道 Codey 的存在**就能用它。

```bash
OPENAI_BASE_URL=http://127.0.0.1:3000/v1   OPENAI_API_KEY=<codey token>
ANTHROPIC_BASE_URL=http://127.0.0.1:3000   ANTHROPIC_API_KEY=<codey token>
```

### 关键取舍

- **无状态是默认**，因为两家的 API 本来就是无状态的：客户端自己拿着历史，每次全量重发。
  Codey 自己的 `/v1/prompt` 是服务端存历史。两者混用会让每条消息重复一遍。
  所以兼容请求默认把 `messages` 摊平成一个 prompt，跑在一次性 chat 里。
  想用 Codey 的服务端上下文，加 `X-Codey-Session-Id` 头显式选择，
  这时**只发最后一条 user 消息**。
- **摊平时保留角色标签**（`User:` / `Assistant:`）。不加的话多轮历史会糊成一段话，
  agent 分不清谁说的。单条提问是特例，原样发过去，不套壳。
- **鉴权同时认两种头**：OpenAI SDK 发 `Authorization: Bearer`，
  Anthropic SDK 发 `x-api-key` 且完全不发 Authorization。两个都查同一个 token 库。
- **错误用各自的信封**（OpenAI 是 `{error:{message,type,param,code}}`，
  Anthropic 是 `{type:"error",error:{...}}`）。SDK 就是靠这个抛出正确的异常类——
  真机验过两边都抛 `NotFoundError`。
- **模型名**接受目录里的名字，也接受 `codex/gpt-5` 这种带 agent 前缀的写法。
  未知模型返回 404 并列出可用的——这条消息客户端会直接显示给人看。
- **只转发助手文本**。Codey 的 tool_start / checklist / worker 事件在两家的
  wire format 里没有对应物，硬造一个只会弄坏本来要支持的客户端。
- **agent 不吐 token 时兜底**：把最终文本作为一个 delta 发出去，
  否则流式客户端会收到一条空消息。
- 只对模型有意义的参数（`temperature`、`n`、`logprobs`、`tools`）**收下但忽略**，
  不做半吊子实现。Codey 是 agent，不是模型服务器。

### 待办

`compat-api.ts` 里有一条 TODO：等 #332（按 token 的 session 保留期）合进来后，
兼容层建的 chat 也要盖上 `retentionDays`。**无状态调用每次建一个 chat，
正是保留期要清理的那个堆积的最大来源。**

## 7. 已决

- **bindHost**：用户设置项，默认 `127.0.0.1`。（2026-08-22 定）
- **Token 存储**：`~/.codey/api-tokens.json`，`0600`，**只存 sha256 哈希**，
  明文只在生成时打印一次。不上 Keychain（headless / Linux 跑不了）。（2026-08-22 定）

## 8. 统一密钥管理 — 已实现（2026-08-22）

`gateway.json` 里的第三方 API key 和 bot token 已收进 `~/.codey/secrets.json`
（`0600`），与 `api-tokens.json` 共用 `secure-file.ts` 的读写原语。

- **按敏感度切分，不按功能切分**：非敏感元数据（key 名、base URL、purpose、
  channel 开关）留在 `gateway.json`，只有密钥串搬走。
- **密钥字段留空而不是删掉**，这样人打开文件能看出"配过，只是存别处"，
  不会误以为从没配过。
- **迁移是自动的、单向的**：老 config 里的内联密钥在加载时先写进密钥库，
  **然后**才重写 `gateway.json`。顺序不能反——中途崩溃最坏是两边都有，下次加载自动收敛。
- **`ConfigManager` 在内存里把密钥装回去**，所以 channels、adapters、Mac app
  的 key 编辑器一行都不用改。存储位置是实现细节，不是 API 变更。
- `/config` 端点额外做一次 redact：有 token 是"允许读配置"，不是"允许导出全部凭据"。
- 明文存储，不加密。这跟 `~/.ssh/id_rsa`、`~/.aws/credentials` 是同一个信任模型：
  只有进程属主能读。加密就要有密钥，密钥又要找地方放，绕回原问题。

实现时抓到的两个真 bug（都是测试先发现的）：
1. `adoptSecrets` 里直接调 `save()`，而构造函数此时还没给 `this.config` 赋值
   → 迁移静默失败，密钥留在磁盘上。改成置标志、构造完再存。
2. `normalize` 原本会丢掉 `apiKey` 为空的条目。剥离密钥后所有条目的 apiKey 都是空的，
   **重启一次全部 key 条目就没了**。改成只丢没有 `name` 的条目。

还加了 `vitest.setup.ts` 把 `CODEY_HOME` 指向临时目录：
否则测试里的 fixture 密钥会被"迁移"进开发者真实的密钥库（实现过程中真的发生了一次）。

**不在范围内**：`mcpServers[].env` 里的值仍是明文存在 `gateway.json`。
那是用户自定义的任意 env，无法可靠判断哪个是密钥；要收也得先让用户显式标注。
