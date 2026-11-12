---
layout: home
title: Node.js 手写 AI Agent
titleTemplate: false
hero:
  name: Node.js 手写 AI Agent
  text: 从一次工具调用开始
  tagline: 面向只有少量 Node.js 经验的学习者，沿着 13 章代码搭出自己的 Agent。
  actions:
    - theme: brand
      text: 从第 1 章开始
      link: /lesson01-minimal-agent/docs/course
    - theme: alt
      text: 先看入门指南
      link: /docs/beginner-guide
    - theme: alt
      text: 打开练习册
      link: /docs/beginner-practice
features:
  - title: 先看见完整过程
    details: 从模型请求、tool_calls、本地执行到结果回填，先读懂 Agent 最小闭环。
  - title: 每章解决一个问题
    details: 逐步加入工具校验、上下文、记忆、委派、Skill、Plugin、MCP 与会话。
  - title: 用练习确认理解
    details: 每章有一个可操作的小任务和清晰的完成标准，优先使用假模型与本地数据。
---

## 适合谁

你会一些 JavaScript，认识对象、数组、Promise、`async/await`，也能在终端运行 Node.js 程序。本教程会带你读 Agent 的关键代码，不要求先学机器学习或特定 Agent 框架。

## 建议的学习顺序

1. 打开[入门者学习指南](/docs/beginner-guide)，确认环境并了解章节路线。
2. 从[第 1 章](/lesson01-minimal-agent/docs/course)开始，每章先按对应 README 的“快速开始”运行代码。
3. 沿着教程追一条数据流，再完成[逐章练习册](/docs/beginner-practice)中的任务。

真实模型调用需要兼容 OpenAI Chat Completions 接口的服务。各章离线用例使用假模型或本地替身；模型配置以对应章节 README 为准。
