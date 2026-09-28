# epanel-plugin-elements-ai 开发工作区

运行时与配置说明见 [panel/README.md](panel/README.md)。此目录的 `package.json` 用于维护插件自己的 npm 依赖，发布信息仍由 `panel/plugin.json` 提供。

从 ElementsPanel 项目根目录安装插件需要的额外 npm 包：

```bash
npm install --prefix external/epanel-plugin-elements-ai 包名
```

依赖安装在插件内部，无需添加到父项目。提交插件的 `package.json` 和 `package-lock.json`，其他开发环境可执行 `npm ci --prefix external/epanel-plugin-elements-ai` 恢复依赖。也可以在 `panel/` 内单独维护仅该侧使用的依赖。

普通依赖优先使用插件内部安装的版本；Vue、Cordis 等 SDK 共享依赖仍由宿主提供。发布时将可打包的 JavaScript 依赖并入前后端产物，不上传 `node_modules` 或 npm 配置，也不会在使用者的面板执行 npm 安装。原生扩展与运行时动态读取的资源需另行适配打包流程。
