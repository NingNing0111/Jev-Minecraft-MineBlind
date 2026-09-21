# MineBlind: Hierarchical Agent + Jev Executor 架构设计文档

> **研究目标**：构建一个能够在 Minecraft 中自主完成"击败末影龙"目标的分层 AI 系统，探索快速决策模型（System 1）与强推理规划模型（System 2）之间的最优协作边界。

---

## 0. 核心设计哲学

本项目将整个 AI 决策系统划分为多个认知角色，类比人类行为系统：

| 角色 | 抽象级别 | 时间尺度 | 职责 |
|------|----------|----------|------|
| **LLM Agent** | 战略 (Strategy) | 10分钟 ～ 数小时 | 战略规划、宏观目标设定（System 2） |
| **Goal Manager** | 战术 (Tactics) | 10秒 ～ 10分钟 | 管理目标队列、进度评估与停滞检测 |
| **Jev** | 决策 (Decision) | 100ms ～ 数秒 | 局部策略、即时动作分配（System 1） |
| **Skill Executor**| 技能 (Skill) | 几秒 ～ 几分钟 | 自动完成单一具体操作（如挖矿、寻路） |
| **Reflex** | 反射 (Reflex) | 20Hz (50ms) | 生存本能、高优先级避险动作 |

**核心原则：Agent 不输出 Minecraft 操作细节（如如何挖矿、先做桶再做门），只输出宏观战略目标与约束。**

---

## 1. 整体架构（五层）

```text
                    Internet
                       ↑
                  Web Search
                       ↑
               ┌─────────────┐
               │  LLM Agent  │
               │  System 2   │
               └──────┬──────┘
                      │
               Strategic Goal
                      ↓
             ┌────────────────┐
             │  Goal Manager  │
             └───────┬────────┘
                     │
              Tactical Goal
                     ↓
              ┌────────────┐
Observation → │    Jev     │
              │  System 1  │
              └──────┬─────┘
                     │
                  Skill
                     ↓
             ┌────────────────┐
             │ Skill Executor │
             └───────┬────────┘
                     │
                     ↓
Reflex ───────→ Action Arbiter
                     │
                     ↓
                 Mineflayer
                     │
                     ↓
                 Minecraft
                     │
                     └──── Observation


Jev ──REQUEST_AGENT──→ Escalation Gate
                            │
                     Utility / Budget
                            │
                            ↓
                          Agent
```

---

## 2. 各层职责详解

### 2.1 Layer 1：LLM Agent（战略规划层）

**时间尺度**：10 分钟 ～ 数小时

**职责**：
- 评估当前游戏状态，生成宏观战略目标（Strategic Goal）
- 不应输出极细颗粒度的步骤（如 `obtain_bucket → find_lava → build_portal`），而应输出宽泛的指标（如 `进入下界并获得至少 7 根烈焰棒`）
- 在必要时调用 Web Search 获取 Wiki 机制知识
- 更新 Knowledge Memory 避免重复搜索

### 2.2 Layer 2：Goal Manager（目标调度层）

**时间尺度**：10 秒 ～ 10 分钟

**职责**：
- 将战略目标拆解为 Tactical Goal 供 Jev 消费（如 `寻找要塞`、`获取铁矿`）
- **自动触发 Agent 的机制**：当目标完成、失败、发生关键死亡、维度切换，或长期停滞时，主动调用 Agent。
- 基于 **Progress Evidence** 进行停滞检测。

**Progress Evidence（进度证据）示例**：
```json
{
  "goal": "find_nether_fortress",
  "progress": {
    "completion": 0,
    "exploration_coverage": 0.43,
    "new_chunks_visited": 183,
    "distance_travelled": 2400,
    "new_landmarks": 4,
    "repeated_area_ratio": 0.08
  }
}
```
*注：即使没找到要塞，只要不断探索新区域（`new_chunks_visited` 增加），就不算停滞（NOT STAGNANT）。只有在同一区域兜圈子时才判定为停滞（STAGNANT）。*

### 2.3 Layer 3：Jev（实时决策层）

**时间尺度**：100ms ～ 数秒

**职责**：
- 接收 Tactical Goal 和 Working Memory。
- 决定当前使用什么 **Skill**（技能）或直接动作。
- **唯一的主动求助权**：当且仅当遇到“当前目标无法执行”或“存在语义/知识缺口”时，触发 `REQUEST_AGENT`。

**REQUEST_AGENT 的语义**：
```json
{
  "action": "REQUEST_AGENT",
  "reason": "GOAL_UNACTIONABLE",
  "evidence": {
    "knowledge_gap": "不知如何寻找要塞",
    "attempts": 14
  }
}
```
*Jev 不应因为“找了10分钟没找到”而请求，那是 Goal Manager 的职责。Jev 的请求仅针对知识盲区和无行动方案的卡死。*

### 2.4 Layer 4：Skill Executor（技能执行层）

为了降低 Jev 的高频决策压力，引入持续性技能（Skill）。

**可用的 Skill 列表**：
- `EXPLORE_AREA` (探索区域)
- `NAVIGATE_TO` (导航至目标)
- `MINE_RESOURCE` (挖掘资源)
- `CRAFT_ITEM` (合成物品)
- `FIGHT_MOB` (战斗)
- `FLEE` (逃跑)
- `BUILD_PORTAL` (建造传送门)
- `SEARCH_STRUCTURE` (寻找遗迹)
- `LOOT_CONTAINER` (搜刮箱子)

Jev 的输出示例：
```json
{
  "skill": "MINE_RESOURCE",
  "target": "iron_ore",
  "amount": 3
}
```
Skill Executor 自动调用底层 `pathfinder`、装备对应工具并挖掘，极大稳定系统运行。

### 2.5 Layer 5：Reflex & Action Arbiter（反射与动作仲裁层）

底层的本能反应与高层 Skill 可能发生冲突，因此引入 Action Arbiter。

**优先级 (Action Priority)**：
- `P0`: Emergency Reflex (濒死逃生、防爆)
- `P1`: Survival (着火放水、跌落放水、残血强制进食)
- `P2`: Combat (Jev 分配的战斗 Skill)
- `P3`: Current Skill (日常探索/挖掘/寻路)
- `P4`: Idle

Reflex 触发时可直接打断（Interrupt）当前 Skill，避险结束后再恢复（Resume）或中止（Abort）。

---

## 3. Escalation Gate 与 Agent 效用 (Agent Call Utility)

不再仅仅使用静态的“每小时N次”预算，而是基于效用公式判断是否值得唤醒大模型：

$$U_{agent} = P(success\ improvement) \times V(goal) - Cost(agent)$$

**简化版规则化效用得分 (AgentScore)**：
```text
AgentScore =
    stagnation_score       * 0.30
  + uncertainty_score      * 0.25
  + goal_invalid_score     * 0.25
  + strategic_value_score  * 0.20
```

**裁决逻辑**：
- `< 0.5`: 拒绝调用 (Reject)，Jev 继续尝试。
- `0.5 ~ 0.75`: 暂缓 (Continue / 延迟观察)，加大容错。
- `> 0.75`: 批准调用 (Approve)，唤醒 LLM Agent。

---

## 4. 四类 Memory 系统

根据语义严格划分为四层记忆系统：

### 4.1 Working Memory（给 Jev）
最近数十秒的观测与状态，每次决策随 Observation 传入。包含附近实体、短期障碍物、前序动作等。

### 4.2 Run Memory（给 Agent）
本局游戏的整体进度摘要（当前背包、总血量、死亡次数、已过天数、总调用次数）。

### 4.3 World Model（给 Jev & Agent）
**“这一局世界是什么样”**：
```json
{
  "locations": {
    "home": [0, 64, 0],
    "portal_1": [120, 50, -300],
    "lava_pool_2": [40, 11, 30]
  },
  "explored_regions": ["plains", "desert"],
  "structures": ["village_1"],
  "danger_zones": [],
  "resource_zones": []
}
```

### 4.4 Knowledge Memory（长期持久化）
**“Minecraft 怎么玩”**（跨局复用，由 Web Search 获取）：
```text
knowledge/
├── minecraft_mechanics/
│   ├── nether_portal.md
│   └── stronghold.md
└── strategies/
    └── dragon_fight.md
```

---

## 5. Web Search 集成

**原则**：只有 Agent 可以触发 Web Search，Jev 不能直接联网。

```text
Jev
 ↓ (GOAL_UNACTIONABLE)
REQUEST_AGENT
 ↓
Agent 判断自身 Knowledge Memory 是否充足
 ├── Yes → 直接 Planning
 └── No
      ↓
   Web Search（Minecraft Wiki / 社区攻略）
      ↓
   更新 Knowledge Memory
      ↓
   Planning → Strategic Goal
```

---

## 6. 主循环伪代码

```python
while not game_finished:

    observation = minecraft.observe()
    state.update(observation)           # 更新 Run Memory & World Model

    tactical_goal = goal_manager.current_goal()

    # 1. Reflex 拦截
    if reflex.check(observation):
        action_arbiter.execute(reflex.action, priority=P1)
        continue

    # 2. 进度与停滞自动检测 (Goal Manager 独立于 Jev)
    goal_manager.evaluate_progress_evidence(state)
    
    if goal_manager.needs_agent_intervention():
        call_agent_and_replan()
        continue

    # 3. Jev 决策
    decision = jev.decide(
        observation=observation,
        goal=tactical_goal,
        working_memory=working_memory,
        world_model=world_model
    )

    if decision.action == "REQUEST_AGENT":
        # 仅针对 Knowledge Gap 或 Unactionable
        utility_score = escalation_gate.evaluate_utility(decision.reason)
        if utility_score > 0.75:
            call_agent_and_replan()
        else:
            jev.force_continue()
    else:
        # 4. 执行 Skill
        skill_executor.set_skill(decision.skill, decision.params)
        
    # 5. Skill 推进 Mineflayer
    current_action = skill_executor.tick()
    action_arbiter.execute(current_action, priority=P3)
```

---

## 7. 存档系统（Save System）

### 7.1 设计目标

- 系统崩溃后可从上次存档点继续运行，无需从头开始
- 存档按**真实世界日期 + 游戏内日期**双重索引
- 支持多次存档，同一天可有多个存档点
- Knowledge Memory 跨局持久化，不随存档重置

### 7.2 存档目录结构

```text
saves/
└── 2026-09-21/                        ← 真实世界日期
    ├── day001_t0830/                   ← 游戏第1天，真实时间 08:30
    │   ├── meta.json                   
    │   ├── run_memory.json             
    │   ├── world_model.json            ← 补充：已探索的世界模型
    │   ├── goal_manager.json           
    │   ├── agent_plan.json             
    │   └── experiment_log.jsonl        
    │
    └── latest -> day001_t0830/        ← 符号链接，指向最新存档
```

### 7.3 存档触发逻辑
除了定时存档（如每5分钟），**系统触发（Goal 完成、失败、长期停滞、死亡）时自动执行存档**，以确保关键状态得以保留。

---

## 8. 实验设计（Ablation Study）

**核心研究问题**：快速小模型与高延迟强推理模型之间的最优协作边界在哪里？随着 Agent 调用成本不断提高，一个快模型究竟能承担多长时间尺度的自主决策？

### 8.1 消融实验方案

| 实验 | 配置 | 研究问题 |
|------|------|----------|
| **A** | Jev Only | 无规划层的基线性能 |
| **B** | Jev + Agent（无限调用）| Agent 的价值上限 |
| **C** | Jev + Agent + Escalation Gate | Gate（Utility 评分）对效率的影响 |
| **D** | Jev + Agent + Gate + Web Search | 联网知识的增益 |
| **E** | Jev + Agent + Gate + Web + Memory | 完整系统 |

### 8.2 核心量化指标

除了常规的通关率（Completion Rate）、时间、死亡次数外，增加两项关键指标：

1. **Agent Dependency Ratio (Agent 依赖率)**
   $$Agent Dependency = \frac{\text{Agent 介入解决的关键决策数}}{\text{全部关键决策数}}$$

2. **Mean Autonomous Horizon (平均自主运行时长)**
   定义：两次 Agent Call 之间 Jev 的平均独立运行时间。此指标比“最长自主运行时间”更能体现系统的稳定性。

### 8.3 预期实验曲线：Pareto Frontier

实验数据有望绘制出类似以下的曲线：

```text
Completion Rate
100% │                    ●
     │                 ●
 80% │              ●
     │
 60% │          ●
     │
 40% │      ●
     │
 20% │ ●
     └────────────────────────
       0   2   4   8   16   ∞
          Agent Calls / Hour
```
**结论价值**：这不仅是为了证明 AI 能否打败末影龙，更是为了寻找在复杂开放世界中，System 1 和 System 2 协作的帕累托最优边界（Pareto Frontier）。

---

## 9. 项目目录结构更新

```text
MineBlind/
├── src/
│   ├── bot/
│   │   ├── index.js              # Mineflayer Bot 主入口
│   │   ├── perception.js         # 感知层
│   │   ├── reflex.js             # 反射层 (Reflex Layer)
│   │   └── arbiter.js            # 动作仲裁层 (Action Arbiter)
│   │
│   ├── jev/
│   │   ├── client.js             # Jev HTTP 客户端
│   │   └── prompt.js             # Jev Prompt 构造
│   │
│   ├── skills/                   # 技能执行层 (Skill Executor)
│   │   ├── explore.js
│   │   ├── combat.js
│   │   └── craft.js
│   │
│   ├── agent/
│   │   ├── planner.js            # LLM Agent
│   │   └── web_search.js         # Web Search
│   │
│   ├── goal/
│   │   ├── manager.js            # Goal Manager
│   │   └── progress.js           # Progress Evidence 停滞检测
│   │
│   ├── escalation/
│   │   └── gate.js               # Agent Call Utility 评分与门控
│   │
│   ├── memory/
│   │   ├── working_memory.js     # 给 Jev 的即时记忆
│   │   ├── run_memory.js         # 给 Agent 的本局游戏摘要
│   │   ├── world_model.js        # 这一局的世界地图和资源坐标
│   │   └── knowledge_memory.js   # 全局持久化的攻略和机制
│   │
│   └── save/
│       ├── save_system.js        # 存档读写
│       └── restore.js            # 启动时恢复
│
├── saves/                        # 存档目录（含真实日期分层）
├── knowledge/                    # 知识库（跨局持久化）
├── DESIGN.md                     
└── index.js                      
```