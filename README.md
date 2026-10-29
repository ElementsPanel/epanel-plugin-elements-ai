# @elementspanel/epanel-plugin-elements-ai

让 Agent 接管面板。

插件 ID 为 `elements-ai`，同时提供面板端（`panel/`）和守护进程端（`daemon/`）。

在 ElementsPanel 工作区中执行 `npm run build --workspace=@elementspanel/epanel-plugin-elements-ai` 构建插件。发布包包含两端的插件清单和编译产物。

`panel/src/backend/catalog/` 中的目录查询与配置校验辅助代码来自 ElementsPanel 的实例、模组与公共模块，沿用 Apache-2.0 许可，以便独立构建时不再引用主仓库源码。构建脚本保留插件的 `apply` / `inject` 导出，并生成 `panel/frontend/assets/style.css`。
