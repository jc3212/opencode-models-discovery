# OpenCode Models Discovery 用户指南（中文）

适用于 OpenCode 普通使用者。这份指南不要求你理解插件源码，只说明如何安装、配置、使用和排障。

> 当前版本：1.5.0-rc.2

---

## 1. 这个插件解决什么问题

OpenCode 连接第三方中转（Relay）时，Relay 通常只给你一个兼容 OpenAI 的接口，不会告诉你：

- 它到底暴露了哪些模型；
- 某个模型是否支持"思考强度"；
- 思考强度有哪几档；
- 该怎么把思考强度发出去。

这个插件做三件事：

1. 自动向 Relay 请求模型列表；
2. 把 Relay 返回的模型名识别为规范模型（如果证据足够）；
3. 为有可靠证据的模型生成"思考强度"选项（variants）。

它不会替 Relay 保证"参数真的被转发了"，这是中转方的责任，插件无法替你验证。

---

## 2. 支持什么

- 自动发现模型（`/v1/models`）
- 官方能力 Registry + models.dev 证据合并后的能力判断
- 三种思考控制：
  - `effort`：档位式，例如 `none / low / medium / high / xhigh`
  - `toggle`：开关式，例如"思考开/关"
  - `budget_tokens`：token 预算式思考
- 审计命令 `audit` 与 `audit --verbose`
- 离线运行：插件不会在运行时去 models.dev 或厂商文档爬数据

## 3. 不保证什么

- 不保证 Relay 真的转发 reasoning 参数（L3 客观限制）
- 不保证每个模型都有思考档位
- 不保证 Relay 的非标准模型名都能被识别
- 不做模糊猜模型（宁可 unknown，不猜错）

---

## 4. 安装

本机安装方式（以最终 tarball 为例）：

```bash
# 1) 准备一个安装目录
mkdir -p ~/.opencode-plugins

# 2) 安装 tarball
cd ~/.opencode-plugins
npm init -y >/dev/null 2>&1
npm install /path/to/opencode-models-discovery-1.5.0-rc.2.tgz

# 3) 在 OpenCode 配置中注册插件（见下一节）
```

检查安装是否成功：

```bash
node -e "console.log(require('$HOME/.opencode-plugins/node_modules/opencode-models-discovery/package.json').version)"
```

应输出 `1.5.0-rc.2`。

## 5. 快速开始（5 分钟）

1. 在 OpenCode 配置里添加插件引用：

```jsonc
{
  "plugin": [
    "/home/你的用户/.opencode-plugins/node_modules/opencode-models-discovery"
  ]
}
```

2. 为一个 Relay 启用模型发现：

```jsonc
{
  "provider": {
    "my-relay": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://example-relay.invalid/v1",
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
}
```

3. 启动 OpenCode：

```bash
opencode
```

4. 查看模型与思考档位：

```bash
opencode models
```

发现模型、识别模型、注入思考档位都会自动完成。不需要先手动运行 audit。

---

## 6. OpenCode 配置

OpenCode 的配置位于：

- 全局：`~/.config/opencode/opencode.json`
- 项目：项目根目录的 `opencode.json`

修改前请备份：

```bash
cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.backup-$(date +%Y%m%d-%H%M%S)
```

## 7. modelsDiscovery 配置项

| 字段 | 含义 | 建议 |
|---|---|---|
| `enabled` | 是否允许动态发现模型 | `true` |
| `reasoning.enabled` | 是否运行 reasoning 增强流水线 | `true` |
| `reasoning.capabilityPolicy` | 信任哪些能力来源 | `official-model` 或 `strict` |
| `reasoning.transport` | 用什么协议发送参数 | `auto`（推荐） |

当前支持的能力策略（来自真实 schema）：

- `strict`：最保守。不使用官方 Registry 自动推导，只依赖 Relay 明确提供的能力。
- `official-model`：官方 Registry 证据命中后，可以自动注入官方档位。

> 注意：本项目没有 `evidence-aware` 或 `permissive` 策略，请不要写入这些不存在的值。

## 8. Reasoning / 思考强度

`reasoning.enabled = true` 表示**启用 reasoning enrichment 流水线**，但不代表每个模型都有思考档位。

一个模型要有档位，必须同时满足：

1. 身份被识别（identity resolved）
2. 能力有证据（capability known）
3. 传输方式可确定（compile transport known）

只要其中一环不满足，就会保守地不注入档位。

### 三类控制

- **effort**：档位，例如 `none/low/medium/high/xhigh`
- **toggle**：开关，例如"思考开/关"
- **budget_tokens**：token 预算

不同模型能力不同。不要假设所有模型都有 `low/medium/high`。

### acceptedValues 与 effectiveValues

"API 能接受某个值"不等于"它是一个独立的思考强度"。

例如 `minimal`：

- 如果只有中转方接受它的证据，没有明确独立语义
- 插件不会把它自动当成一个独立档位展示

这是刻意保守的行为：未知比错误展示更好。

## 9. 模型名称识别

Relay 返回的模型名 `≠` 官方规范名。例如：

- Relay：`glm-5.2`
- 官方：`zai/glm-5.2`

插件会按顺序尝试：

1. 用户显式 alias
2. 官方精确名
3. Registry 精确 alias
4. models.dev 证据 alias
5. 已知 vendor anchor
6. 安全规范化（仅当证据唯一且明确）
7. 仍然无法识别 → `unresolved`

插件不做 Levenshtein 模糊匹配，也不因为名字像就猜。

## 10. 用户 Alias

如果 Relay 使用自定义名，并且你明确知道它对应哪个官方模型，可以配置 alias：

```jsonc
{
  "provider": {
    "my-relay": {
      "options": {
        "modelsDiscovery": {
          "reasoning": {
            "aliases": {
              "my-custom-gpt": "openai/gpt-5.5"
            }
          }
        }
      }
    }
  }
}
```

请仅在你有明确证据时配置。不要乱猜。

## 11. Transport

默认 `transport: "auto"`。

- `auto`：由插件根据 provider SDK / baseURL 判断传输协议。
- 只有当 `audit` 显示某个 provider `compile transport unknown`，并且你有可靠证据确认该 Relay API surface 时，才手动指定。
- 不要因为 baseURL 看起来像 OpenAI 就强行指定 `openai-compatible-effort`。

## 12. Audit

Audit 是诊断命令，不是每次使用前都要运行。

```bash
npx opencode-models-discovery audit
npx opencode-models-discovery audit --verbose
```

如果使用本机 tarball 安装：

```bash
node ~/.opencode-plugins/node_modules/opencode-models-discovery/dist/cli.js audit --verbose
```

Audit 只读，不会发送付费推理请求。

## 13. 常见状态解释

| 状态 | 含义 |
|---|---|
| Identity resolved | 插件确认模型是谁 |
| Identity unresolved | 插件无法安全确认模型是谁 |
| Capability known | 模型身份已知，能力有证据 |
| Capability unknown | 模型身份已知，但能力数据不足 |
| Compile transport known | 知道怎么把参数发出去 |
| Compile transport unknown | 能力已知，但无法安全生成 wire 配置 |
| No variants | 可能原因见 Troubleshooting |

## 14. 常见问题

### 模型没出现？

检查 `modelsDiscovery.enabled` 是否为 `true`，以及 Relay 是否可达。

### 模型出现但没有思考档位？

运行 `audit --verbose`，看是：

- identity unresolved
- capability unknown
- compile transport unknown
- adapter 不支持该 control

### 为什么 Relay 接受了请求却仍显示 UNVERIFIED？

收到 2xx 只表示 Relay 接受了请求，不代表它真的把 reasoning 参数转发了。这是 L3 的客观限制。

## 15. Troubleshooting 决策树

```text
模型没出现？
  └─ 检查 discovery

模型出现但没有 variants？
  └─ audit identity

identity known？
  └─ capability

capability known？
  └─ compile transport

transport known？
  └─ policy / adapter

仍有问题？
  └─ audit --verbose
```

## 16. 安全与隐私

插件：

- 不会打印你的 API Key / Token / Authorization
- 不会在运行时请求 models.dev
- 不会在运行时抓取厂商文档
- 运行时的外部请求只有你配置的 Relay discovery 请求和 OpenCode 正常请求

## 17. 升级

用新 tarball 重新安装：

```bash
cd ~/.opencode-plugins
npm install /path/to/opencode-models-discovery-<新版本>.tgz
```

重启 OpenCode 即可。

## 18. 回滚

### 配置回滚

```bash
# 停止 OpenCode
# 恢复备份
cp ~/.config/opencode/opencode.json.backup-YYYYMMDD-HHMMSS ~/.config/opencode/opencode.json
# 重新启动
opencode
```

### 插件回滚

- 重新安装旧版本 tarball
- 或在配置中移除插件引用

## 19. 卸载

1. 从 OpenCode 配置移除插件引用
2. 如需保留模型发现配置，可以保留 `modelsDiscovery` 字段（OpenCode 会忽略未知插件配置）
3. 删除插件安装目录：
   ```bash
   rm -rf ~/.opencode-plugins/node_modules/opencode-models-discovery
   ```
4. 如无需要，恢复配置备份

卸载不会删除你的 provider、auth 或手写模型配置。

## 20. 高级配置

### 只使用保守策略

```jsonc
"reasoning": {
  "enabled": true,
  "capabilityPolicy": "strict",
  "transport": "auto"
}
```

### 数据来源说明

能力数据来源包括：

- 官方 evidence（厂商文档/SDK）
- models.dev（社区维护的大覆盖数据库）
- 人工验证 / resolution

注意：models.dev 不等于厂商官方文档。Audit 输出会区分 provenance。

### 常见状态不会自动成为"失败"

允许以下状态存在：

- Identity unresolved > 0
- Capability unknown > 0
- Compile transport unknown > 0

这些是保守正确的结果，不是错误。
