/**
 * lesson04 · 核心工具：run_shell（代码执行）
 *
 * Agent 最核心的通用工具 —— 图灵完备，一个 shell 等于无限个工具。
 * 对应 Qwen Code 的 shell.ts（5158 行），这里做精简版，把"锁"讲清楚。
 *
 * 安全措施（每个点对应 Qwen Code 的一层防御）：
 *   1. 命令黑名单  拦截破坏性命令（rm -rf / shutdown / fork bomb）
 *   2. 超时控制    防止死循环/长任务（exec 的 timeout 选项）
 *   3. 输出上限    maxBuffer 限制（配合 agent 层的 truncateToolResult 二次截断）
 *   4. 权限分级    注册为 danger 级，执行前需人工确认（在 core_tools.js）
 *
 * 沙箱边界（面试必讲）：Node 的 child_process 不是真沙箱，恶意命令能逃逸。
 * 生产环境必须容器化（Docker / gVisor / Firecracker）或 OS 级隔离。
 */

import { exec } from "node:child_process";

/** 破坏性命令黑名单（教学简化版，生产用完整规则 + 沙箱兜底） */
const FORBIDDEN_PATTERNS = [
  /\brm\s+-rf\b/,          // 递归删除
  /\bshutdown\b/,          // 关机
  /\breboot\b/,            // 重启
  /\bmkfs\b/,              // 格式化磁盘
  /\bdd\s+if=/,            // 写磁盘镜像
  /:\(\)\s*\{\s*:\s*;\s*\}/, // fork bomb（递归函数爆炸）
];

/**
 * 执行 shell 命令。
 * @param {string} command
 * @param {Object} [options]
 * @param {number} [options.timeout] 毫秒，默认 10s
 * @param {string} [options.cwd] 工作目录
 * @returns {Promise<Object>} { stdout, stderr, exitCode, ... }
 */
export function runShell(command, { timeout = 10000, cwd = process.cwd() } = {}) {
  // 1. 黑名单拦截（执行前）
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(command)) {
      return Promise.resolve({
        error: `命令包含危险操作，已拦截：${command}`,
        blocked: true,
      });
    }
  }

  // 2-3. 超时 + 输出上限
  return new Promise((resolve) => {
    exec(
      command,
      { timeout, cwd, maxBuffer: 1024 * 1024 }, // 1MB 输出上限
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            stdout,
            stderr,
            exitCode: err.code,
            timeout: err.killed, // exec 超时时 killed=true
            error: err.message,
          });
        } else {
          resolve({ stdout, stderr, exitCode: 0 });
        }
      },
    );
  });
}
