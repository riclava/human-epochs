# Human Epochs

Human Epochs 是面向 Web 和 App 的通用学习 Agent。用户可以从自己想弄懂的问题出发，选择深入学习的方向。长期愿景是实现数字生命，让 Agent 从用户愿意分享的经历、选择和纠正中，逐渐理解这个人。[概要设计](docs/agent-design.md)

登录后可以直接提问或追问。换设备登录同一账号，可以接着读已有对话和回复中的引文。在线模式下讨论课程材料后，Agent 可以安排一道复习题，并在下次合适的时间从对话里邀请你试一试。

## 本地启动

使用 Node.js 22.22 或较新的 LTS 版本，以及正在运行的 Docker。首次启动时在仓库根目录执行以下命令。

```sh
npm ci
cp .env.example .env
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

打开 [本地 Web](http://127.0.0.1:5173)。Alice 的邮箱是 `alice@example.test`，Bob 的邮箱是 `bob@example.test`，演示密码均为 `HumanEpochs-demo-1!`。

`npm run dev` 同时启动 Web 和 API。

数据库通过 Docker 卷持久化，映射到本机 55432 端口，服务端默认使用 3001，Web 开发服务器使用 5173。项目使用单一初始化迁移，API 在开始监听前核对迁移记录。使用旧数据库结构的开发环境需将 `DATABASE_URL` 指向新的空库，再运行迁移和演示初始化。重复执行当前版本的迁移和初始化会保留该库的账号与进度。生产环境禁止执行演示初始化。

默认使用本地学习引导，根据对话帮助用户梳理学习目标和第一步。要启用模型回复，在服务端 `.env` 中设置 `MODEL_API_KEY`，按供应商填写 `MODEL_BASE_URL` 和 `MODEL_ID`，然后重启服务端。在线模式会把当前问题、相关前文和本轮获准的记忆发送到配置的模型服务。后台摘要任务也会向该模型发送所选用户原话。[配置示例](.env.example)

已有账号可通过 `AGENT_SETTINGS_ADMIN_EMAILS` 获得运行设置权限。多个邮箱用英文逗号分隔，变更名单后重启服务。开发配置示例授权 Alice。登录后从侧栏进入「运行设置」，可调整模型生成、上下文与材料、执行预算。保存后，新的在线模型尝试会读取同一份设置。[运行参数契约](docs/architecture.md#运行设置)

登录页提供注册入口，由 `.env` 中的 `REGISTRATION_ENABLED` 控制，设为 `false` 时只能使用已有账号。登录后点侧栏底部的名字进入「账号设置」，可以改名字、改密码或删除账号。

管理员可在 Web 的「模型连接」直接填写 OpenAI 兼容服务的 Base URL、API Key 和模型 ID。首次从 Web 保存 API Key 前，在服务端 `.env` 配置通过 `openssl rand -base64 32` 生成的 `MODEL_CREDENTIAL_ENCRYPTION_KEY` 并重启。该值用于加密已保存的 API Key，同一部署的服务实例共用。使用同一地址时可将 API Key 留空，更换地址时填写该地址的密钥。内网或本机模型可通过 `MODEL_ALLOWED_PRIVATE_BASE_URLS` 明确配置完整地址。AI 设置助手可以建议模型 ID 和运行参数，Base URL 与 API Key 由管理员手工填写。[配置示例](.env.example)

## 检查和构建

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run build
npm start
```

`check` 包含类型检查、契约测试和 PostgreSQL 接口测试。接口测试创建并清理独立数据库，因此 `DATABASE_URL` 对应账号需有创建数据库权限，本地 Compose 账号已具备。浏览器测试也会创建、迁移并清理专用数据库，使用 5317/3307 端口启动 Web 和 API。浏览器用例验证对话与跨端续读。

`build` 生成 Web 产物，`start` 通过同一个服务端提供 API 和构建后的页面，可从 [本地服务](http://127.0.0.1:3001) 打开。配置通过服务端环境变量读取，演示凭据提示仅在开发页面显示。

## 当前交付

Web 提供文字对话、跨端续读、消息重试和显式停止回复。服务进程将对话收件、模型耗时与用量、工具结果和发布状态记录到标准错误流。 [架构设计](docs/architecture.md#6-可观测性与验收)

服务端提供材料讨论、活动接续、活动内问答和提示领取。活动内问答可跨端回看，活动详情返回已领提示。[技术选型](docs/technology-choices.md) · [架构设计](docs/architecture.md)

可以在已完成的对话消息下记住所说的内容，也能在原消息旁查看、纠正、撤回授权或忘记。启用在线模型后，普通对话可以读取用户已授权的记忆。长对话裁剪前文时，服务端按对话或材料讨论分支后台生成摘要。使用记忆的回复核验后发布。 [记忆系统设计](docs/memory-design.md)
