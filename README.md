# @elementspanel/epanel-plugin-elements-ai

让 Agent 接管面板。

插件 ID 为 `elements-ai`，同时提供面板端（`panel/`）和守护进程端（`daemon/`）。

全部元数据以根 `package.json` 为准，包括版本、`elementspanel.id` 和 `elementspanel.dual`；两端 `plugin.json` 只定义入口。加载优先级、前端依赖和 CSS 路径记录在 `elementspanel.panel` 中，构建脚本同步更新其中的 `styles`。

完整构建逻辑直接位于本包 `package.json.scripts.build` 中，构建工具由本包的 `devDependencies` 提供。在插件目录执行 `npm run build`，或在 ElementsPanel 工作区执行 `npm run build --workspace=@elementspanel/epanel-plugin-elements-ai`；`prepack` 在打包发布前调用同一脚本。发布包包含两端的插件清单和编译产物。

`panel/src/backend/catalog/` 中的目录查询与配置校验辅助代码来自 ElementsPanel 的实例、模组与公共模块，沿用 Apache-2.0 许可，以便独立构建时不再引用主仓库源码。构建脚本保留插件的 `apply` / `inject` 导出，并生成 `panel/frontend/assets/style.css`。
