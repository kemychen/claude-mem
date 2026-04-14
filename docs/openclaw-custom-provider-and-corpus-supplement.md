# OpenClaw Integration: Custom Provider & Memory Corpus Supplement

本文档覆盖 claude-mem fork 新增的两个能力，供 AI agent 或运维人员部署、配置和验证。

## 一、OpenAI Compatible Provider（自定义 LLM Provider）

### 功能

用一个通用 Agent 接入任意 OpenAI chat/completions 兼容 API，无需为每个 provider 写独立代码。

### 支持的 Provider 示例

| Provider | Base URL | 模型示例 |
|----------|----------|---------|
| MiniMax | `https://api.minimax.io/v1/chat/completions` | `MiniMax-M2.7` |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1/chat/completions` | `moonshot-v1-128k` |
| Qwen (通义千问) | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-plus` |
| 零一万物 | `https://api.lingyiwanwu.com/v1/chat/completions` | `yi-large` |
| 本地 Ollama | `http://localhost:11434/v1/chat/completions` | `llama3` |
| 任何 OpenAI 兼容 | 对应 `/v1/chat/completions` 端点 | 对应模型 ID |

### 配置方式

通过 claude-mem settings API 设置（推荐）：

```bash
curl -X POST http://127.0.0.1:37777/api/settings -H 'Content-Type: application/json' -d '{
  "CLAUDE_MEM_PROVIDER": "custom",
  "CLAUDE_MEM_CUSTOM_BASE_URL": "https://api.minimax.io/v1/chat/completions",
  "CLAUDE_MEM_CUSTOM_API_KEY": "sk-your-api-key",
  "CLAUDE_MEM_CUSTOM_MODEL": "MiniMax-M2.7",
  "CLAUDE_MEM_CUSTOM_LABEL": "MiniMax"
}'
```

或在 `~/.claude-mem/.env` 中直接设置环境变量：

```env
CLAUDE_MEM_PROVIDER=custom
CLAUDE_MEM_CUSTOM_BASE_URL=https://api.minimax.io/v1/chat/completions
CLAUDE_MEM_CUSTOM_API_KEY=sk-your-api-key
CLAUDE_MEM_CUSTOM_MODEL=MiniMax-M2.7
CLAUDE_MEM_CUSTOM_LABEL=MiniMax
```

### 配置字段说明

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAUDE_MEM_PROVIDER` | 是 | `claude` | 设为 `custom` 启用自定义 provider |
| `CLAUDE_MEM_CUSTOM_BASE_URL` | 是 | 无 | 完整的 chat/completions 端点 URL |
| `CLAUDE_MEM_CUSTOM_API_KEY` | 是 | 无 | API 密钥 |
| `CLAUDE_MEM_CUSTOM_MODEL` | 否 | `gpt-4o-mini` | 模型 ID |
| `CLAUDE_MEM_CUSTOM_LABEL` | 否 | `Custom` | 日志中显示的名称 |
| `CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES` | 否 | `20` | 最大上下文消息数 |
| `CLAUDE_MEM_CUSTOM_MAX_TOKENS` | 否 | `100000` | 最大估算 token 数 |

### 验证步骤

**1. 确认 provider 设置生效：**

```bash
curl -s http://127.0.0.1:37777/api/settings | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Provider:', d.get('CLAUDE_MEM_PROVIDER', '(not set)'))
print('Base URL:', d.get('CLAUDE_MEM_CUSTOM_BASE_URL', '(not set)'))
print('Model:', d.get('CLAUDE_MEM_CUSTOM_MODEL', '(not set)'))
print('Label:', d.get('CLAUDE_MEM_CUSTOM_LABEL', '(not set)'))
print('Has API Key:', bool(d.get('CLAUDE_MEM_CUSTOM_API_KEY')))
"
```

期望输出：Provider 为 `custom`，Base URL 和 API Key 已配置。

**2. 确认 health 和 provider 状态：**

```bash
curl -s http://127.0.0.1:37777/api/health | python3 -m json.tool
curl -s http://127.0.0.1:37777/api/processing-status | python3 -m json.tool
```

**3. 触发一次 observation 处理并检查日志：**

```bash
# 查看当天日志中的自定义 provider 启动信息
LOG=~/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log

# 应该能看到 [Label] Starting session 和 API usage 日志
grep -E '\[MiniMax\]|\[Custom\]|\[DeepSeek\]|CustomProvider.*Config loaded' "$LOG" | tail -20
```

关键日志标记：
- `[Label] Starting session` — provider 启动，包含 model/baseUrl 信息
- `[Label] API usage` — API 调用成功，包含 token 用量和耗时
- `[Label] agent completed` — session 处理完成
- `[Label] API HTTP error` — API 调用失败，包含 HTTP 状态码

**4. 确认 observations 正常生成：**

```bash
# 检查 pending 队列和 observations 计数
python3 -c "
import sqlite3
con = sqlite3.connect('$HOME/.claude-mem/claude-mem.db')
cur = con.cursor()
for q, name in [
    (\"SELECT count(*) FROM pending_messages WHERE status='pending'\", 'pending'),
    (\"SELECT count(*) FROM pending_messages WHERE status='processing'\", 'processing'),
    (\"SELECT count(*) FROM observations\", 'observations'),
]:
    cur.execute(q)
    print(f'{name}: {cur.fetchone()[0]}')
"
```

期望：`pending` 应逐步下降或为 0，`observations` 应增长。

**5. 切换回默认 provider：**

```bash
curl -X POST http://127.0.0.1:37777/api/settings -H 'Content-Type: application/json' -d '{
  "CLAUDE_MEM_PROVIDER": "claude"
}'
```

---

## 二、Memory Corpus Supplement（OpenClaw 记忆集成）

### 功能

让 OpenClaw 的 `memory_search` 和 `memory_get` 工具能搜索到 claude-mem 存储的 observations，实现 memory-core（dreaming/active-memory）和 claude-mem 知识库的双向打通。

### 前提条件

- OpenClaw 版本 >= 2026.4.10（需要 `registerMemoryCorpusSupplement` API）
- claude-mem 插件已在 OpenClaw 中启用（`plugins.entries.claude-mem.enabled: true`）
- claude-mem worker 正在运行（默认端口 37777）

### 工作原理

```
用户/AI 调用 memory_search("某个查询")
  -> memory-core 并行搜索自身数据 + 所有 corpus supplements
  -> claude-mem supplement 调用 worker HTTP API 搜索 observations
  -> 结果按 score 合并返回
```

### 无需额外配置

此功能通过 openclaw 插件自动注册，只要 claude-mem worker 在运行，`memory_search`/`memory_get` 就会自动包含 claude-mem 的结果。

### 验证步骤

**1. 确认插件加载并注册了 supplement：**

```bash
# 查看 OpenClaw 日志
grep 'corpus supplement' ~/.openclaw/logs/*.log | tail -5
# 或在 Discord 中查看 openclaw 启动日志
```

期望看到：
- `[claude-mem] Registered memory corpus supplement` — 注册成功
- 如果看到 `Memory corpus supplement not available` — OpenClaw 版本过旧

**2. 在 OpenClaw 中测试 memory_search：**

在 Discord 中让 AI 执行：
```
请使用 memory_search 搜索 "你之前在 claude-mem 中记录过的某个关键词"
```

或通过 Gateway API：
```bash
curl -X POST http://127.0.0.1:9999/tools/invoke \
  -H 'Authorization: Bearer YOUR_GATEWAY_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "memory_search",
    "params": { "query": "你要搜索的关键词" }
  }'
```

**3. 检查 supplement 日志：**

```bash
# 查看 OpenClaw 的 claude-mem 插件日志
grep 'corpus-supplement' ~/.openclaw/logs/*.log | tail -10
```

关键日志标记：
- `corpus-supplement search: query="..." maxResults=N` — 搜索请求
- `corpus-supplement search: N results (Xms)` — 搜索完成，N>0 说明有匹配
- `corpus-supplement search: worker returned null` — worker 不可用（检查 worker 是否运行）
- `corpus-supplement get: lookup="..."` — 详情获取请求

**4. 确认 worker 可达：**

```bash
# 从 OpenClaw 所在机器测试
curl -s http://127.0.0.1:37777/api/health
# 应该返回 {"status":"ok",...}

# 手动测试搜索
curl -s 'http://127.0.0.1:37777/api/search?query=test&type=observations&format=json&limit=3' | python3 -m json.tool
```

### 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `Memory corpus supplement not available` | OpenClaw 版本 < 2026.4.10 | 升级 OpenClaw |
| `worker returned null` | claude-mem worker 未运行 | `npm run worker:start` |
| 搜索返回 0 结果 | worker 中没有 observations | 确认 claude-mem 正常记录 observations |
| supplement 日志完全没有 | openclaw 插件未加载 | 检查 `plugins.entries.claude-mem.enabled` |

---

## 三、部署检查清单

部署后按顺序验证：

- [ ] `npm run build` 构建成功
- [ ] claude-mem worker 正常运行：`curl http://127.0.0.1:37777/api/health`
- [ ] OpenClaw 重启后 claude-mem 插件加载成功（检查日志）
- [ ] `corpus-supplement` 注册日志出现
- [ ] `memory_search` 能返回 claude-mem 的 observations
- [ ] （如使用自定义 provider）settings 中 CLAUDE_MEM_PROVIDER=custom 已设置
- [ ] （如使用自定义 provider）日志中出现 `[Label] Starting session` 和 `[Label] agent completed`
- [ ] （如使用自定义 provider）observations 数量增长，pending 队列正常消费

## 四、相关文件

| 文件 | 说明 |
|------|------|
| `src/services/worker/OpenAICompatibleAgent.ts` | 通用 OpenAI 兼容 agent |
| `src/services/worker-service.ts` | provider 注册和 fallback 链 |
| `src/services/worker/http/routes/SessionRoutes.ts` | provider 路由选择 |
| `src/services/worker/events/SessionEventBroadcaster.ts` | SSE 广播防御性修复 |
| `openclaw/src/index.ts` | OpenClaw 插件，含 corpus supplement 注册 |
