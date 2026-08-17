# OpenCode Models Discovery — 完整技术报告

> 版本：1.5.0-rc.1 ｜ 报告日期：2026-08-17 ｜ Registry：rea758d2465（39 models）
> 本文档整合项目背景、技术方案、技术路线、技术细节、问题与解决、验证结论，供交付与后续维护使用。

---

## 1. 项目背景

### 1.1 问题定义

用户通过第三方匿名 Relay（中转）使用多种模型（OpenAI GPT / Anthropic Claude / Google Gemini / Grok / DeepSeek / GLM / Qwen / Kimi）。Relay 只暴露 OpenAI 兼容的 `/v1/models` 接口，存在三个痛点：

1. **模型发现**：Relay 返回的模型列表不能自动进入 OpenCode，用户每次要手动维护。
2. **思考档位（reasoning effort）**：主流模型支持思考强度（none/low/medium/high/xhigh 等），但 Relay 不声明这些能力，OpenCode 不知道给哪些模型、发哪些档位。
3. **可信度**：第三方 Relay 对 reasoning 参数的转发是否真实生效无法直接信任，需要把「模型官方能力」与「Relay 转发能力」两个事实分开，避免把 Relay 的不可验证行为误当成模型官方规格写入全局配置。

### 1.2 设计约束（来自方案 §1-§23）

- 不 fuzzy 匹配模型 ID；只接受官方数据源的精确映射（Registry）。
- 模型 Identity、官方能力、Relay 转发是**三层独立事实**，不得混用。
- Registry 是**官方能力**的唯一来源；Relay 行为只影响 Transport 解析，不修改 Registry。
- 默认 conservative（strict），用户显式开启官方档位注入（official-model）。
- Registry 与核心代码分离，Registry 更新是独立轨道，不阻塞核心发布。

---

## 2. 技术方案

### 2.1 总体架构

```
┌──────────────────────────────────────────────────────────┐
│                        OpenCode                          │
│                                                          │
│   plugin: opencode-models-discovery (1.5.0-rc.1)        │
│   │                                                      │
│   ├─ config hook ── enhanceConfig()                     │
│   │     ├─ /v1/models discovery (per provider)          │
│   │     ├─ identity resolver（严格，registry alias）      │
│   │     ├─ official registry lookup（bundled）            │
│   │     ├─ transport resolver（relay-aware shadow）       │
│   │     └─ variants 注入（modelConfig.reasoningEffort）   │
│   │                                                      │
│   └─ event hook ── 会话态诊断 / 通知                      │
│                                                          │
│   admin CLI: dist/cli.js (Node-only, 无 bun 依赖)        │
│     └─ audit --verbose：三层事实 + 覆盖率报告              │
└──────────────────────────────────────────────────────────┘
         │ reads
┌────────▼─────────────────────────────────────────────────┐
│  ~/.config/opencode/opencode.json  (provider 配置)       │
│  ~/.local/share/opencode/auth.json  (凭据来源)           │
└──────────────────────────────────────────────────────────┘
         │ bundled
┌────────▼─────────────────────────────────────────────────┐
│  Official Model Reasoning Registry                       │
│  src/generated/reasoning-registry.json（39 models）       │
└──────────────────────────────────────────────────────────┘
```

### 2.2 关键模块

| 模块 | 路径 | 职责 |
|---|---|---|
| 插件入口 | `src/index.ts` → `src/plugin/index.ts` | OpenCode Plugin 生命周期 |
| 配置增强 | `src/plugin/enhance-config.ts` | discovery + enrichment 主流程 |
| 身份解析 | `src/reasoning/canonical-model.ts` | 严格 identity 匹配（无 fuzzy） |
| 官方能力 | `src/reasoning/registry/{types,resolver,validator,loader}.ts` | Registry 查询/校验 |
| 传输层 | `src/reasoning/transport.ts` | transport 解析（含 relay shadow） |
| Relay 影子 | `src/reasoning/relay/shadow.ts` | relay-aware transport 决策 |
| 报告 | `src/reasoning/coverage.ts`、`src/reasoning/diagnostics.ts` | audit 统计 |
| CLI | `src/cli.ts` → `dist/cli.js` | node-only 诊断命令 |
| 编译 | `scripts/registry-tools/compile-registry.ts` | registry/*.json → bundled JSON |

### 2.3 三层事实模型（设计 §22）

| 层 | 含义 | 来源 | 示例 |
|---|---|---|---|
| L1 Model Identity | 模型是什么 | Relay /models + 用户 alias | `gpt-5.4` → `openai/gpt-5.4` |
| L2 Official Capability | 官方支持哪些档位 | bundled Registry（独立于 Relay） | effort [none..xhigh] |
| L3 Relay Forwarding | Relay 是否真正转发 | 不可直接验证 → 默认 UNVERIFIED | 需 smoke test |

> 关键结论：**L2 取决于 Registry（可验证、可更新），L3 取决于 Relay（不可由 Registry 保证）**。项目因此把两者完全分离。

---

## 3. 技术路线

### 3.1 分阶段交付

| 阶段 | 内容 | 结果 |
|---|---|---|
| P1 设计与 Schema | 三层事实、Registry schema、alias 语义 | 方案文档 + 类型定义 |
| P2 核心解析 | identity / registry / transport 解析器 | 单元测试通过 |
| P3 插件与 CLI | OpenCode hook + audit CLI | 集成验证 |
| P4 真实 Relay Smoke | 3 relay × 7 模型最小推理 | 6 accepted / 0 rejected |
| P5 RC 审计基线 | 完整统计（identity/capability/transport） | RC-REAL-AUDIT.txt |
| P6 Registry 补全 | A 类官方缺项补入（gemini-high/low、gpt-xhigh、grok） | 33→39 models |
| P7 发布准备 | SemVer、bun-less、package 验证、RC tag | 1.5.0-rc.1 |

### 3.2 发布判定（§38-§41）

- 核心代码冻结：仅 P0/P1 修。
- Registry 独立轨道：允许持续增补官方模型，不阻塞核心。
- 观察期：RC 稳定后发布 Stable 1.5.0，进入三轨维护。

---

## 4. 具体技术细节

### 4.1 Registry Schema（§4-§9）

每条官方能力为**单个精确模型**（无 family/glob 通配，设计 §14）：

```json
{
  "model": "openai/gpt-5.4",
  "aliases": ["gpt-5.4"],
  "reasoning": true,
  "controls": [
    {
      "type": "effort",
      "values": ["none","low","medium","high","xhigh"],
      "default": "medium",
      "aliases": { "medium": "high", "xhigh": "max" }
    }
  ],
  "sources": [{ "type": "official-doc", "vendor": "openai" }],
  "updatedAt": "2026-08-16",
  "schemaVersion": 1
}
```

- **有效值 vs 接受值分离**：API 可能接受 medium/xhigh，但有效集合并，只在 aliases 记录等价关系（§7）。
- **Control 三种类型**：`effort`（档位）、`toggle`（Kimi 系列开关）、`budget_tokens`（token 预算）。
- **证据字段**：每条必须有 `sources`，来源类型 official-doc / models.dev / sdk-source（§8）。

### 4.2 Registry 编译与版本（§33-§39）

- 源文件 `registry/<vendor>/*.json`；编译器白名单 `VENDOR_DIRS` 包含 openai/anthropic/google/deepseek/zai/xai/alibaba/moonshot。
- `registryVersion` 由内容哈希生成（sha256 前 10 位，前缀 `r`）：**内容变化即版本变化** → 缓存失效判定依据。
- 编译产物带 GENERATED 头，禁止手改。

### 4.3 Transport 解析（§16-§18，relay shadow）

```
resolveRelayAware():
  provider npm / baseURL 命中已知 profile  →  openai / anthropic / gemini（reason: known-provider-profile）
  host 无法判定 API surface              →  unknown（reason: openai-compatible-host-api-surface-unresolved）
  用户显式 transport                      →  强制采用（openai-compatible-effort / openai-responses / anthropic 等）
```

- transport 未知时**保守不注入 variants**（即使 L2 命中），避免对未知 API surface 猜传输方式。
- 已 wire 验证的传输矩阵：OpenAI Responses、OpenAI-compatible、OpenRouter、Anthropic、Gemini、DashScope、Alibaba SDK。

### 4.4 注入条件（enrichment 门控）

一个模型最终获得 variants 需要同时满足：

1. discovery 拿到模型（/v1/models 可达）。
2. identity 精确命中（registry alias 或 user alias；无 fuzzy）。
3. L2 命中 Registry（capabilitySource = official-registry）。
4. transport 已解析（非 unknown）。

```
providerDiscoveryConfig.reasoning?.enabled !== false   // 用户开关（默认开）
  ∧ applyReasoningEnrichment(...)                       // 上述 1-4
```

> 注意默认 `capabilityPolicy` 是 `strict`（保守，不注入官方档位）；只有显式 `official-model` 才注入官方 variants（§22）。

### 4.5 CLI（Node-only）

- `src/cli.ts` 编译为 `dist/cli.js`，不依赖系统 bun。
- 读取 `~/.config/opencode/opencode.json` + `~/.local/share/opencode/auth.json`（provider 内联 apiKey 优先）。
- 只读、不写 Registry、不打印凭据；v 版本含 `--verbose` 逐模型诊断与覆盖率统计。

### 4.6 配置形态（安装后）

```jsonc
"provider": {
  "2chat": {
    "npm": "@ai-sdk/openai",
    "options": {
      "baseURL": "https://…",
      "modelsDiscovery": {
        "enabled": true,
        "reasoning": {
          "enabled": true,
          "capabilityPolicy": "official-model",
          "transport": "auto"
        }
      }
    }
  }
}
```

---

## 5. 遇到的问题与解决方案

### 5.1 [P0] SemVer 无效（1.4.0-rc.1 < 已发布 1.4.0）
- 问题：npm 已有正式 1.4.0，再发 1.4.0-rc.1 会被 npm 拒绝（版本序 < 已发布版本）。
- 解决：bump 到 **1.5.0-rc.1**（向前兼容合法预发布）。

### 5.2 [P0] CLI 依赖系统 bun
- 问题：audit CLI 用 bun 运行，用户环境可能无 bun。
- 解决：编译为 `dist/cli.js`（Node-only），bun-less 测试通过，`npx-style bin` 直接用 node 跑。

### 5.3 [P1] Registry 编译器漏 vendor（xai）
- 问题：`VENDOR_DIRS` 白名单缺 `xai`，grok-3/grok-4 条目在编译时**静默丢弃**（33+4=37 而非 39）。
- 定位：deterministic-build 测试只查「两次编译哈希一致」和「registryVersion 存在」，未查「每个 vendor 目录都进入产物」。
- 解决：
  1. VENDOR_DIRS 补 `xai`；
  2. 新增回归测试：**每个源 vendor 目录都必须出现在编译产物中**；
  3. 重建 dist，打包 E2E 复验 grok-4 → low/medium/high variants。
- 意义：这是「Registry 缺失导致错误无档位」的 release 级缺陷，被 RC 观察环节捕获——正是分阶段发布的收益。

### 5.4 [P2] 未知 host 的 transport 解析
- 现象：openchat（api.openclawplan.com）、dieqiyun（hgapi.dieqiyun.top）、k3-free 的模型 transport=unknown，variants=[]。
- 定性：**不是 Registry 缺失**（capabilitySource 均为 official-registry），是 host 不在已知 profile → 保守不注入（预期行为，§11/§23）。
- 处置：保持 `transport: auto` 不动；若用户确认某 relay 走 openai-compatible 传输，再按 provider 显式指定（不全局改）。

### 5.5 [P3] npm 未发布与沙箱写入限制
- 问题：1.5.0-rc.1 未发布 npm；沙箱仅允许 workspace 写入，`~/.config/opencode` 需提权。
- 解决：本地真实 tarball 安装到 `omd-plugin-install/node_modules`；配置修改一次完成（先备份 → 程序化 merge → JSON 校验 → 安全 diff 确认 0 密钥变更），以 full-access 提权写入。

### 5.6 国内模型（Qwen/DeepSeek/GLM/Kimi）为何暂时无档位
- 事实：Registry **已含 8 个国内模型条目**（deepseek-v4-pro/flash、glm-5.1/5.2、qwen3-max/235b-a22b、kimi-k3/k2.6 toggle）。
- 原因：① 当前 relay 未暴露标准 ID（需 user alias，项目不猜）；② 一旦出现在 transport=unknown 的 relay（openchat 等）即便命中也不注入。
- 解决路径（用户后续决定）：补 user alias / 对具体 relay 显式 transport。

---

## 6. 验证过的内容

### 6.1 单元 / 集成（发布门禁）

| 项 | 结果 |
|---|---|
| 测试 | 369 passed（48 files，含新增 vendor 完整性回归） |
| typecheck | PASS |
| lint | PASS |
| Registry 编译确定性 | 两次编译哈希一致；无 drift |
| 打包完整性 | 64 files，tarball 内 registry 39 models |
| 干净安装 | 新环境 tarball 安装 + registry 加载 OK |
| bun-less CLI | 移除 bun 后 node dist/cli.js audit OK，0 凭据泄漏 |

### 6.2 真实 Relay Smoke（付费最小请求，显式启用）

- 3 relay：2chat / tokenshop / openchat；7 模型（gpt-5.4、gpt-5.5、claude-opus-4-6、gemini-3.1-pro-preview 等）。
- 结果：**6 ACCEPTED-UNVERIFIED / 0 REJECTED / 1 UNREACHABLE**（ans-heidong 503 瞬时）。
- 归类原则：2xx 仅是「Relay 接受请求」，不升级为 VERIFIED（L3 仍 UNVERIFIED）。

### 6.3 真实 OpenCode 启动验证（本机 1.18.18）

- 插件初始化：日志 `Model discovery plugin initialized` ✅
- 自动 discovery：9 relay 全部调用 /v1/models ✅
- variants 注入（`opencode models` 实测）：

| provider | 模型 | variants |
|---|---|---|
| heidong | gpt-5.4 | none/low/medium/high/xhigh ✅ |
| 2chat | gpt-5.5 | none/low/medium/high/xhigh ✅ |
| ans-heidong | claude-opus-4-6 | none/low/medium/high/max ✅ |
| ans-tokenshop | 6 模型 | 全部 variantEnabled ✅ |
| dieqiyun / k3-free / openchat | 部分模型 | transport=unknown → 保守无 variants（预期） |

### 6.4 RC Audit 基线（2026-08-17）

```
Providers configured: 11   ·  reachable: 8
Models discovered: 75
Identity resolved: 61（registry alias 61；canonical exact 0；user alias 0）
Registry missing: 9        ·  alias required: 5
Capability resolved: 61    ·  not reasoning: 14
Transport resolved: 75     ·  transport unknown: 0
```

---

## 7. 发布状态与结论

- **版本**：1.5.0-rc.1（tag `v1.5.0-rc.1`，HEAD 2844358，git clean）。
- **Tarball**：`opencode-models-discovery-1.5.0-rc.1.tgz`，SHA-256 `eefa8e743240da6c539c29082ee560169f4f28f7bba67cc628823caa5d643372`。
- **Recommendation**: **READY FOR RC**（发布命令 `npm publish --tag next`，需 npm 认证，当前环境不可用）。
- **日常使用**：仅需 `opencode`，discovery + Registry enrichment 自动完成；`audit` 仅作诊断。

---

## 8. 后续维护（三轨）

| 轨道 | 内容 | 节奏 |
|---|---|---|
| Core | 解析/注入主逻辑 | 低频率，P0/P1 才动 |
| Registry | 官方模型增补（official-doc/models.dev 证据） | 高频独立发布 |
| Transport | 新 API surface wire 验证 | 按需 |

> Registry 新增模型走：`registry/<vendor>/<model>.json`（带证据）→ compile → registryVersion 变化 → 发布（无需核心发版）。
