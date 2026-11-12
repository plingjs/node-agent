/**
 * 第2课 · v4: permissions —— 权限分级 + 三态确认（Node 版）
 *
 * 决定"模型能对世界造成多大影响"的关卡。
 * 对应 Qwen Code 的 Kind（Read/Edit/Execute）+ ApprovalMode + awaiting_approval。
 *
 * 三态确认（对应 ProceedOnce / ProceedAlways / Cancel）：
 *   confirm(name, args) 返回：
 *     true    = 批准本次
 *     "always"= 批准并记住（会话内自动放行）
 *     false   = 拒绝
 */

import { permissionDenied } from "./errors.js";

export const Kind = {
  READ: "read",     // 无副作用 → 自动执行
  WRITE: "write",   // 有副作用可逆 → 用户确认，可"始终允许"
  DANGER: "danger", // 高影响不可逆 → 强制确认，不给"始终允许"
};

/**
 * 权限管理器
 * @param {Function} [confirm] 三态确认回调；null = 无确认通道（fail-closed）
 *
 * 面试点：alwaysAllow 是实例字段而不是模块级单例 ——
 * "始终允许"是会话级授权（对应 ApprovalMode 会话内生效），
 * 模块级共享会让会话 A 的授权污染会话 B，这是权限作用域的安全问题。
 */
export class PermissionManager {
  constructor(confirm = null) {
    this.confirm = confirm;
    /** @type {Map<string, string>} 工具名 -> kind */
    this.kinds = new Map();
    /** 会话内"始终允许"集合（对应 ApprovalMode.AUTO_EDIT） */
    this.alwaysAllow = new Set();
  }

  setKind(name, kind) {
    this.kinds.set(name, kind);
  }

  /**
   * 权限决策。返回 true=放行；抛 ToolError=拒绝。
   * 决策树（对应 Qwen Code L5）：
   *   read   → 放行
   *   write  → 已始终允许 → 放行；否则问用户
   *   danger → 强制问用户
   */
  async check(name, args) {
    const kind = this.kinds.get(name);
    if (!Object.values(Kind).includes(kind)) {
      throw permissionDenied(name, "工具没有声明有效的安全等级，默认拒绝");
    }

    if (kind === Kind.READ) return true;
    if (kind === Kind.WRITE && this.alwaysAllow.has(name)) return true;

    if (!this.confirm) {
      // 无确认通道（后台 Agent / 非交互）→ 安全起见拒绝
      throw permissionDenied(name, "无确认通道，默认拒绝");
    }

    if (kind === Kind.DANGER) {
      console.log(`\n  ⚠️  危险操作确认: ${name}(${JSON.stringify(args)})`);
    }
    const decision = await this.confirm(name, args);
    if (decision === "always") {
      this.alwaysAllow.add(name);
      return true;
    }
    if (decision === true) return true;
    throw permissionDenied(name, "用户拒绝");
  }
}
