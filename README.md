# Code Reviewer

一个用于审查 .mcmd 文件的 VSCode 扩展插件。

## 功能特性

- **单文件审查**: 审查当前打开的 .mcmd 文件
- **项目审查**: 审查整个项目的 .mcmd 文件
- **Jira Ticket 审查**: 输入 Jira ticket 号，自动搜索当前分支中包含该 ticket 的 commit，审查其中变更的 .mcmd 文件

## 支持的审查规则

### 文件结构检查
- [Error] 缺少 &lt;name&gt; 标签
- [Error] 缺少 &lt;description&gt; 标签
- [Error] 缺少 &lt;type&gt; 标签
- [Error] 缺少 &lt;local-syntax&gt; 标签或 CDATA 块

### 命名规范
- [Error] &lt;name&gt; 标签中不能包含大写字母
- [Error] &lt;name&gt; 标签中不能包含特殊字符
- [Error] &lt;name&gt; 标签中不能有连续多个空格
- [Error] 文件名不能包含大写字母
- [Error] 文件名不能包含空格
- [Warning] &lt;name&gt; 需要与文件名对应
- [Warning] &lt;name&gt; 中需要包含 'lc' 前缀

### SQL 规范
- [Error] Complex SQL 只能出现在 list/get 命令中
- [Warning] 避免使用 INSERT/UPDATE/DELETE
- [Error] 禁止使用 IN 子查询（使用 EXISTS 替代）
- [Error] SELECT 子句中禁止使用子查询
- [Warning] 除法运算需使用 DECODE 处理除 0 情况
- [Error] list/get 命令中不能出现 DML 语句
- [Warning] SELECT FROM 表名应以 _view 结尾

## 安装

1. 下载 `code-reviewer-0.0.1.vsix` 文件
2. 打开 VSCode
3. 按 `Ctrl+Shift+X` 打开扩展面板
4. 点击右上角 `...` 菜单
5. 选择 **"从 VSIX 安装"** (Install from VSIX)
6. 选择下载的 `.vsix` 文件
7. 安装完成后重新加载窗口

## 使用方法

### 审查当前文件

1. 打开任意 .mcmd 文件
2. 使用快捷键 `Ctrl+Shift+P` 打开命令面板
3. 输入 "Code Reviewer: Review Current File" 并执行

### 审查整个项目

1. 使用快捷键 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Code Reviewer: Review Project" 并执行

### 审查 Jira Ticket

1. 使用快捷键 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Code Reviewer: Review by Jira Ticket" 并执行
3. 输入 Jira ticket 号（如 SWIFTLEX-51198）
4. 插件会搜索当前分支中包含该 ticket 号的 commit，找出变更的 .mcmd 文件并审查

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

# 打包 .vsix
vsce package
```

## 许可证

MIT