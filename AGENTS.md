# AGENTS.md

本文件为 AI 助手在此代码库中工作时提供指导。

## 项目概述

CloudNav（云航）是一个基于 React 19 + TypeScript 构建的个人书签/导航站点，部署在 Cloudflare Pages 上，使用 KV 存储。支持多级分类导航、常用收藏、AI 驱动的描述生成（Gemini/OpenAI）、WebDAV 备份、密码保护访问、分类级别鉴权、Chrome 扩展集成，以及通过 Cloudflare KV 实现的多设备数据同步。

## 构建与开发命令

- `npm run dev` — 启动 Vite 开发服务器，端口 3000
- `npm run build` — 生产环境构建，输出到 `dist/`
- `npm run preview` — 预览生产构建结果
- 项目未配置测试运行器或代码检查工具

## 架构

### 前端（单页应用）

- **`index.tsx`** → 将 `<App />` 挂载到 `#root`
- **`App.tsx`**（约 3400 行）— 单体组件，包含所有 UI 逻辑：侧边栏（支持折叠）、链接网格、拖拽排序（@dnd-kit）、搜索、鉴权流程、批量编辑、收藏功能、右键菜单和弹窗调度。这是需要理解和修改的主要文件。
- **`types.ts`** — 所有共享的 TypeScript 接口（`LinkItem`、`Category`、`SiteSettings`、`AIConfig`、`SearchConfig`、`WebDavConfig`）及默认数据常量。`LinkItem` 包含 `favorite` 字段，`Category` 包含 `parentId` 字段支持多级分类。
- **`index.html`** — 通过 CDN 加载 Tailwind CSS，包含内联脚本，在 React 挂载前从 localStorage/KV 读取 `SiteSettings` 以设置页面标题和图标

### 组件（`components/`）

所有弹窗和 UI 基础组件。每个都是独立的 React 组件，从 `App.tsx` 接收 props：

**弹窗类组件：**
- `AuthModal` — 全局密码登录
- `LinkModal` — 添加/编辑书签，使用 `CategoryTreeSelect` 选择分类
- `CategoryManagerModal` — 分类增删改查，支持多级分类，使用 `CategoryTreeSelect` 选择父分类
- `CategoryAuthModal` — 单个分类密码解锁
- `BackupModal` — WebDAV 备份/恢复、HTML 导出
- `SettingsModal` — 站点设置、AI 配置、Chrome 扩展代码生成
- `SearchConfigModal` — 内部/外部搜索源配置
- `ImportModal` — Chrome/Edge 书签 HTML 导入
- `QRCodeModal` — 二维码显示

**UI 基础组件：**
- `CategoryTreeSelect` — 级联列视图分类选择器（Cascader 风格），支持多级分类选择、搜索过滤、排除指定分类、允许选择"无"。用于编辑链接分类、分类管理父分类选择、批量移动等场景。
- `ConfirmDialog` — 通用确认/提示模态框，提供 `confirmDialog()` 和 `alertDialog()` 两个全局函数，以及 `ConfirmDialogHost` 宿主组件。支持多种变体（danger/warning/info/success）、键盘事件（Esc/Enter）、点击外部关闭。替换原生 `alert`/`confirm`。
- `ContextMenu` — 右键菜单，包含收藏/取消收藏菜单项
- `Icon`、`IconSelector` — 图标组件和选择器

### 服务层（`services/`）

- **`geminiService.ts`** — AI 集成：`generateLinkDescription()` 和 `suggestCategory()`。同时支持 Google Gemini（通过 `@google/genai`）和 OpenAI 兼容 API（DeepSeek 等）
- **`webDavService.ts`** — WebDAV 备份/恢复。所有请求通过 Cloudflare 代理 `/api/webdav` 转发（而非直接访问 WebDAV 服务器），以避免 CORS 问题
- **`bookmarkParser.ts`** — 解析 Netscape 书签 HTML（Chrome/Edge 导出格式）为 `LinkItem[]` 和 `Category[]`
- **`exportService.ts`** — 生成 Netscape 书签 HTML，供浏览器导入使用

### Cloudflare Functions（`functions/api/`）

部署为 Cloudflare Pages Functions 的无服务器 API 端点。全部使用 `onRequestGet`/`onRequestPost`/`onRequestOptions` 模式。它们共享统一的鉴权模型：密码通过 `x-auth-password` 请求头传递，会话时间通过 `x-auth-issued-at` 请求头传递，与 `PASSWORD` 环境变量进行校验。

- **`storage.ts`** — 主数据 API，路径 `/api/storage`。处理：
  - `GET ?checkAuth=true` — 检查是否设置了密码
  - `GET ?getConfig=ai|search|webdav|website|favicon` — 从 KV 读取各类配置（ai/webdav 需要鉴权）
  - `GET`（无参数）— 从 KV 读取 `app_data`（如果启用了 `requirePasswordOnVisit` 则需要鉴权）
  - `POST` 带 `body.authOnly` — 仅验证密码
  - `POST` 带 `body.saveConfig=search|webdav|ai|website|favicon` — 保存特定配置到 KV
  - `POST`（默认）— 保存完整 `app_data` 到 KV（始终需要鉴权）
  - 图标抓取：获取网站图标、Base64 编码后缓存到 KV，键为 `favicon:{domain}`
- **`link.ts`** — Chrome 扩展端点，路径 `/api/link`。POST 创建新书签，支持自动分类检测（查找名为"收集"、"未分类"、"inbox"等的分类）
- **`webdav.ts`** — WebDAV 代理，路径 `/api/webdav`。支持 `check`（PROPFIND）、`upload`（PUT）、`download`（GET）操作，将请求转发到用户的 WebDAV 服务器

### KV 存储键

所有数据存储在单个 Cloudflare KV 命名空间中（`CLOUDNAV_KV` 绑定）：
- `app_data` — JSON `{ links, categories }` — 核心书签数据
- `website_config` — 站点标题、图标、卡片样式、密码设置
- `ai_config` — AI 提供商/API Key/模型配置
- `search_config` — 搜索模式和外部搜索源
- `webdav_config` — WebDAV 连接设置
- `favicon:{domain}` — Base64 编码的图标缓存

### 客户端存储（localStorage）

- `cloudnav_data_cache` — 缓存的应用数据，用于离线/快速加载
- `cloudnav_auth_token` — 密码（明文，用作鉴权令牌）
- `lastLoginTime` — 密码过期检查的时间戳
- `cloudnav_sidebar_collapsed` — 侧边栏折叠状态（`"true"` / `"false"`）
- `cloudnav_webdav_config`、`cloudnav_ai_config`、`cloudnav_search_config` — 本地配置副本

## 关键模式

### 鉴权流程

- 密码以明文与 `PASSWORD` 环境变量比较。会话过期通过客户端的 `x-auth-issued-at` 请求头 + 网站配置中的 `passwordExpiryDays` 强制执行。
- **本地开发模式**：`IS_DEV` 常量（`import.meta.env.DEV`）在开发环境下跳过所有密码验证和 API 调用。`loadFromLocal()` 从 localStorage 读取数据，`syncToCloud()` 模拟保存。

### 多级分类导航

- 分类通过 `parentId` 字段形成树形结构，支持任意层级嵌套。
- `buildCategoryTree()` 构建分类树，`flattenCategoryTree()` 扁平化渲染。
- 分类选择使用 `CategoryTreeSelect` 级联列视图，横向多列展示，逐级展开。
- 侧边栏折叠时，hover 有子分类的节点会弹出子分类浮层。

### 常用收藏功能

- `LinkItem.favorite: boolean` 标记收藏状态。
- "常用推荐"分类（id: `common`）作为独立的收藏入口，显示所有 `favorite=true` 的链接。
- 卡片 hover 显示星标按钮，右键菜单包含"加入常用/取消常用"。
- 收藏不改变链接的原分类归属。

### 侧边栏折叠

- 桌面端（lg+）可折叠侧边栏，宽度从 `w-64` 变为 `w-20`。
- 折叠时只显示分类图标，hover 显示 tooltip 和子分类浮层。
- 折叠状态持久化到 `cloudnav_sidebar_collapsed`。

### 样式与路径

- **Tailwind CSS** 通过 CDN（`cdn.tailwindcss.com`）加载，自定义配置写在 `index.html` 中，不经过 PostCSS/构建流水线。
- **路径别名**：`@/*` 映射到项目根目录（`.`），在 `vite.config.ts` 和 `tsconfig.json` 中均有配置。
- **无路由**：应用是单视图 + 弹窗模式，未使用 React Router。

### 其他

- **Gemini API Key** 在构建时通过 `process.env.API_KEY` / `process.env.GEMINI_API_KEY` 从 `.env` 注入（使用 `GEMINI_API_KEY` 环境变量），但运行时的 AI 配置从 KV 读取并覆盖此值。
- **图标缓存**：网站图标通过 `/api/storage` 抓取并 Base64 编码后缓存到 KV，键为 `favicon:{domain}`，避免重复请求和 CORS 问题。