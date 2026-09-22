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
mkdir -p data/minecraft data/saves data/knowledge
# Linux 上若 UID 1000 无写权限，先调整这三个目录的属主（见下文）。
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

HUD 内嵌 Viewer 自动使用当前浏览器访问主机的 `3011` 端口，不依赖 Cloudflare 隧道。机器人通过 Docker 内网连接 `minecraft:25565`；浏览器通过已发布的 3010/3011 端口访问界面。修改前端后运行 `docker compose up -d --build mineblind` 重建应用镜像，再刷新页面。
- 同一 Mac 上的 Minecraft Java 1.20.1 客户端：`localhost:25565`

Minecraft 设置为 **offline mode** 以供机器人连接；HUD/Viewer 也没有认证。三个端口默认仅绑定回环地址。**不要改成 `0.0.0.0` 或暴露到公网**，offline mode 无法验证玩家身份。远程管理优先使用 SSH 隧道，例如从另一台机器运行 `ssh -L 3010:localhost:3010 -L 3011:localhost:3011 user@mac-mini`。

`.env` 不进入镜像，但会作为运行时环境注入机器人容器；拥有 Docker 管理权限的人仍能查看它。避免共享 `docker inspect` 或完整 `docker compose config` 输出，后者可能包含密钥。

### 浏览器游戏声音

刷新 HUD 后点击右侧 **开启游戏声音**（浏览器要求用户手势），可随时静音或调整音量。声音来自 Minecraft 1.20.1 的服务器位置/实体声音事件，按机器人与声源距离衰减，使用原版音效及其权重、音调；不会播放伪造的背景循环。切换/刷新页面后需重新开启。

首次开启由应用从 `piston-meta.mojang.com` 下载官方资源索引/声音定义，音效按需从 `resources.download.minecraft.net` 下载，校验 SHA-1 后缓存至 `/app/data/saves/sound-cache`（宿主机 `data/saves/sound-cache/`）。浏览器只访问本地 HUD，不依赖 Cloudflare。官方资源版权归其权利人，不随源码/镜像打包；使用须遵守 Minecraft 相关条款。首次遇到某个音效时下载较慢，该次声音可能丢弃以免延迟播放，下次事件使用缓存。

范围限制：仅支持当前部署的 **Java 1.20.1**；原版客户端本地生成的脚步、挖掘反馈、部分水声/环境循环和音乐不一定由服务器发送，因此不会全部出现。未实现自定义服务器资源包、声源移动跟踪或立体声方位；距离按收到事件时计算。页面显示“等待服务器声音事件”不表示故障，只有真实事件到达才发声。下载失败可再次点击开启重试；浏览器须支持 Web Audio 的 Ogg/Vorbis 解码。

## 3. 停止、重启和持久化

```sh
docker compose stop                  # 优雅停止，保留容器与数据
docker compose start                 # 启动已有容器
docker compose restart mineblind     # 重启机器人
docker compose up -d --build         # 更新源码/配置后重建和重建容器
docker compose down                 # 删除容器/网络，保留根目录 data/
```

修改 `.env` 后用 `up -d` 重建容器；仅 `restart` 不会更新环境变量。默认 `unless-stopped` 在进程退出时重启；**unhealthy 状态本身不会触发 Docker 自动重启**。Docker Desktop 必须运行，Mac 也必须保持唤醒，不能把此配置视为无人值守服务保证。

所有应用持久化数据统一绑定到**项目根目录 `data/`**，不再创建命名卷：

| 宿主机目录 | 容器目录 | 内容 |
|---|---|---|
| `data/minecraft/` | `/data` | 世界、玩家数据、服务器配置、服务端文件和服务器日志 |
| `data/saves/` | `/app/data/saves` | AI 快照、JSONL 实验日志、`memory/` SQLite（含 WAL）、`checkpoints/` 和 `sound-cache/` |
| `data/knowledge/` | `/app/data/knowledge` | 持久攻略缓存 |
| `data/backups/` | 不挂载 | 停服备份和迁移校验清单 |
| `data/logs/`、`data/pids/` | 不挂载 | 原生 `mineblind.sh` 的日志和进程文件 |

`data/` 已被 Git 忽略，Docker 构建白名单也不会包含它。开发工具的 `.pi/`、依赖 `node_modules/` 和宿主机密钥 `.env` 不属于应用数据，保持原位置。Docker stdout/stderr 仍由 Docker 日志驱动管理（`docker compose logs`），不属于可恢复的应用存档。

机器人以非 root UID 1000 运行；Linux 上首次部署需确保目录可写，例如 `sudo chown -R 1000:1000 data/saves data/knowledge data/minecraft`。不要使用 `chmod 777`。Minecraft 世界/玩家背包与 AI 快照分别保存，恢复 AI 快照**不会回滚游戏世界**。

备份必须先停止机器人，再停止服务器：

```sh
docker compose stop mineblind
docker compose stop minecraft
mkdir -p data/backups
tar -czf "data/backups/state-$(date +%Y%m%d-%H%M%S).tar.gz" -C data minecraft saves knowledge
docker compose up -d
```

将备份另行复制到外部磁盘；同盘备份不能防磁盘损坏。恢复时停止服务，先备份当前目录，再将归档解压到空的 `data/minecraft`、`data/saves`、`data/knowledge`，不要与已有数据混合。保持世界身份、模式和游戏版本一致。只备份源码或 `.env` 不包含世界数据。Minecraft 默认关闭 RCON。

### 从旧命名卷迁移

**不能直接用空的绑定目录启动，否则会生成新世界。不要删除旧卷或运行 `down -v`。** 先检查实际容器的 Mounts（仅输出挂载信息，不输出环境变量），确认世界与存档源。停服后用 `docker cp 容器名:原目录/. 备份目录/` 完整导出 `/data`、`/app/saves`、`/app/knowledge`；从备份复制到上述三个新目录，逐文件比较 SHA-256，再切换 Compose。目标已存在时停止并人工确认，不能覆盖或合并。

旧 `latest.json` 的 `path` 是 `/app/saves/...` 绝对路径，需要把根目录和日期目录下的所有 `latest.json` 中此前缀去掉，变成相对于 saves 根目录的路径；新版本写出的指针已经可迁移。`sqlite_memory.json` 的检查点引用本来就是相对 saves 根目录的，必须连同 `checkpoints/` 一起复制。显式 `RESTORE_SAVE` 若指向旧绝对目录，也需要改成 `/app/data/saves/...`。不要改变 `WORLD_ID` 或实验模式。

保留旧卷和未经修改的备份直到确认两个服务健康、存档可恢复。回滚需停止服务，恢复旧 Compose 的命名卷映射及 `/app/saves`、`/app/knowledge` 环境路径；旧卷只包含迁移时的数据，不包含切换后的新进度。原生部署若有旧 `saves/`、`knowledge/`、`.logs/` 或 `/root/mc-server`，也应停服后按同样备份校验流程迁入 `data/`；不要复制活动 PID 文件。

## 4. 排查与验证边界

- Minecraft 反复退出：检查 EULA 是否由你明确接受、内存/磁盘是否充足、下载是否可达。
- 机器人未启动：检查 `docker compose ps`，Minecraft 必须先 healthy。
- HUD 无响应：检查机器人是否已连接并出生，3010/3011 是否被占用。
- OOM：查看 Docker Desktop 和 `docker stats`；增加虚拟机内存，或谨慎降低 Java 堆/视距。容器上限应高于 Java 堆，给 JVM 原生内存留余量。
- 更新基础镜像：`docker compose build --pull mineblind`、`docker compose pull minecraft`，再 `docker compose up -d`。基础镜像标签会变化，严格复现实验应记录镜像 digest。

已在 Linux AMD64 上验证构建、容器内 13 项离线测试、canvas 原生依赖、非 root 身份、镜像无 `.env` 和可写数据目录；无网络容器中连接拒绝后进程可正常退出（未验证出生后的断线恢复）。确认两个基础镜像均提供 ARM64 manifest。**尚未在 Mac Mini / ARM64 上实际构建运行，也未完成真实 Minecraft 服务端的连接、Viewer、游戏操作及重启恢复端到端验证。** 离线验证不代表已完成自主通关或模型在线兼容性测试。
