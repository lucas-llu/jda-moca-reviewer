# Code Reviewer

一个用于审查代码内容、格式和风格的 VSCode 扩展插件。

## 功能特性

- **单文件审查**: 审查当前打开的文件
- **项目审查**: 审查整个项目的代码
- **自动保存审查**: 支持在保存文件时自动审查
- **打开文件审查**: 支持在打开文件时自动审查

## 支持的审查规则

- 代码行长度检查 (默认 120 字符)
- 控制台日志检查 (生产环境警告)
- TODO/FIXME 注释提示
- 行尾反斜杠检查

## 安装

1. 克隆或下载此仓库
2. 在 VSCode 中打开项目目录
3. 运行 `npm install` 安装依赖
4. 按 `F5` 启动调试模式测试插件

## 使用方法

### 审查当前文件

1. 打开任意代码文件
2. 使用快捷键 `Ctrl+Shift+P` 打开命令面板
3. 输入 "Code Reviewer: Review Current File" 并执行

### 审查整个项目

1. 使用快捷键 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Code Reviewer: Review Project" 并执行

### 配置选项

在 VSCode 设置中可以配置以下选项:

- `codeReviewer.enableAutoReview`: 启用保存时自动审查
- `codeReviewer.reviewOnOpen`: 打开文件时审查代码

## 开发

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 监听模式 (开发时使用)
npm run watch

# 代码检查
npm run lint
```

## 发布

1. 安装 vsce: `npm install -g vsce`
2. 打包: `vsce package`
3. 发布: `vsce publish`

## 许可证

MIT