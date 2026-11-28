import { z } from "zod";
import type { MailConfig } from "./mail.js";

const flag = z.enum(["true", "false"]).default("false").transform(value => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL 未设置"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MODEL_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  AGENT_SETTINGS_ADMIN_EMAILS: z.string().default(""),
  REGISTRATION_ENABLED: flag,
  // Applies pending migrations before listening, for containers that start from an empty database.
  MIGRATE_ON_START: flag,
  // Sending mail for email verification and password reset: "log" in development, "resend" or "none" in production.
  MAIL_PROVIDER: z.enum(["none", "log", "resend"]).optional(),
  MAIL_FROM: z.string().optional(),
  MAIL_API_KEY: z.string().optional(),
  MAIL_API_URL: z.url().default("https://api.resend.com/emails"),
  // The address people open the site at, used to build links in mail.
  PUBLIC_BASE_URL: z.url().optional(),
  // How many proxies in front of the server to trust for the client address: "false", "true" or a hop count.
  TRUST_PROXY: z.union([z.enum(["true", "false"]).transform(value => value === "true"), z.coerce.number().int().min(1).max(10)])
    .default(false),
});

export type ServerConfig = z.infer<typeof schema> & { mail: MailConfig; publicBaseUrl: string };

// Reads the environment once at start. In production the server refuses settings that would expose demo accounts
// or leave saved model keys unencrypted, and lists every problem at once.
export function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")));
  if (!parsed.success) throw new Error("服务端配置有误：\n" + parsed.error.issues.map(issue => `- ${issue.path.join(".")}: ${issue.message}`).join("\n"));
  const production = parsed.data.NODE_ENV === "production";
  const provider = parsed.data.MAIL_PROVIDER ?? (production ? "none" : "log");
  const mail: MailConfig = provider === "resend"
    ? { provider, apiKey: parsed.data.MAIL_API_KEY ?? "", from: parsed.data.MAIL_FROM ?? "", apiUrl: parsed.data.MAIL_API_URL }
    : { provider };
  const config = { ...parsed.data, mail, publicBaseUrl: (parsed.data.PUBLIC_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/u, "") };
  const mailProblems = [
    provider === "resend" && !parsed.data.MAIL_API_KEY && "MAIL_PROVIDER=resend 需要 MAIL_API_KEY。",
    provider === "resend" && !parsed.data.MAIL_FROM && "MAIL_PROVIDER=resend 需要 MAIL_FROM，例如 Human Epochs <noreply@example.com>。",
  ].filter(Boolean);
  if (!production) {
    if (mailProblems.length) throw new Error("服务端配置有误：\n" + mailProblems.map(problem => "- " + problem).join("\n"));
    return config;
  }
  const problems = [
    ...mailProblems,
    provider === "log" && "MAIL_PROVIDER=log 会把重置密码链接写进日志，生产环境请改用 resend 或 none。",
    provider !== "none" && !parsed.data.PUBLIC_BASE_URL && "发送邮件需要 PUBLIC_BASE_URL，邮件里的链接以它开头。",
    !config.MODEL_CREDENTIAL_ENCRYPTION_KEY && "MODEL_CREDENTIAL_ENCRYPTION_KEY 未设置：生产环境需要它加密在 Web 保存的模型密钥。",
    /@example\.test\b/i.test(config.AGENT_SETTINGS_ADMIN_EMAILS) && "AGENT_SETTINGS_ADMIN_EMAILS 仍包含演示账号：请改为真实管理员邮箱。",
  ].filter(Boolean);
  if (problems.length) throw new Error("生产环境配置有误：\n" + problems.map(problem => "- " + problem).join("\n"));
  return config;
}
