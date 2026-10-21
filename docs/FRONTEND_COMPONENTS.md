# 前端组件统一审查

日期：2026-10-21。[跨项目约定](https://github.com/KeatonLi/clipjar/blob/main/docs/shared-frontend-standard.md)以 ClipJar 的 Nova 组件为 React 基线，以 shadcn-vue / Reka 为 Vue 对应实现。

## Kivo 的结论

Kivo 当前不是 React / Vue 应用：`media/main.js` 渲染 Webview，`IdeaGitViewProvider` 通过 nonce / CSP 加载本地资源，VS Code 提供扩展入口、主题和原生编辑器。界面继续遵循 [IDEA parity](IDEA_PARITY.md) 和 [现有设计约定](DESIGN.md)。

本轮不安装 shadcn、React、Motion、Zustand、分栏或拖拽依赖，也不改动 Git 操作。把这些库加入 package.json 本身不能让现有 Webview 成为组件化 React 界面。

## 可以统一的维护原则

- 控件尺寸、焦点可见性、禁用状态、键盘和安全确认保持一致，使用现有共享 Webview 控件及 VS Code 主题变量。
- Codicons 与用户的文件图标主题属于宿主体验，继续保留；文件图标不能简单换成统一的 Lucide 文件图标。
- 保留消息桥、VS Code Webview 状态和 CSP，不引入浏览器持久化替代宿主状态。
- 现有分栏和 Git 拖拽具有业务协议；只有单独验证对应行为后才考虑替换底层实现。

本次只提交审查记录，运行时代码没有迁移，因此不宣称 Kivo 已使用 Nova。
