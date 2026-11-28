import { parseArgs } from "node:util";
import { registerAccount } from "../src/app/accounts.js";
import { registrationSchema } from "../src/contracts/session.js";
import { createPool } from "../src/storage/database.js";

// Creates an account when registration is closed, such as the first administrator. The password comes from
// ACCOUNT_PASSWORD or standard input, so it does not appear in the shell history.
const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
const readInput = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
};
const password = process.env.ACCOUNT_PASSWORD || (process.stdin.isTTY ? "" : await readInput());
const account = registrationSchema.safeParse({ email: values.email ?? "", displayName: values.name ?? "", password });
if (!account.success) {
  console.error("用法：echo '<密码>' | npm run account:create -- --email <邮箱> --name <名字>（密码至少 10 位）");
  process.exit(1);
}
const pool = createPool();
try {
  const outcome = await registerAccount(pool, account.data);
  if (outcome.kind === "taken") {
    console.error(`${account.data.email} 已经注册。`);
    process.exitCode = 1;
  } else {
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [outcome.userId]);
    console.log(`已创建账号 ${account.data.email}。`);
  }
} finally {
  await pool.end();
}
