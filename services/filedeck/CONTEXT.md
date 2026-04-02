# Filedeck Context

## 项目定位

`filedeck` 是当前正在运行和持续迭代的真实项目。

它的目标是：
- 本地文件/目录浏览
- 移动端优先的文件管理器式界面
- Express 后端
- 前端采用 `HTML / CSS / JS` 分离结构
- 文件支持抽屉式预览

当前它不是通用模板，而是具体实现项目。

## 当前技术结构

目录结构：

```text
filedeck/
├── package.json
├── package-lock.json
├── node_modules/
├── server.js
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

技术栈：
- 后端：Node.js + Express
- 前端：原生 HTML / CSS / JavaScript
- 本地运行地址：默认 `http://127.0.0.1:8123`
- 根目录：优先读取环境变量 `ROOT_PATH`，未设置时默认使用当前用户的 `~/.openclaw`
- 标题：可通过环境变量 `APP_TITLE` 指定，未设置时默认使用根目录名
- 默认进入目录：优先进入根目录下的 `workspace/`；可通过环境变量 `DEFAULT_ENTRY_NAME` 覆盖，目录不存在时回退到根目录
- 挂载方式：既支持独立运行，也支持挂在 monitor 的 `/<instanceName>/filedeck/` 路径下

## 当前交互约定

目录区：
- 目录浏览在主页面内完成
- 顶部保留标题
- 使用一行路径导航
- 父级路径为蓝色、可点击
- 当前路径为深色、不可点击
- 有“返回上一级”按钮
- 默认进入 `workspace/` 时，仍可通过面包屑和“返回上一级”回到根目录

列表区：
- 偏 Android 文件管理器风格
- 紧凑列表行，而不是大卡片
- 图标没有背景色
- 文件不显示扩展名和字节数
- 目录右侧显示 `x 项`
- 名称以 `.` 开头的隐藏文件和隐藏目录不展示

预览区：
- 文件预览使用底部抽屉
- 抽屉支持遮罩关闭和关闭按钮
- 抽屉当前动作按钮为：
  - `复制路径`
  - `下载文件`
- 不在抽屉按钮上方显示多余信息

## 后端接口约定

当前主要接口：
- `/api/tree`
- `/api/node?id=...`
- `/api/file?id=...`
- `/api/raw?id=...`

约束：
- 目录导航使用不透明节点 `id`
- 当前 `id` 实现为基于根目录相对路径的稳定编码，不依赖进程内临时映射
- 不在路由参数里直接暴露真实文件路径
- 文件预览返回 `copyPath` 供复制路径功能使用
- 前端 API 请求应基于当前页面路径推导服务前缀，以兼容 `/<instanceName>/filedeck/` 挂载方式
- 如果通过 monitor 转发 `filedeck`，必须保留 query string，否则 `/api/node?id=...` 和 `/api/file?id=...` 会失效

## 维护关系

`filedeck` 和 `filedeck-skill` 的关系如下：

- `filedeck`
  - 真实项目
  - 用于先实现、先验证、先调 UI

- `filedeck-skill`
  - 从 `filedeck` 提炼出的通用 Skill
  - 用于沉淀流程、标准、脚本和模板

推荐维护方向：

```text
filedeck -> filedeck-skill
```

也就是说：
1. 先在 `filedeck` 中完成修改和验证
2. 稳定后再同步到 `filedeck-skill`
3. 不建议反过来直接把 Skill 模板当主开发场

## 迭代原则

- 新功能先在 `filedeck` 实现
- UI 微调先在 `filedeck` 验证
- 结构性重构完成后，删除无用文件和无用逻辑
- 当某个做法稳定后，再更新 `filedeck-skill`：
  - `assets/`
  - `references/`
  - `SKILL.md`

## 新窗口恢复上下文时应先读的文件

如果新开一个窗口继续工作，优先读取：
- `CONTEXT.md`
- `server.js`
- `public/index.html`
- `public/styles.css`
- `public/app.js`

如果任务与 Skill 维护相关，再补充读取：
- `../filedeck-skill/SKILL.md`
- `../filedeck-skill/references/`

## 当前状态说明

当前项目已经完成：
- Express 化
- 前端结构/样式/行为分离
- 移动端文件管理器风格 UI
- 抽屉式文件预览
- 列表与路径导航精调
- monitor 挂载路径适配
- 稳定节点 `id` 导航
- 默认进入 `workspace/`
- 隐藏文件过滤

当前项目适合作为后续迭代和 Skill 回写的主来源。
