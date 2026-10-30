# Orbit Git 使用指南网站

插件功能介绍、交互演示和安装指南，与插件一起按根目录的 [MIT License](../LICENSE) 开源。本指南以 **Orbit Git 0.15.0 稳定版**（`PRCooper.orbit-git`）为准。安装包、源码和校验文件均从 [组织仓库 v0.15.0](https://github.com/qimaotech/orbit-git/releases/tag/v0.15.0) 获取；下载链接固定到对应 tag，确保指南与下载版本一致。

## 开发与预览

需要 Node.js 22+；本地预览另需 Python 3。无需安装第三方依赖，在项目根目录运行：

```sh
npm --prefix guide run build
python3 guide/tools/preview.py
```

打开 `http://127.0.0.1:4199/`；也可使用 `/guide/` 子路径检查资源加载。

## 目录

- `web/`：手写页面、样式、安装交互和固定演示数据。
- `build.mjs`：复用插件 `media/` 中的界面组件，生成静态网站到 `site/`。
- `tools/preview.py`：本地预览与演示加载回归工具。

网站演示使用固定数据，不读取编辑器、文件或业务仓库，不调用 Git。两个交互演示内置于沙箱 iframe 的 srcdoc 中，无外部运行依赖。

## 静态托管

先执行构建，再将 `guide/site/` 的内容交给任意静态 Web 服务器。资源使用相对路径，支持域名根路径和目录挂载。部署配置、凭据和服务地址不属于项目源码。

## 发布边界

`guide/` 纳入项目 Git；生成的 `site/` 不提交。根目录 `.vscodeignore` 排除 `guide/**`，因此插件 VSIX 不包含本网站。公开源码可从项目 Git 提交或标签生成，避免上传本地依赖和构建缓存。

更新插件版本时，同步修改 `web/index.html` 中的版本、下载入口与 `web/app.js` 中的安装命令。固定版本附件应使用对应 tag 的下载地址；未提供该版本附件时只链接发行页面，不构造尚不存在的 VSIX 下载地址。

## 演示加载回归

预览服务器故意让 `demo.html` 返回空白；主页的两个内置演示仍应各显示 4 条提交。访问 `/?break_bundle=1` 模拟演示包失败，应显示错误提示和重新加载入口。
