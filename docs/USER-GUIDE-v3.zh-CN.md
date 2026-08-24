# OpenCode Models Discovery 用户指南（v3 版·中文）

适用于 OpenCode 使用者。这份指南不需要你理解插件源码，覆盖安装、配置、工作机制、CLI 工具、安全边界与故障排查。

> 适用版本：1.5.0-rc.2（2026-08 构建，含 v3 discovery 引擎模块）
> 旧版指南仍适用于当前运行时行为：见 [USER-GUIDE.zh-CN.md](./USER-GUIDE.zh-CN.md)

---

## 目录

1. [这个插件解决什么问题](#1-这个插件解决什么问题)
2. [工作原理一图流](#2-工作原理一图流)
3. [安装](#3-安装)
4. [快速开始](#4-快速开始)
5. [provider 配置项全表](#5-provider-配置项全表)
6. [支持的 provider 场景](#6-支持的-provider-场景)
7. [思考强度（variants）与证据分层](#7-思考强度variants与证据分层)
8. [缓存、刷新与失效](#8-缓存刷新与失效)
9. [命令行工具](#9-命令行工具)
10. [安全与隐私](#10-安全与隐私)
11. [故障排查](#11-故障排查)
12. [当前版本的已知边界](#12-当前版本的已知边界)
13. [卸载与回滚](#13-卸载与回滚)

---

## 1. 这个插件解决什么问题

OpenCode 连接第三方中转（Relay）或私有网关时，对方通常只给一个 OpenAI 兼容接口，不会告诉你：

- 它到底暴露了哪些模型；
- 某个模型是否支持"思考强度（reasoning effort）"；
- 思考强度有哪几档、默认档是什么；
- 该用什么参数格式把思考强度发出去。

这个插件在 OpenCode 启动和运行期间自动完成三件事：

1. **发现**：用你配置的凭据请求 provider 的模型列表端点（默认 `/v1/models`），把返回的模型合并进当前会话的 provider 配置；
2. **识别**：将远端模型 ID 与内置官方 Registry 精确匹配（exact 匹配，绝不做模糊猜测）；
3. **编译思考档位**：为有可靠证据的模型生成 variants（如 `low/medium/high`），注入模型选择器。

它**不会**替 Relay 保证"参数真的被转发了"。转发是否生效是中转方的责任，插件在日志中始终把这一事实标注为 `relayForwarding=unverified`。

## 2. 工作原理一图流

```
OpenCode 启动
   │
   ├─ 插件加载（config hook）
   │     ├─ 解析每个 provider 的 modelsDiscovery 配置
   │     ├─ Zen / Go 官方 provider → 完全 no-op（宿主原生实现，零网络零改动）
   │     └─ 其余 provider → 进入发现流程
   │
   ├─ 发现流程（每 provider 独立）
   │     ├─ 读本地缓存（新鲜则直接用，不打网络）
   │     ├─ 缓存过期/缺失 → GET <baseURL>/v1/models
   │     │     ├─ HTTP 安全门：明文仅限本机回环、重定向约束、响应字节上限
   │     │     ├─ 200 + 模型列表 → 合并注入 + 写入缓存（LKG）
   │     │     ├─ 401（推理面）→ 记录 auth tombstone，撤销自动贡献
   │     │     ├─ 403/404/405（枚举面）→ 仅视为"不可枚举"，保留显式模型
   │     │     └─ 网络/超时 → 有旧缓存则继续用旧的（stale-allowed），无则显式模型兜底
   │     └─ 对每个发现的模型做 reasoning 识别与 variants 编译
   │
   └─ 你在模型选择器里看到带档位的模型
```

核心原则（贯穿所有版本）：

- **身份变化先撤销**：换 Key/换账号后，旧目录绝不自动带过来；
- **部分结果不删除**：一次不完整的列表绝不会删掉你之前能用的模型；
- **公共数据永不新增路由**：models.dev 等公共目录只能补充元数据，永远不能凭空造出模型；
- **未知就不编造**：没有证据的能力一律标 unknown，而不是猜一个值。

## 3. 安装

> 注意：npm 公共包名 `opencode-models-discovery` 已被原作者占用，本项目以 fork 形式维护，
> CLI/npx 用法保持原名，暂未发布公开 npm 包。当前请使用以下任一方式安装。

### 方式 A：从源码构建并打包（推荐自用）

```bash
git clone git@github.com:jc3212/opencode-models-discovery.git
cd opencode-models-discovery
bun install
npm pack          # 生成 jc3212-opencode-models-discovery-<version>.tgz
```

### 方式 B：安装到固定目录供 opencode.json 引用

```bash
mkdir -p ~/.local/share/omd-plugin && cd ~/.local/share/omd-plugin
npm init -y
npm install /path/to/jc3212-opencode-models-discovery-1.5.0-rc.2.tgz
```

然后在全局 `~/.config/opencode/opencode.json` 中挂载：

```json
{
  "plugin": [
    "~/.local/share/omd-plugin/node_modules/opencode-models-discovery"
  ]
}
```

> plugin 路径可以是相对路径（相对配置文件）、绝对路径或 npm 包名。

### 验证安装

```bash
opencode models dieqiyun --print-logs --log-level INFO | head
```

看到 `Model discovery plugin initialized` 即加载成功；随后会输出每个 provider 的
`[reasoning-summary]` 行。

### 升级注意

`npm install` 对**同版本号**的本地 tarball 可能不替换文件。升级时先删除再装：

```bash
rm -rf node_modules/opencode-models-discovery
npm install <新 tarball 路径>
```

## 4. 快速开始

最小可用配置——只要 provider 本身配置正确，无需任何 modelsDiscovery 字段即可工作：

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["~/.local/share/omd-plugin/node_modules/opencode-models-discovery"],
  "provider": {
    "my-relay": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://your-relay.example.com/v1", "apiKey": "{env:MY_KEY}" }
    }
  }
}
```

启动 OpenCode 后插件自动发现该 Relay 的全部模型并注入。

## 5. provider 配置项全表

全部配置都在 `provider.<ID>.options.modelsDiscovery` 下，均可省略：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭后该 provider 完全跳过发现 |
| `endpoint` | string | `/v1/models` | 模型列表端点路径 |
| `timeoutMs` | number | 3000 | 单次请求超时（毫秒） |
| `filterNonChat` | boolean | — | 过滤疑似非对话模型 |
| `smartModelName` | boolean | — | 用更友好的显示名 |
| `modelInfoEndpoint` | string | — | 补充元数据的端点（如 vLLM） |
| `modelInfoFormat` | string | — | `vllm` 时读取 `max_model_len` 映射 context/output 上限 |
| `models.includeRegex` | string[] | — | 模型 ID 白名单正则（满足其一即保留） |
| `models.excludeRegex` | string[] | — | 模型 ID 排除正则 |
| `models.includeBy` | Filter[] | — | 按原始字段过滤（`{field, equals}` 或 `{field, match}`） |
| `models.excludeBy` | Filter[] | — | 同上，命中即排除 |
| `cache.enabled` | boolean | `true` | 是否把发现结果缓存到本地 XDG 数据目录 |
| `cache.ttlSeconds` | number | 内置值 | 缓存新鲜期 |
| `reasoning.enabled` | boolean | `true` | 是否生成思考档位 |
| `reasoning.transport` | string | auto | 显式指定 transport（离线场景） |
| `reasoning.aliases` | object | — | 用户别名：`{"我的名字": "官方模型ID"}`，仅作识别提示，**不赠送能力** |
| `reasoning.capabilityPolicy` | string | `strict` | `official-model` 放宽为官方 Registry 命中即可用 effort |
| `reasoning.relay` | string | `auto` | Relay 网关类型：`new-api`/`sub2api`/`none` |

### 全局开关

```jsonc
{ "plugin": [["opencode-models-discovery", { "discovery": { "enabled": false } }]] }
```

## 6. 支持的 provider 场景

| 场景 | 行为 |
|---|---|
| 普通 OpenAI 兼容中转（NewAPI/Sub2API 等） | ✅ 完整支持：同 Key 请求 `/v1/models`，返回集即"该 Key 实际可见列表" |
| OpenRouter | ✅ 官方 origin 白名单；`/api/v1/key` 能力探测 + `/models/user` 用户级分页；绝不回退全局 `/models` |
| DeepSeek 直连 | ✅ 官方 origin 白名单（`api.deepseek.com`）；思考模式映射按官方文档冻结：输入 `low/medium/high/xhigh/max` → 有效档 `low/high/max`；关闭思考 Chat 发 `thinking.type=disabled`、Responses 发 `reasoning.effort=none` |
| 阿里百炼（北京权限链路） | ⚠️ 保守实现：以授权集界定可见性，deployments RUNNING 才 ready；未经 live 差分验证的语义一律不标 stable |
| 火山方舟 | ⚠️ ARK key 与控制面凭据严格分离；key-only 模式零控制面网络 |
| Coding Plan 类订阅（百炼/方舟） | ⚠️ non-enumerable：不枚举、零网络，只接受显式配置 |
| OpenCode Zen / Go | 🚫 完全 no-op：宿主已原生实现，插件不请求、不注入、不改任何字段 |

## 7. 思考强度（variants）与证据分层

插件对"一个模型能不能加思考档位"采用**证据分级**，从不拍脑袋：

```
厂商 exact API/SDK/文档  >  带官方来源的人工审核 Registry  >  公共目录 shadow 候选（永不自动激活）  >  unknown
```

- **exact（精确）**：当前 provider 自己的接口/文档证明。最高优先级。
- **high**：人工审核过的 curated registry 条目（每条必须带官方 URL 和 revision）。
- **medium**：兼容推定。典型场景：OpenAI 兼容中转上的模型精确命中官方 Registry 的 effort 档位时，
  以 medium 置信度生成 `openai-compatible-effort` transport，并在日志标注
  `transportConfidence=medium, relayForwarding=unverified`。
- **low / shadow**：公共元数据（models.dev）。只能作为候选存在，**永远不会自动激活**新档位，
  也永远不会新增模型路由。

关键保证：

- 模型身份只做 exact 三元组匹配 `(provider, surface, remoteModelId)`；
  全局唯一裸名、去前缀、去日期后缀都只是诊断候选，不解锁任何能力；
- `budget_tokens`（预算制）生成的 profile 会明确标记 derived，绝不冒充名为 `max` 的离散档位；
- 同名模型在不同 provider/surface 上互不复用 wire 参数（DeepSeek 直连的映射不会被搬到 OpenRouter 上）。

## 8. 缓存、刷新与失效

- **位置**：XDG 数据目录下 `<data>/@jc3212/opencode-models-discovery/`
  （Linux 通常为 `~/.local/share/@jc3212/opencode-models-discovery/`）。
- **结构**：
  - `inventories/v3/<identityHash>.json` —— 每个"语义身份"一份完整模型列表（LKG，最近已知良好）；
  - `tombstones/v1/…` —— 确认鉴权失败后按 (身份×凭据代次) 精确记录的墓碑；
  - `metadata/v1/*.json` —— 公共元数据 verified revision 快照；
  - `installation.key` —— 本机 HMAC 密钥（0600，独占创建）。
- **刷新节奏**：新鲜期（soft TTL）内不打网络；过期后在宽限窗内后台刷新；硬过期（hard stale）
  后 strict 模式撤销陈旧目录。刷新带提前 jitter 和指数退避，尊重服务端 Retry-After。
- **失效规则**：
  - 换 Key → 凭据代次变化，旧 LKG 不跨代复用，旧 tombstone 不影响新 Key；
  - 注销/凭据丢失 → fail-closed，回到 explicit-only；
  - 确认 401（推理面）→ 撤销自动贡献并阻断 LKG 复活；枚举面 403/404/405 只移除自动贡献、保留你的显式模型。

手动清理缓存：

```bash
rm -rf ~/.local/share/@jc3212/opencode-models-discovery/inventories
```

## 9. 命令行工具

```bash
npx opencode-models-discovery          # Reasoning Audit（当前已接线的入口）
```

Audit 输出逐 provider 的模型数、身份解析结果、transport 解析、variants 统计，
并复用运行时同一套 resolver（不存在第二套判断路径）。

> v3 新增的 `status` / `audit --provider X --model Y [--json]` / `refresh [--metadata]`
> 命令层已实现（位于包内 `src/cli/discovery-commands.ts`），提供本地缓存概览、
> 逐条 evidence 展示与缓存预热；截至本文档所述版本尚未接入 npx 入口，
> 请以仓库 README 的更新为准。

## 10. 安全与隐私

- **凭据不出境**：provider API Key 只发给你配置的 baseURL；公共元数据服务（models.dev）
  的请求永远不带任何 Key；
- **明文限制**：HTTP 明文请求仅允许本机回环地址；重定向有环路/降级/授权同源约束；响应有字节上限；
- **日志脱敏**：任何日志不输出凭据指纹、完整 identity hash 或账户余额类字段；
- **fail-closed 存储**：缓存文件 0600/0700，拒绝符号链接，路径强制 containment，
  文件名只用受限哈希编码；
- **原型污染防护**：外部 JSON 中出现 `__proto__`/`constructor` 键直接整体拒收；
- **坏更新不落盘**：公共元数据候选若出现空目录、异常批量删除、无中生有的能力扩张，
  进入隔离区而不会覆盖已激活快照。

## 11. 故障排查

### 模型没出现？

1. `opencode models <provider> --print-logs --log-level INFO` 看 summary 行是否存在；
2. 出现 `Provider model discovery failed` → 检查 baseURL 连通性/Key（本指南实测中
   `text168.com` 两家即为此类网络级失败，属正常 fail-open）；
3. 被 include/exclude 规则过滤 → 核对 `models.*` 正则；
4. 缓存了空结果 → 清理 inventories 目录后重启。

### 模型出现但没有思考档位？

1. 看 `[reasoning]` 行的 `capabilitySource`：
   - `none` → 官方 Registry 无此模型，考虑用 `reasoning.aliases` 显式映射到官方 ID；
   - `official-registry` 但 `control=null` → 官方确认该模型无 effort 控制；
2. `transport=unknown` → 该 host 无法证明 wire 语义，属保守边界；
3. `capabilityUnknown` → 无证据即无档位，这是设计而非故障。

### 为什么 Relay 接受了参数却显示 UNVERIFIED？

插件只能证明"参数按官方 wire 语义发出"，无法证明中转方转发给了上游。
这是刻意的事实边界：官方 Registry 永远不会因为中转放行而被升级。

### 换 Key 后旧模型还在/不在？

- 换 Key 属于新凭据代次：旧 LKG 不跨代复用，需要重新发现一次（通常秒级）；
- 若新 Key 权限更小，旧模型会在下一次完整刷新时被正确移除（complete shrink 生效）；
- 若怀疑 tombstone 卡住，清理对应缓存目录即可。

## 12. 当前版本的已知边界

1. **v3 引擎模块与主运行时的接线**：v3 重构引入的 entrypoints（Promise/Effect）、
   capability catalog、metadata store 等模块已完成并通过 789 项自动化测试，
   但当前实际接入 OpenCode 的主路径仍是经过长期验证的 legacy 运行时。
   两套代码共存于同一包内，行为以 legacy 路径为准。
2. **Relay forwarding 永远 UNVERIFIED**：除非你亲自做付费 smoke，任何工具声明都无法改变此状态。
3. **Gate 0 未实测供应商**：百炼/方舟等 adapter 的语义按最保守方式实现并显式标注，
   在拿到 live 凭据差分 fixture 之前不会标记 stable。
4. **CLI status/audit/refresh 尚未接入 npx 入口**（见第 9 节）。
5. **Windows**：主要在 Linux 开发验证；macOS 应可用；Windows 未系统测试。

## 13. 卸载与回滚

```jsonc
// 方式一：仅禁用发现（保留插件）
{ "plugin": [["opencode-models-discovery", { "discovery": { "enabled": false } }]] }

// 方式二：完全移除
// 从 opencode.json 的 plugin 数组删掉对应条目，然后：
rm -rf <插件安装目录>
rm -rf ~/.local/share/@jc3212/opencode-models-discovery   # 可选：清缓存
```

插件从未修改过你的 provider 基础配置（baseURL/npm/apiKey 等）；卸载后重启 OpenCode 即恢复原状。
被注入的模型来自插件的内存 Map，进程结束即消失，不写入磁盘配置。

---

*本文档基于 2026-08-24 的源码与实测（opencode 1.18.21 + 插件 1.5.0-rc.2）编写；
与源码冲突时以源码为准。*
