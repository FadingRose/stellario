# Stellario Config: Go-ify Plan

## 目标
将 `stellario.yaml` 的解析 + 校验从 TS 移到 Go，消除 `yaml` 和 `zod` 的 npm 依赖。

## 现状
```
TS: loadConfig() → parseYaml() (npm yaml) → validateConfig() (手写)
Go: engine/config/config.go (已有独立实现，YAML parse + validate)
```

两个实现独立维护，逻辑可能不一致。

## 方案
实现 `stellario config show --root <dir> --json`，Go 侧读取 YAML、校验、输出 JSON。
TS 侧改为 `exec("stellario config show ...") → JSON.parse()`。

## 步骤
- [ ] 实现 `stellario config show --root <dir> --json`
- [ ] TS `config.ts` 改为调用 Go CLI
- [ ] 移除 `yaml` npm 依赖
- [ ] 评估是否需要移除 `zod`（Go 校验后 TS 可去掉运行时校验）
