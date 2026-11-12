# lesson05-memory · 跨会话记忆（RAG 风格）

**一句话定位**：让 Agent 记住跨会话的事——用 LLM 从对话里提炼事实，存成 markdown 文件，下次相关时按关键词召回、注入 system prompt。

这一章站在第 4 章肩膀上：核心工具、防失控、上下文压缩那 14 个文件直接复制过来（`diff` 核对：12 个逐字节相同，`core_tools.js`、`tools/search.js` 是例外，见文件地图），只新增 5 个记忆文件，再把自己接进主循环。

## 学完这一章，你应该能做到

- 说清"记忆"和"上下文压缩"的分工：压缩管本次会话的预算，记忆管跨会话的持久化
- 画出记忆流水线四段：提取 → 存储 → 召回 → 注入，并指出每段落在哪个文件
- 解释异步提取为什么必须配快照、游标、频率阈值、串行队列这四道闸
- 亲手跑通 20 个测试用例（**不需要 API key**），说清每个在钉什么行为
- 指出本章的两个缺口（关键词召回匹配不了同义表述、记忆无生命周期治理）以及生产怎么补

## 前置要求

- Node ≥ 18（用内置 `fetch` 与 `node:test`，零第三方依赖）
- 跑测试不需要任何 API key；只有 `node main.js` 真实对话需要 OpenAI 兼容端点

## 快速开始

### 1. 先跑测试（推荐第一步，不需要任何配置）

```bash
cd lesson05-memory
npm test
```

实测输出：

```text
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ duration_ms 508.277625
```

测试跑在独立的空记忆库上：整个 `memories/` 目录先被挪到 `memories.seed-backup`，跑完再放回来，所以课程自带的演示记忆不会被测试清掉（`test.js:35` 的 `before` 与 `test.js:44` 的 `after`）。

### 2. 看一眼记忆库长什么样（也不需要 key）

课程自带的 `memories/` 就是一份真实演示数据：一个用户先说喜欢白色、又说不再喜欢白色、最后确认喜欢粉色。这份数据是本章的叙事道具——冲突记忆会同时被召回。

```bash
node --input-type=module -e '
import { MemoryManager } from "./memory_manager.js";
const mm = new MemoryManager();
const all = await mm.list();
console.log("记忆库条数:", all.length);
for (const m of all) console.log("  [" + m.type + "]", m.name);
const q = "我喜欢什么颜色？";
console.log("query:", q, "→ 召回", (await mm.recall(q)).length, "条");
console.log("query: 我用什么编辑器？ → 召回", (await mm.recall("我用什么编辑器？")).length, "条");
'
```

实测输出：

```text
记忆库条数: 4
  [user] 用户喜欢的颜色是白色
  [user] 用户颜色偏好：粉色可爱风
  [user] 用户颜色偏好
  [feedback] 用户颜色偏好更新
query: 我喜欢什么颜色？ → 召回 4 条
query: 我用什么编辑器？ → 召回 0 条
```

查询命中了全部 4 条（包括已经作废的白色偏好）；换一个和记忆没有共同词的问题，召回直接掉到 0——那就是本章最诚实的缺口。

### 3. 真实对话（需要 OpenAI 兼容端点）

```bash
node main.js
```

会话 1 教一条偏好，`/exit` 退出；重开终端进会话 2，问同一件事。REPL 的元命令：`/memories` 列出记忆、`/forget <名称>` 删除、`/reset` 清空本轮对话上下文（记忆保留）、`/budget` 看 token 预算、`/exit` 退出。

带 LLM 的完整对话轨迹依赖真实端点，这里不贴转录；`main.js` 的模型调用走 `llm.js`，读 `env.json`（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`），缺字段回落环境变量。

## 文件地图

```
lesson05-memory/
├── 记忆系统（本章新增，569 行）
│   ├── memory_store.js      168 行  v1 存储层：目录结构 + frontmatter 序列化/解析 + MEMORY.md 索引
│   ├── memory_entries.js     83 行  v2 条目层：CRUD + 按 name 去重 + 索引重建
│   ├── extract.js            84 行  v3 提取：提取规则 prompt + JSON 容错解析
│   ├── recall.js            111 行  v4 召回：中英分词 + 加权打分 + 可选 LLM 精排
│   └── memory_manager.js    123 行  v5 门面：统一入口 + 异步提取调度（游标/频率/串行）
├── agent.js                 164 行  ★ 装配：第 4 章主循环 + 记忆注入 + 结束提取
├── main.js                  105 行  入口：REPL + /memories /forget /reset /budget
├── test.js                  422 行  20 个用例（mock LLM，无需 key）
├── memories/                       演示记忆库（4 条，讲"冲突记忆"）
├── 继承第 4 章（14 个文件，其中 12 个逐字节相同）
│   ├── core_tools.js        128 行  六个高杠杆工具的装配（read/list/search/write/fetch/shell）★ 与第 4 章有差异
│   ├── registry_full.js      86 行  执行流水线：查找→解析→权限→校验→执行→结构化错误
│   ├── registry.js           72 行  注册表 v1（本章用 v2 的 registry_full）
│   ├── validation.js         89 行  参数校验（按 schema）
│   ├── errors.js             70 行  错误分层（校验/权限/执行）
│   ├── permissions.js        72 行  权限分级（read 放行 / write 确认 / danger 强制）
│   ├── tools/                       shell 68 / search 83 / filesystem 66 / fetch 35 ★ search.js 与第 4 章有差异
│   ├── context_manager_v2.js 144 行 三层上下文 + 水位线压缩 + 工具结果截断
│   ├── summary_compactor.js  63 行  摘要压缩
│   ├── token_counter.js      57 行  token 估算
│   └── llm.js                51 行  模型层：fetch 调 /chat/completions
└── docs/
    ├── course.md                  教程：记忆流水线逐文件讲解 + 实跑输出
    └── interview.md                面试：10 题（考点/结构/话术/锚点/追问）
```

**推荐阅读顺序**：`memory_store.js`（记忆长什么样）→ `memory_entries.js`（怎么写才不重复）→ `extract.js`（谁决定记什么）→ `recall.js`（怎么找回来）→ `memory_manager.js`（怎么不阻塞对话）→ `agent.js`（怎么接进主循环）→ `main.js` → `test.js`。

前四个是零件，`memory_manager.js` 是调度中枢，`agent.js` 是装配。读 `agent.js` 前先知道它在第 4 章长什么样，本章对它的改动只有两处，其余全是继承。

`core_tools.js` 与 `tools/search.js` 是例外：这两个文件和第 4 章**不同**（复制时带过来的旧版本），前者 `list_files` 的 `dir_path` 是必填参数，后者是 `*` / `?` glob 的另一版实现。本章的功能改动不在这两个文件上，但"14 个文件零改动"的说法只对其中 12 个成立。

## 本章增量（相对第 4 章）

| 类别 | 内容 |
|---|---|
| 新增 5 个文件 | `memory_store.js` / `memory_entries.js` / `extract.js` / `recall.js` / `memory_manager.js`（共 569 行） |
| 重写 `agent.js` | 构造函数改为注入 `memory` 与 `systemPrompt`；`_newContext()`/`reset()` 收进 Agent；`run()` 开头 recall 注入 system、结尾 `scheduleExtract`；返回最后一条 assistant 文本 |
| 装配换 `main.js` | 引入 `MemoryManager`；元命令加 `/memories`、`/forget`，去掉第 4 章的 `/help`；`/reset` 走 `agent.reset()` |
| 轮数上限 | `MAX_TURNS` 由 10 提到 30，撞上限不再直接报错，而是返回最后一条 assistant 文本（没有才回 `【未得到回答】`） |
| 逐字节继承 | `registry*.js`、`validation.js`、`errors.js`、`permissions.js`、`tools/{shell,filesystem,fetch}.js`、`context_manager_v2.js`、`summary_compactor.js`、`token_counter.js`、`llm.js` 共 12 个文件与第 4 章逐字节相同（`diff` 核对） |
| 与第 4 章有差异 | `core_tools.js`（`list_files` 的 `dir_path` 必填）、`tools/search.js`（`*` / `?` glob 的另一版实现）；差异来自更早的复制，不是本章的改动 |
| 未沿用 | 第 4 章的 `context_manager.js`、`sliding_window.js` 没有复制过来（本章只用三层的 `context_manager_v2.js`） |

## 刻意的缺口（缺口 = 后续章节路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| 关键词召回匹配不了同义表述 | 问"我用什么编辑器"召回 0 条，记忆里写的是"Vim"（实测） | 生产换 embedding 向量检索，本章只留接口位置（`recall.js:57`） |
| 记忆无生命周期 | 无 TTL、无容量上限、无衰减，用久了召回噪音变大 | 第 10 章会话持久化 + 第 13 章生产治理 |
| 冲突记忆同时注入 | 白色、粉色、"不喜欢白色"三条一起进 prompt，谁新谁旧交给模型猜 | 条目加时间戳与失效标记（第 13 章） |
| 提取是 fire-and-forget | 打印完回答就退出进程，在飞的提取会被掐断，最后一条记忆可能没落盘 | 第 10 章做退出前 flush |
| 单进程假设 | 文件存储 + 进程内游标，两个进程同写会互相覆盖 | 第 10 章原子写 + 第 13 章数据库 |
| 记忆内容不过滤 | 用户随口说的隐私信息会被提炼进 prompt 与磁盘 | 第 13 章合规与脱敏 |
| 提取只有"轮结束"通道 | 用户明确说"记住这个"也要等轮末异步提取，没有即时写入 | 后续章节 |

## 测试覆盖（20 个用例，全部离线可跑）

| 用例 | 验证什么 |
|---|---|
| 序列化/解析往返（`test.js:60`） | `serializeMemory` → `parseMemory` 得到同一个对象 |
| parseMemory 容忍手写 frontmatter（`test.js:72`） | 分隔符后不空行的文件也能读出来（回归：曾静默丢条目） |
| saveMemory 新记忆 created=true（`test.js:82`） | 首次写入返回 `created: true, deduped: false` |
| saveMemory 同内容去重 deduped=true（`test.js:93`） | 同 name 同内容 → 跳过写盘 |
| Loop 判定后同轮剩余 tool_calls 仍逐条回填（`test.js:388`） | 一条响应里多个同签名调用只执行第一个，其余也各回填一条 LOOP_DETECTED，无孤儿 tool 消息 |
| deleteMemory 删除并更新索引（`test.js:105`） | 删除成功返回 true、不存在返回 false、索引同步 |
| saveMemory 改 type 不留旧目录副本（`test.js:113`） | 记忆换类型后只有一份（回归：曾同一条躺两个目录） |
| parseExtractOutput 容错：纯 JSON（`test.js:124`） | 裸 JSON 数组解析 |
| parseExtractOutput 容错：代码块包裹（`test.js:132`） | ```json 包裹也能解析 |
| parseExtractOutput 容错：非法输入（`test.js:139`） | "我无法生成" / 空串 → `[]`，不抛异常 |
| extractMemories 调用 LLM 并解析（`test.js:144`） | 提取调用传 `tools=null`，返回值走解析链 |
| tokenize 中英文混合（`test.js:157`） | 中文切 2-gram、英文词 ≥2 字符、单字符数字被过滤 |
| recallByKeywords 按相关度排序（`test.js:165`） | 相关记忆排在无关记忆前面 |
| rerankByLLM 按 LLM 判断过滤（`test.js:175`） | 精排按返回序号裁掉不相关候选 |
| scheduleExtract 提取并落库（含游标）（`test.js:191`） | 后台提取落库；同批消息再调度不重复提取 |
| scheduleExtract 频率阈值（`test.js:216`） | 新增消息不足 2 条时不调 LLM（`llmCalls === 0`） |
| Agent 注入相关记忆进 system prompt（`test.js:232`） | system 里同时有基础提示词和"相关记忆"段 |
| Agent run 结束后自动提取记忆（`test.js:262`） | run 结束触发提取，记忆落库 |
| 带工具的 Agent：工具执行 + 记忆注入共存（`test.js:297`） | 记忆注入与第 4 章工具调用互不干扰 |
| 跨会话：新 MemoryManager 能 recall 旧会话存的记忆（`test.js:350`） | 两个独立实例模拟两个进程，证明真落盘 |

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 问"我用什么编辑器"召回 0 条 | 2-gram 关键词和记忆正文没有交集（缺口表第 1 条），不是 bug；换 embedding 检索才是解 |
| 说了"记住 XX"，重开进程没记住 | 提取有 2 条新消息的频率门槛（`memory_manager.js:23`），且是异步的；打印完立刻退出进程会掐断在飞的提取，多聊一轮或稍等一下再退出 |
| 跑测试会不会清掉我的记忆 | 不会。`test.js:35` 把整个 `memories/` 挪到 `memories.seed-backup`，跑完放回 |
| 记忆库里出现两条名字一样、类型不同 | 已在 `memory_entries.js:56` 修掉（换类型时删旧目录副本），并有 `test.js:113` 钉住 |
| 记忆库越用越乱 | 无治理策略（缺口表第 2、3 条）；手动 `/forget <名称>` 是当前唯一的清理手段 |
| 401 / 连接错误 | 检查 `env.json` 的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`，`model` 值别带尾空格 |

## 文档导航

- **教程**（记忆流水线逐文件讲解 + 实跑输出 + 下一章）：`docs/course.md`
- **面试**（10 题三层：考点 / 答题结构 / 参考话术 / 代码锚点 / 常见追问）：`docs/interview.md`