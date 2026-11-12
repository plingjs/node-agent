/**
 * 临时验证脚本：真实连接 QQ 网关，成功即退出
 * 跑法：node verify_qq.js
 */
import { readFileSync } from "node:fs";
import { getAppAccessToken, QQGateway } from "./gateway/qq_gateway.js";

const cfg = JSON.parse(readFileSync("env.json", "utf8"));

// 10 秒超时保护（连接成功会提前退出）
const timer = setTimeout(() => {
  console.log("[verify] 10 秒未就绪，超时退出");
  process.exit(2);
}, 10000);

const token = await getAppAccessToken(cfg.QQ_APPID, cfg.QQ_SECRET);
console.log("[verify] access_token 获取成功");

const gateway = new QQGateway({ appid: cfg.QQ_APPID, token }, { log: (s) => console.log("[qq]", s) });
await gateway.connect();
console.log("[verify] ✅ 连接成功！机器人已就绪（READY 收到）");
clearTimeout(timer);
gateway.close();
process.exit(0);
