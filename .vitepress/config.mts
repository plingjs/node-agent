import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.GITHUB_ACTIONS === 'true' && repositoryName
  ? `/${repositoryName}/`
  : '/'

const chapters = [
  { text: '第 1 章 · 最小 Agent 循环', link: '/lesson01-minimal-agent/docs/course' },
  { text: '第 2 章 · 工具系统', link: '/lesson02-tool-system/docs/course' },
  { text: '第 3 章 · 上下文管理', link: '/lesson03-context/docs/course' },
  { text: '第 4 章 · 核心工具', link: '/lesson04-core-tools/docs/course' },
  { text: '第 5 章 · 记忆与召回', link: '/lesson05-memory/docs/course' },
  { text: '第 6 章 · 多 Agent 委派', link: '/lesson06-multi-agent/docs/course' },
  { text: '第 7 章 · Skill 系统', link: '/lesson07-skill/docs/course' },
  { text: '第 8 章 · Plugin 与 Hooks', link: '/lesson08-plugin/docs/course' },
  { text: '第 9 章 · MCP', link: '/lesson09-mcp/docs/course' },
  { text: '第 10 章 · 多会话与恢复', link: '/lesson10-session/docs/course' },
  { text: '第 11 章 · 消息网关', link: '/lesson11-gateway/docs/course' },
  { text: '第 12 章 · 定时任务', link: '/lesson12-cron/docs/course' },
  { text: '第 13 章 · 生产化基础', link: '/lesson13-production/docs/course' },
]

export default withMermaid(defineConfig({
  base,
  lang: 'zh-CN',
  title: 'Node.js 手写 AI Agent',
  description: '面向 Node.js 入门者的 13 章 Agent 实战教程',
  srcExclude: [
    '**/README.md',
    '**/interview.md',
    '**/media/**',
    '**/video-script*.md',
    '**/report.md',
    '**/MEMORY.md',
    '**/memories/**',
    '**/skills/**',
    'docs/course-plan.md',
  ],
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '入门指南', link: '/docs/beginner-guide' },
      { text: '逐章练习', link: '/docs/beginner-practice' },
      { text: '第一章导读', link: '/lesson01-minimal-agent/docs/request-response-walkthrough' },
    ],
    sidebar: [
      {
        text: '开始学习',
        items: [
          { text: '入门者学习指南', link: '/docs/beginner-guide' },
          { text: '逐章练习册', link: '/docs/beginner-practice' },
          { text: '第 1 章请求与响应导读', link: '/lesson01-minimal-agent/docs/request-response-walkthrough' },
          { text: '第 2 章请求与响应导读', link: '/lesson02-tool-system/docs/request-response-walkthrough' },
        ],
      },
      { text: '第一部分 · 主循环与工具', items: chapters.slice(0, 4) },
      { text: '第二部分 · 记忆与扩展', items: chapters.slice(4, 9) },
      { text: '第三部分 · 接入与运行', items: chapters.slice(9) },
    ],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '更新于' },
  },
  mermaid: {
    theme: 'neutral',
    securityLevel: 'strict',
  },
  vite: {
    optimizeDeps: {
      include: ['fastdom', 'fastdom/extensions/fastdom-promised.js'],
    },
  },
}))
