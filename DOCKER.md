# Mac Mini Docker 部署

使用 Docker Compose 同时运行 Minecraft Java 1.20.1 和 MineBlind。支持 Apple Silicon / Intel 的原生镜像选择，不强制 `linux/amd64`。Apple Silicon 首次构建会从源码编译 canvas，耗时可能较长。

## 1. 准备

- 安装并启动 Docker Desktop（对应 Apple Silicon 或 Intel），使用 Compose v2.17+。
- 建议 Docker 虚拟机至少分配 **6 GB RAM**，并为 macOS 留出内存；世界生成和构建还需要空闲磁盘。8 GB 整机可能较紧张，16 GB+ 更合适。
- 默认 Minecraft Java 堆 2 GB / 容器上限 3 GB，机器人容器上限 2 GB。上限不是预留；Docker 虚拟机仍必须有足够内存。
- 在项目目录运行下列命令。不要覆盖已有 `.env`：

```sh
test -f .env || cp .env.example .env
```

编辑 `.env`：

```dotenv
# 先阅读 https://aka.ms/MinecraftEULA；仅在你同意后自行改成 TRUE
MINECRAFT_EULA=FALSE
BIND_IP=127.0.0.1
MC_MEMORY=2G
MC_CONTAINER_MEMORY=3G
BOT_CONTAINER_MEMORY=2G
WORLD_ID=docker-world
RESTORE_SAVE=
MC_SEED=
```

首次运行保持 `RESTORE_SAVE=` 空值；已有快照后可改为 `RESTORE_SAVE=latest` 并运行 `docker compose up -d`，以便后续重启恢复 AI 状态。空值在每次启动时开始新的 AI 运行；`latest` 在没有快照时会初始化失败，而不会静默开始新运行。更换世界需更换 `WORLD_ID`，实验模式也必须匹配。种子仅在新世界首次创建时生效，修改 `MC_SEED` 不会重建已有世界。

默认配置 **不会接受 EULA，也不会成功启动 Minecraft**。只有你确认同意并设置 `MINECRAFT_EULA=TRUE` 后才继续。

实验模式/提供商配置沿用 README。若只想进行无模型费用的连接测试，请自行设置 `EXPERIMENT_MODE=A`、`JEV_API_KEY=`（空值）；此时使用本地战术选择器，不属于 Jev 实验。正常实验请使用所需密钥；启动后可能自动调用模型。不要把密钥提交到仓库。

Compose 强制机器人使用内部地址 `minecraft:25565`、offline 身份、1.20.1、HUD 3010、Viewer 3011 和卷内存档路径，因此 `.env` 中对应的本机连接配置不会生效。

## 2. 构建与启动

```sh
docker compose config --quiet
docker compose build mineblind
# 确认 EULA 和模型费用配置后：
docker compose up -d
docker compose ps
docker compose logs --tail=100 -f minecraft mineblind
```

首次启动需要下载服务端和生成世界。机器人等待 Minecraft 健康检查通过后才启动，HUD 在机器人成功出生后才开启。

- HUD：http://localhost:3010
- Viewer：http://localhost:3011
- 同一 Mac 上的 Minecraft Java 1.20.1 客户端：`localhost:25565`

Minecraft 设置为 **offline mode** 以供机器人连接；HUD/Viewer 也没有认证。三个端口默认仅绑定回环地址。**不要改成 `0.0.0.0` 或暴露到公网**，offline mode 无法验证玩家身份。远程管理优先使用 SSH 隧道，例如从另一台机器运行 `ssh -L 3010:localhost:3010 -L 3011:localhost:3011 user@mac-mini`。

`.env` 不进入镜像，但会作为运行时环境注入机器人容器；拥有 Docker 管理权限的人仍能查看它。避免共享 `docker inspect` 或完整 `docker compose config` 输出，后者可能包含密钥。

## 3. 停止、重启和持久化

```sh
docker compose stop                  # 优雅停止，保留容器与数据
docker compose start                 # 启动已有容器
docker compose restart mineblind     # 重启机器人
docker compose up -d --build         # 更新源码/配置后重建和重建容器
docker compose down                 # 删除容器/网络，保留数据卷
```

修改 `.env` 后用 `up -d` 重建容器；仅 `restart` 不会更新环境变量。默认 `unless-stopped` 在进程退出时重启；**unhealthy 状态本身不会触发 Docker 自动重启**。Docker Desktop 必须运行，Mac 也必须保持唤醒，不能把此配置视为无人值守服务保证。

命名卷（默认项目名前缀 `mineblind_`）：

| 卷 | 内容 |
|---|---|
| `minecraft-data` | Minecraft 世界、玩家数据和服务器配置 |
| `agent-saves` | AI 快照和实验日志 |
| `agent-knowledge` | 持久攻略缓存 |

机器人以非 root 的 UID 1000 运行；默认命名卷在首次创建时继承镜像目录权限。若改用宿主机绑定目录，需自行确保可写。Minecraft 世界/玩家背包与 AI 快照分别保存，恢复 AI 快照**不会回滚游戏世界**。

**不要运行 `docker compose down -v`，除非明确要永久删除整个实验的世界、快照和缓存。** 改项目名也会使用不同的数据卷。

备份时先 `docker compose stop`，再用 Docker Desktop 的卷导出功能或卷备份工具完整备份以上三个卷；恢复时保持项目名、世界身份、模式和游戏版本一致，然后 `docker compose up -d`。只备份源码或 `.env` 不包含世界数据。Minecraft 默认关闭 RCON。

## 4. 排查与验证边界

- Minecraft 反复退出：检查 EULA 是否由你明确接受、内存/磁盘是否充足、下载是否可达。
- 机器人未启动：检查 `docker compose ps`，Minecraft 必须先 healthy。
- HUD 无响应：检查机器人是否已连接并出生，3010/3011 是否被占用。
- OOM：查看 Docker Desktop 和 `docker stats`；增加虚拟机内存，或谨慎降低 Java 堆/视距。容器上限应高于 Java 堆，给 JVM 原生内存留余量。
- 更新基础镜像：`docker compose build --pull mineblind`、`docker compose pull minecraft`，再 `docker compose up -d`。基础镜像标签会变化，严格复现实验应记录镜像 digest。

已在 Linux AMD64 上验证构建、容器内 13 项离线测试、canvas 原生依赖、非 root 身份、镜像无 `.env` 和可写数据目录；无网络容器中连接拒绝后进程可正常退出（未验证出生后的断线恢复）。确认两个基础镜像均提供 ARM64 manifest。**尚未在 Mac Mini / ARM64 上实际构建运行，也未完成真实 Minecraft 服务端的连接、Viewer、游戏操作及重启恢复端到端验证。** 离线验证不代表已完成自主通关或模型在线兼容性测试。
