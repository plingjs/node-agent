# lesson07-skill · Skill 系统（给 Agent 装经验）

**一句话定位**：新增 4 个文件 266 行，把"某类任务怎么做"写成 `skills/<name>/SKILL.md`，让 Agent 在正确的时候把它读进 system prompt——工具没变，用法变了。

前六章里 Agent 有了工具、主循环、长期记忆和子 Agent，但它仍然不知道"做 code review 应该先看 diff 再读文件、按严重度汇报"。有 `run_shell` 不等于会用 `run_shell`，这一章补的就是这层领域经验。

## 学完这一章，你应该能做到

- 一句话分清 Skill / MCP / Plugin：谁是协议、谁是代码、谁是知识，各自什么时候加载
- 手写一个 `SKILL.md`（frontmatter 四个字段 + 步骤/要点/示例正文），并说清 `when_to_use` 为什么必须单列成一个字段
- 讲清两条触发通道：模型主动调 `skill("code-review")`、框架按 `when_to_use` 打分自动注入，以及为什么自动注入只取 Top 1
- 说清三段注入（相关记忆 + 已加载技能 + 可用技能清单）在 system prompt 尾部的拼接顺序，以及"可用清单"少了会怎样
- 跑通 17 个用例并说清每个钉住什么，包括 2 个钉住本章缺口的用例

## 前置要求

- Node ≥ 18（本章用内置 `node:test`、内置 `fetch`，零第三方依赖）
- **跑测试不需要任何 API key**；只有真实对话（`node main.js`）才需要模型服务
- 推荐先读完第 6 章：本章的 Agent 是在第 6 章代码上叠加的，23 个源文件原样带过来（`subagent.js` 多一个委派工厂注入点，见本章增量）

## 快速开始

### 1. 先跑测试（第一步，不需要配置）

```bash
cd lesson07-skill
npm test
```

实测输出（17 个用例，约 180ms）。测试用假 LLM（`fakeLlm`）和真实的 `skills/` 目录驱动，不联网、不花 token：

```text
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 176.310041
```

### 2. 真实跑一次（需要 OpenAI 兼容端点）

在章节目录下建 `env.json`（不要提交进 git）：

```json
{
  "OPENAI_API_KEY": "你的key",
  "OPENAI_BASE_URL": "https://你的推理服务/v1",
  "OPENAI_MODEL": "qwen38-27b"
}
```

```bash
node main.js
```

启动时会先打印技能清单（`main.js:49`），并提示示例输入（`main.js:50`）。技能名与顺序来自实跑 `skills.list()`（`main.js:49` 用 `" / "` 连接打印）：

```text
可用技能：bug-hunt / code-review / report
```

进 REPL 后试这几句。右列的打分是离线实跑 `match()` 得到的结果，不是模型输出：

```text
你> 帮我 review 一下 lesson07-skill 目录的代码     → 命中 code-review（打分 6，次名 1）
你> 帮我排查一下这个报错                          → 命中 bug-hunt（打分 5）
你> 今天天气怎么样                                → 无命中，不注入技能
你> /skills                                       → 列出三个技能及其触发关键词
```

`verbose: true` 开着（`main.js:44`），每轮的工具调用会打印 `[tool] skill -> {...}`，这就是显式加载技能的那一步。

## 文件地图

本章只列新增与改动的文件；其余 23 个源文件从第 6 章原样带过来，零改动。

```
lesson07-skill/
├── skill_store.js         95 行   ★ SKILL.md → 对象：frontmatter 解析、tools 数组、skills/ 目录遍历
├── skill_registry.js      64 行   ★ 索引：load/list/get/match，打分规则 when_to_use×2 > description/name×1
├── skill_tool.js          61 行   ★ 显式通道：skill 工具（返回技能正文）+ 可用技能清单文本
├── skill_trigger.js       46 行   ★ 自动通道：matchSkillsForInput（只取 Top 1）+ buildSkillInjection
├── agent.js              198 行   ★ 集成：注册 skill 工具、懒加载技能、三段注入拼 system
├── main.js               101 行   REPL：/skills 元命令、启动打印技能清单
├── test.js               341 行   17 个用例（mock LLM，无需 key）
├── skills/                        三个示例技能（本章新增的数据，不是代码）
│   ├── code-review/SKILL.md  24 行   代码审查：先 git diff 定位 → 逐文件读上下文 → 分严重度汇报
│   ├── bug-hunt/SKILL.md     21 行   排障：先复现现象 → 追根因 → 验证假设 → 给结论
│   └── report/SKILL.md       25 行   写报告：摘要先于详情 → 证据支撑结论 → 给可执行建议
├── package.json                   name/description 改名
└── docs/
    ├── course.md                  教程：为什么需要技能 / 逐文件讲代码 / 真实注入文本 / 下一章
    └── interview.md               10 题三层：考点 / 答题结构 / 话术 / 代码锚点 / 追问
```

**推荐阅读顺序**：`skills/code-review/SKILL.md`（先看数据长什么样）→ `skill_store.js`（怎么解析）→ `skill_registry.js`（怎么打分）→ `skill_tool.js`（显式加载）→ `skill_trigger.js`（自动触发）→ `agent.js:107-118`（三段注入拼起来）→ `main.js` → `test.js`。

**从第 6 章原样继承的 23 个文件**（本章不动它们）：`core_tools.js` / `registry.js` / `registry_full.js` / `validation.js` / `errors.js` / `permissions.js` / `tools/`（shell、filesystem、search、fetch）/ `context_manager_v2.js` / `summary_compactor.js` / `context_select.js` / `token_counter.js` / `memory_store.js` / `memory_manager.js` / `memory_entries.js` / `recall.js` / `extract.js` / `agent_tool.js` / `depth_guard.js` / `parallel.js` / `llm.js`（`subagent.js` 不在此列，见增量表）。

## 本章增量（相对第 6 章）

| 位置 | 改了什么 |
|---|---|
| 新增 `skill_store.js` / `skill_registry.js` / `skill_tool.js` / `skill_trigger.js` | 266 行，技能从文件到注入的整条链路 |
| 新增 `skills/*/SKILL.md` ×3 | 70 行 markdown，是数据不是代码（加技能不用改一行源码） |
| `agent.js` | +26 行（172 → 198）：构造时注册 `skill` 工具（`agent.js:66`）、首次 run 懒加载技能（`agent.js:70-75`）、run 里把技能注入拼进 system（`agent.js:107-118`） |
| `subagent.js` | +3 行（161 → 164）：构造函数多一个 `delegateFactory` 注入点，循环与防失控部分与第 6 章相同 |
| `agent.js` 上下文预算 | 第 6 章的 `maxTokens: 4096 / reserveForOutput: 512` 在真实会话里几乎每轮都会触发压缩，本章改回第 5 章的 `40960 / 5120` |
| `main.js` | 加 `/skills` 元命令、启动打印技能清单；去掉第 6 章的 `/demo` 并行委派演示（`demo/` 目录没有带过来） |
| `test.js` | 用例换成本章的 17 个：2 个负向/缺口用例 + 1 个最小注入用例 + 2 条 Loop 配对回归；第 6 章的委派链路由同源文件与其自身用例背书 |
| `package.json` | name / description 改为 lesson07-skill |

技能的接入点只有 `agent.js` 里三处：注册工具、注入文本、懒加载。工具调度、权限、上下文压缩、记忆、委派这些机制一个都没动——这是"声明式扩展"的账面证据。

## 本章刻意不做的事（缺口 = 后续课程路线图）

| 缺口 | 后果 | 在哪一章补 |
|---|---|---|
| 匹配只有字面关键词（2-gram），没有语义 | 用户说"帮我看看这段 Vim 配置"，技能里写的是"编辑器配置"就召回不到，只能靠模型显式调 `skill` 工具 | 第 5 章记忆召回同款局限；生产换 embedding，`match()` 是唯一改动点 |
| `tools` 字段只声明、不生效 | 技能写的最小工具集没有被执行层强制，模型仍能调别的工具 | 第 8 章 Hooks（PreToolUse 拦截点）；生产也可在 registry 层按技能过滤 schema |
| 技能冲突只靠"取分数最高的一个" | 两个技能场景重叠时另一个被静默丢弃，没有冲突检测或合并 | 第 8 章 Hooks 可写可编程决策；本章接口预留 |
| 技能不能引用技能 | 复杂流程要在单个 body 里写全，无法拆成可复用的小技能 | 未排课；生产用技能分组或编排层 |
| 技能只在首次 run 加载一次 | 改了 `SKILL.md` 必须重启进程才生效 | 第 10 章的会话恢复语义；生产用 `fs.watch` 热更新 |
| 没有技能评测集 | 无法回答"加了技能到底提升了多少"，只能靠肉眼 | 第 13 章评测三型用例（`expectTools`）可扩展成技能回归 |
| 技能正文进 system，没有长度上限 | 写得越长越挤占上下文窗口 | 第 3 章的三层上下文与压缩兜底能扛住，但不该依赖它 |
| 单个 `SKILL.md` 解析失败返回 `null` 静默跳过 | 技能写错不报错，表现只是"技能列表少了一个" | 已用负向测试钉住（`test.js:72`）；生产要在启动时校验并告警（第 13 章观测） |

## 测试覆盖（17 个用例，全部可离线跑）

| 用例 | 行号 | 验证什么 |
|---|---|---|
| parseSkill 解析 frontmatter + body | `test.js:34` | 四个字段解析正确，`tools: [a, b]` 变成数组 |
| serialize → parse 往返 | `test.js:54` | 序列化再解析回来对象完全相等 |
| loadAllSkills 加载 3 个示例技能 | `test.js:66` | 目录遍历拿到 bug-hunt / code-review / report |
| parseSkill 对非技能内容返回 null | `test.js:72` | （负向）没有 frontmatter 或缺 `name` → 返回 null，不抛异常 |
| SkillRegistry load/list/get/match | `test.js:79` | 索引三件套 + "帮我 review 一下代码" 最高分是 code-review |
| skill 工具：加载存在的技能 | `test.js:94` | 返回 `skill.name` 与技能正文 |
| skill 工具：不存在的技能 | `test.js:104` | 返回错误 + 可用技能清单（帮模型自我纠正） |
| buildAvailableSkillsPrompt 生成清单 | `test.js:114` | 清单文本含技能名 |
| skill 工具只回填知识，不改工具集 | `test.js:122` | （钉住缺口）返回体只有 name/description/content，`tools` 白名单不参与执行 |
| matchSkillsForInput 命中 when_to_use | `test.js:134` | "帮我排查一下这个报错" 命中 bug-hunt |
| 无匹配时不注入 | `test.js:143` | "今天天气怎么样" 命中数为 0 |
| 多技能命中只注入 Top 1 | `test.js:151` | 一句话同时命中两个技能时，自动注入只留分数高的那个 |
| buildSkillInjection 格式化注入文本 | `test.js:164` | 注入文本含"已加载技能"+ 技能名 + 正文；空数组返回空串 |
| Agent 自动加载匹配技能进 system | `test.js:176` | 断言 `messages[0].content` 同时含基础提示、已加载技能、code-review、可用技能（`test.js:197-200`） |
| Agent 可主动调用 skill 工具 | `test.js:203` | 模型第一轮调 `skill("report")`，正文回填后按技能执行（`test.js:238`） |
| Agent：Loop 判定后同轮剩余 tool_calls 逐条回填 | `test.js:261` | 一轮多个同签名调用只执行第一个，其余各回填 LOOP_DETECTED，无孤儿 tool 消息 |
| 子 Agent：同一场景 | `test.js:297` | 子 Agent 的循环同样逐条回填，父子行为一致 |

两个集成用例（`test.js:176`、`test.js:203`）不看最终回答好不好，只看 system prompt 和工具回填里有没有技能内容——"注入"这件事必须能被断言，否则无法回归。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 模型返回 `技能不存在: xxx` | 它调了一个没写过的技能名；`skill` 工具会把可用清单一起回填（`skill_tool.js:36-40`），模型下一轮通常自己改对 |
| 明明是技能场景，却没有自动注入 | 关键词是字面 2-gram 匹配，换个说法就召回不到；让模型用 `skill` 工具显式加载兜底 |
| 改了 `SKILL.md` 没生效 | 技能只在首次 `run` 前懒加载一次（`agent.js:70-75`），重启进程 |
| 想自动注入多个技能 | 改 `skill_trigger.js:16` 的 `AUTO_INJECT_LIMIT`；注入多个技能会让模型注意力分散，本章默认只留 1 |
| 新增了 `skills/xxx/` 但列表还是 3 个 | 目录下必须有 `SKILL.md`，且 frontmatter 必须有 `name` 字段，否则 `parseSkill` 返回 null 被静默跳过（见"缺口表"最后一行） |
| `[错误] ... （检查 env.json 配置）` | `env.json` 的 key / base_url / model 没配好；model 值不要带尾空格 |
| 技能示例里提到的 `demo 目录` 不存在 | 那是第 6 章的演示目录，本章没有带过来；试技能时把路径换成真实目录（如 `lesson07-skill` 本体） |

## 文档导航

- **教程**：`docs/course.md` —— 为什么需要技能、SKILL.md 怎么变成提示、两条触发通道、真实注入文本与用例表
- **面试**：`docs/interview.md` —— 10 题三层（T1 基础 / T2 工程深度 / T3 架构设计），每题带考点、答题结构、话术、真实行号锚点与追问
