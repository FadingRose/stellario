# Stellario Bootstrap Troubleshooting

## 日期
2026-06-29

## 问题
opencode 各实例处于 broken 状态，stellario 插件无法正常加载。

## 根因分析

### 1. npm 依赖混乱
stellario 项目存在三条不同的依赖路径，版本不一致：

| 位置 | 版本 | 来源 |
|------|------|------|
| `package.json`（源码） | 1.0.0-beta.6 | 源码项目 |
| `~/.config/opencode/node_modules/stellario/` | v1.0.0-beta.7 | `stellario setup`（Go binary） |
| `.opencode/node_modules/stellario/` | 0.3.0 | npm `github:FadingRose/stellario#v0.3.0` |

项目 `.opencode/package.json` 声明了 `stellario` 的 GitHub 依赖，但版本严重过期（0.3.0），
且未声明 `yaml` 依赖，导致模块加载时 `import yaml` 解析失败。

### 2. 缺失的 npm 依赖
`stellario setup` 生成的 TS runtime `package.json` 没有 `dependencies` 字段。
但 stellario 源码实际依赖：

| npm 包 | 引用文件数 | 用途 |
|--------|-----------|------|
| `yaml` | 3 | YAML 配置文件解析（config.ts, volume-link-defs.ts, cli/bin.js） |
| `zod` | 9 | 数据校验（store.ts, 8 个 defs/*.ts） |

`zod` 能工作纯属巧合（`@opencode-ai/plugin` 的传递依赖），`yaml` 完全缺失。

### 3. install.sh 的 setup 跳过问题
install.sh 在 PATH 检查失败时 `exit 0`，导致 `stellario setup` 从未执行。

## 修复步骤

1. **移除 npm 对 stellario 的依赖**
   - `.opencode/package.json` 删除 `"stellario": "github:FadingRose/stellario#v0.3.0"`
   - 删除残留的 `node_modules/stellario/`（旧版 0.3.0）

2. **统一由 `stellario setup` 管理模块**
   - 运行 `stellario setup`，Go binary 将内嵌的 TS 源码解出到 `~/.local/share/stellario/ts-runtime/`
   - 复制到需要的位置：`~/.config/opencode/node_modules/stellario/`、项目 `.opencode/node_modules/stellario/`

3. **补上缺失的 npm 依赖**
   - 三个 `package.json` 均添加 `yaml` 和 `zod`
   - 运行 `npm install`

4. **修复 `~/.opencode/package.json` 的 JSON 语法错误**
   - 尾随逗号导致 `npm install` 失败

## 修复后的依赖模型

```
npm 管理（声明在 package.json）:
  zod   — stellario 数据校验
  yaml  — stellario 配置解析

stellario setup 管理（Go binary → 文件复制）:
  node_modules/stellario/  — 完整的 TS 源码

已解除 npm 依赖:
  stellario 本身（不再通过 GitHub/npm 安装）
  @huggingface/transformers（语义搜索，graceful degradation）
```

## 残留问题

1. `yaml` 依赖是潜在的 blocker — `stellario setup` 不会自动安装它
2. `npm install` 会清除 `node_modules/stellario/`，需要重新运行 setup 恢复
3. `~/.opencode/` 有记忆数据但无 stellario 插件（待确认是否需要）
