# 商务通 · 客户智能调研系统（MVP）

> 上传客户信息表 → 系统以已知字段为基准做一致性校验、对缺失字段主动调研补全 → 生成带来源标注的对比报告 → 整合输出 V2.xlsx 总表（冲突字段红底 + 分号合并）。
>
> 完整满足 [需求.md](../需求.md) 的核心闭环。32 字段定义来自 [表头V1.xlsx](../表头V1.xlsx)。

---

## 启动

```bash
cd d:/AI项目/商务通/system
npm install            # 一次安装,纯 JS 依赖,无原生编译
cp .env.example .env   # 然后编辑 .env 填 ANTHROPIC_* 配置
npm start              # 默认 http://localhost:8787
```

> **环境变量**(任选其一):
> - 直连 Anthropic: `ANTHROPIC_API_KEY=sk-ant-xxxxx`
> - 公司网关: `ANTHROPIC_BASE_URL=https://aiapi.tcredit.com` + `ANTHROPIC_AUTH_TOKEN=xxxxx`(本仓库当前环境)
>
> 模型默认 `claude-opus-4-8`,可通过 `ANTHROPIC_MODEL` 切到 `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`。

---

## 演示流程(2 分钟)

1. 浏览器打开 http://localhost:8787
2. 「调研工作台」→ 上传 `表头V1.xlsx` → 提示"已识别 1 条客户、32 个字段"
3. 选择模型(默认 opus 4.8)→ 字段范围留空(全部 30 个可调研字段)→ 点「执行调研」
4. 进度条走到 100% 后,切到「客户列表 / 看板」→ 点客户行打开调查报告
5. 「导出 V2」标签 → 下载 V2.xlsx,Excel 中查看冲突字段红底 + 字段来源子表

---

## 架构

```
浏览器 (Alpine SPA)
   │ HTTP
   ▼
Fastify (server.js)
   ├── /api/upload      → excel-io.js 读 V1
   ├── /api/research    → jobs.js (p-limit 并发) → researcher.js (Anthropic SDK)
   ├── /api/customers/* → db.js (JSON 文件)
   └── /api/export/v2.xlsx → excel-io.js 写 V2(红底/绿底/来源子表)
```

| 模块 | 文件 |
|---|---|
| 字段定义与来源映射(32 字段) | [src/field-spec.js](src/field-spec.js) |
| Excel 解析 / 导出 / 冲突判定 | [src/excel-io.js](src/excel-io.js) |
| JSON 文件存储 | [src/db.js](src/db.js) |
| 调研引擎(Claude + tool_use schema) | [src/researcher.js](src/researcher.js) |
| 任务调度(并发限流) | [src/jobs.js](src/jobs.js) |
| HTTP 路由 | [server.js](server.js) |
| 单页前端 | [public/index.html](public/index.html) |

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/health` | 健康检查 + 当前模型/网关 |
| GET  | `/api/fields` | 32 字段元信息 |
| POST | `/api/upload` | 上传 V1.xlsx,自动解析 + 入库 |
| GET  | `/api/customers?q=&level=&region=` | 客户列表(含调研完整度) |
| GET  | `/api/customers/:id` | 单客户原始记录 |
| GET  | `/api/customers/:id/report` | 单客户调研报告(分组 + 来源) |
| GET  | `/api/stats` | 看板(总数 / 等级 / 区域 / 业务线) |
| POST | `/api/research` | `{customer_ids?, fields?, model}` 触发任务 |
| GET  | `/api/jobs/:id` | 任务进度轮询 |
| GET  | `/api/jobs` | 任务历史 |
| GET  | `/api/export/v2.xlsx` | 下载 V2 总表 |

---

## 调研逻辑(核心)

每个字段两条路径:

- **已知字段** → "verify" 模式: 让 Claude 用已知值当 ground truth,通过 web 搜索找佐证 → `agree / conflict / unknown` + URL
- **缺失字段** → "fill" 模式: 按 `field-spec.js` 的优先来源映射搜索 → `value + confidence + sources[]`

强约束的安全机制:
- 模型必须调用 `record_finding` 工具(JSON schema)写结论,**不允许在文本里给值**
- 必须给 sources `[{url, title, evidence}]`,**没源头不允许编**
- 数值字段差 ≥20% 或文本相似度 < 0.6 自动判 conflict(双保留 + 标红)
- 失败重试 + 指数退避(429 / 5xx / 网络超时)

测试:
```bash
npm test  # 4 用例:32 字段定义、V1 解析、冲突阈值、V2 红底导出
```

---

## ⚠️ 已知限制 / 运行须知

### 1. Web 检索：受控搜索（默认 Tavily）

第一版用 Claude 内置 `web_search_20250305` server tool，但**经公司网关 `aiapi.tcredit.com` 时被静默过滤**（实测模型说"我没有联网工具"）。所以现在改为 **Node 端受控搜索 + client-side tool**：

- Node 端实现 `web_search` + `fetch_page` 两个 client-side tool
- Claude 决策搜索词与抓哪个 URL，**Node 端真实执行**，结果回喂给模型
- 不依赖任何上游 web 工具支持，**只要网关能转发 messages.create 就能跑**

**支持的 provider**（在 [src/serp.js](src/serp.js) 实现）：
| Provider | 适合场景 | 免费额度 | env 变量 |
|---|---|---|---|
| **Tavily** ⭐ 默认 | LLM agent 调研专用，结果质量好 | 1000 次/月，注册无信用卡 | `TAVILY_API_KEY` |
| SerpAPI | Google 通用搜索代理 | 100 次/月 | `SERPAPI_API_KEY` + `SERPAPI_ENGINE` |

**配置**（任选其一即可）：
```bash
# 推荐：Tavily — https://tavily.com 注册后填入
TAVILY_API_KEY=tvly-xxxxxxxx

# 或：SerpAPI
SERPAPI_API_KEY=xxxxxxxx
SERPAPI_ENGINE=google      # google | bing | baidu

# 显式指定 provider（可选，默认按 key 自动选 tavily > serpapi）
SEARCH_PROVIDER=tavily
```

**未配置时的行为**：系统仍可用，但 `web_search` 工具返回空结果，模型多数字段会标 `unknown`（不会瞎编）。前端顶栏会显示「搜索未启用」徽章提示。

### 2. 国内站点（企查查、巨潮资讯、Boss直聘）的抓取效果

即便 `web_search` 可用,Anthropic web_search 对国内防爬站点也常被 403,这是行业共性。重要客户调研建议人工复核 source URL 后再采纳。

### 3. 单批容量与成本

- 单次上传 ≤ 50 客户(`MAX_CUSTOMERS_PER_BATCH`)
- 单字段并发 4(`FIELD_CONCURRENCY`)
- 单客户全量调研 ≈ 30 次 API 调用; 5 客户 × 30 字段 = 150 次,opus 4.8 估算消耗 ~150-300k tokens

---

## 二期路线(本 MVP 之外)

- [x] ~~接 Tavily / SerpAPI 受控搜索~~ ✅ 已完成（Tavily 为默认）
- [ ] 多账号 / 权限
- [ ] 调研历史版本对比
- [ ] 字段来源映射可视化配置页
- [ ] 实时进度 SSE 推送(替代轮询)
- [ ] 多模型并行调研同字段做交叉对比(需求中"模型一致性校验")
