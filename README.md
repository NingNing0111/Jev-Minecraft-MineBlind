# MineBlind

Minecraft 分层自主控制实验：**Mastra Agent → Goal Manager → Jev → 持续技能 → Action Arbiter / Reflex**。设计见 [DESIGN.md](DESIGN.md)。当前为实验实现，不是已经验证可自主通关的机器人。

## 启动

需要 Node.js 22.13+ 和 Minecraft Java 服务器（默认 1.20.1）。

```sh
npm install
cp .env.example .env
# 编辑服务器、实验模式、模型和密钥
npm test
npm start
```

HUD：<http://localhost:3010>，3D Viewer：<http://localhost:3011>。监控接口没有认证，请勿暴露到公网。游戏聊天支持 `!pause`、`!resume`、`!save`；旧 HUD 意图只保留逃跑、进食、放水和 Idle 暂停，其他旧战斗意图不再直接写 Mineflayer 控制状态。

## Mac Mini / Docker 部署

同时运行 Minecraft 服务器和机器人，见 [DOCKER.md](DOCKER.md)。提供原生架构 Dockerfile、健康检查、持久卷和本机绑定端口；Minecraft EULA 必须由你自行接受。已验证 AMD64 镜像构建与离线测试，ARM64 / Mac Mini 和真实服务器端到端验证仍待完成。

## 消融模式

| 模式 | 战略 Agent | 效用门控 | Web | 持久攻略缓存 |
|---|---|---|---|---|
| A | 否 | 否 | 否 | 否 |
| B | 是 | 否（无调用冷却） | 否 | 否 |
| C | 是 | 是 | 否 | 否 |
| D | 是 | 是 | 是 | 否 |
| E | 是 | 是 | 是 | 是 |

设置 `EXPERIMENT_MODE=A`–`E`。B–E 使用 `AGENT_MODEL` 对应提供商的凭据，默认 `openai/gpt-4.1` / `OPENAI_API_KEY`。D–E 的 Agent 可通过 Tavily 搜索，需要 `TAVILY_API_KEY`。搜索结果只作为不可信参考信息；Jev 不可调用该工具。

### 自定义 Responses 提供商

在本地 `.env` 中设置：

```dotenv
AGENT_PROVIDER=openai-responses
AGENT_BASE_URL=https://ai-gateway.pgthinker.me/v1
AGENT_MODEL=gemini-3.8-flash-high
AGENT_API_KEY=替换为你的密钥
```

该路径使用 `@ai-sdk/openai` 的显式 `.responses(model)`，请求 `POST /v1/responses`，**不会回退到 Chat Completions**。模型名原样发送，不加 `openai/` 前缀。密钥仅保存在已忽略的 `.env`，不要提交或写入日志。B–E 启用战略 Agent；A 不调用战略模型。恢复默认路由时设 `AGENT_PROVIDER=mastra` 和 `AGENT_MODEL=openai/gpt-4.1`，使用 `OPENAI_API_KEY`。

离线测试验证请求地址、鉴权、模型名、JSON Schema、工具序列化及 Mastra 接受该模型；尚未验证网关实际支持结构化输出、工具调用或流式响应，不代表已完成在线兼容性验证。

没有 `JEV_API_KEY` 时使用本地战术选择器，**这种运行不能作为 Jev 实验结果**。Jev 请求失败也会记录错误并本地降级。没有 Agent 凭据不会伪造规划成功。

## 模块

- `src/agent/planner.js`：真实 Mastra Agent、Zod 宏观目标结构、缓存优先知识工具。
- `src/goal/manager.js`：库存/维度/结构/胜利证据、目标队列、区域探索进展、有限递归配方拆解。
- `src/jev/client.js`：systemone 技能选择和两类求助理由。
- `src/skills/executor.js`：九类持续技能，以及进食/放水反射。取消后等待原异步操作结束才允许新技能写入。
- `src/bot/arbiter.js`：P0–P4 仲裁、紧急打断和重新执行被打断技能。
- `src/memory/state.js`：30 秒 Working Memory、本局摘要、分维度探索记录、跨局攻略。
- `src/save/save_system.js`：原子快照和 JSONL 实验日志。
- `src/bot/runtime.js`：生命周期重规划、效用评分、状态广播、指标与自动保存。

门控严格采用 DESIGN 权重和边界：低于 0.5 拒绝，0.5–0.75 延迟，高于 0.75 批准。启动/死亡/失败/目标完成/维度变化属于生命周期事件，绕过效用评分；C–E 仍有冷却。求助遭拒时继续本地战术，不空转等待。

## 存档与指标

每 `SAVE_INTERVAL_MS`（默认 5 分钟）、关键事件和退出时保存。设置 `RESTORE_SAVE=latest` 或快照目录可恢复；默认空值开始新运行，不交互询问。请设置 `WORLD_ID`，以避免同一端口更换世界后误用旧存档。恢复检查世界和实验模式。存档只保存 AI 状态，**不回滚 Minecraft 世界/背包**；连接后以实时观测校准。

目录为 `saves/UTC日期/dayNNN_tHHMMSS_UUID/`。使用原子 `latest.json` 指针代替平台相关符号链接。Knowledge 独立存于 `knowledge/minecraft_mechanics/`，E 跨局复用，D 不读写该缓存。

输出 Agent 调用/错误数、Token、死亡数、通关标志、平均调用间隔、自主目标完成归因比例。依赖率使用操作性近似：规划后的下一次已观测目标完成计为 Agent 解决；不是因果归因。调用间隔包括推理延迟和离线恢复时间，比较实验时需控制这些因素。

## 验证与已知边界

`npm test` 是纯离线测试，覆盖模式、门控边界、目标证据/停滞、维度隔离、指标、存档损坏/身份校验、缓存消融、异步取消/抢占和模拟 Mastra 输出。不会调用付费模型或连接 Minecraft。

仍需真实服务器集成验证，尤其放置、传送、战斗与模型接口。当前限制：

- 配方拆解有限；没有自动熔炼、工作台放置、完整装备进阶和食物生产。
- Nether 门支持已有门或 **14 块黑曜石 + 打火石 + 平整无遮挡场地** 的保守构建，不支持岩浆浇筑；进入末地/末地门填眼未实现。
- 结构检测依赖附近可见的标志方块，不是完整遗迹识别，不使用 `/locate`。
- 战斗是基础近战，没有末影水晶、床爆、弓箭和龙阶段策略；不能据此宣称已完成末影龙目标。
- 防火/跌落放水是尝试动作，不保证成功；溺水专项救援未实现。
- Jev 只选择技能，参数来自战术目标；任意位置导航参数选择仍有限。

运行真实消融前应固定服务器版本/世界种子/初始库存，记录模型版本和是否发生本地降级，按多个种子重复试验。
