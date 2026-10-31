# AGENTS.md — Agent 工作指南

## 项目简介

MergeInvoice-web：发票拼版工具。浏览器本地导入 PDF 发票，将两张 A5 版式发票拼版到单张 A4（第二张旋转 180°、中线附裁切标记），A4 整页逐张输出；支持预览、按页删除、拖拽排序、下载与系统打印。文件数据不出本机。

两种导入来源：本地 PDF/ZIP（ZIP 自动解出其中 PDF）与「从邮箱导入」（163/126/yeah/QQ 邮箱按日期范围搜索发票邮件，勾选后下载附件走同一导入链路）。后者依赖可选的 **Cloudflare Worker 后端**（`worker/`，静态前端 + IMAP 中继 API 同域部署，免费版即可）；未部署时本地导入不受影响，仅邮箱功能提示 404 引导。

## 常用命令（win32 / PowerShell，npm 必须用 `npm.cmd`）

```powershell
npm.cmd run dev        # 一键联调：Vite(5173，前端热更新) + wrangler dev(8787，Worker 自动重载)，/api 已代理
npm.cmd run build      # 构建到 dist/（含 pdfjs 运行时资源复制）
npm.cmd test           # node --test
npm.cmd run lint       # ESLint（app/src/** 与 worker/** 按 ES2020 基线校验）
npm.cmd run check      # 一键测试 = lint + test + build（任一失败即中止）
npm.cmd run preview    # 预览构建产物
npm.cmd run dev:api    # 产物模式联调：先 build，wrangler dev 直接服务 dist/ + API（http://localhost:8787）
npm.cmd run deploy     # vite build && wrangler deploy：部署前端 + API 到 Cloudflare
```

**改动后的必跑验证**：`npm.cmd lint` + `npm.cmd test` + `npm.cmd run build`。

## 代码风格与浏览器兼容基线

- **语法/API 基线：ES2020**（由 `eslint.config.js` 的 `ecmaVersion` 约束业务源码）。`vite.config.js` 的 `build.target` 为 `chrome89/edge89/firefox89/safari15`——因为 pdf.js 4.2 主包使用 top-level await（Chrome 89 / Safari 15 起支持），这是实际浏览器下限，无法再低。
  - 业务代码（`app/src/**` 除 `pdfjs-compat.js`，以及 `worker/**`）禁止使用 ES2021+ 的语法与内置 API（如 `Object.hasOwn`、`Array.at`、`findLast`、`replaceAll`、`Promise.withResolvers`、`URL.parse`、`structuredClone`、Set 集合运算等），ESLint 会报错。
  - 需要兼容写法时优先用 ES2020 及更早的等价实现（如 `Object.prototype.hasOwnProperty.call`、`new URL() + try/catch`、手工循环等）。
  - `test/**` 与配置文件跑在 Node 上，不受浏览器基线约束。
- **`app/src/modules/pdfjs-compat.js` 是 pdf.js 4.2 的运行时 API 兼容层**，不是业务代码的 polyfill 仓库：
  - pdf.js 4.2 内部会调用 `Promise.withResolvers`、`structuredClone`、`Array/String.prototype.at`，`build.target` 只能转译语法、无法补运行时 API，故这三块补丁不可删除（`replaceAll`/`trimEnd`/`flat`/`Promise.finally` 在既有浏览器下限内，无需补丁）。
  - **禁止**因业务代码缺 API 而往该文件追加补丁；业务侧应改写为 ES2020 兼容写法。仅当 pdf.js 升级引入新 API 报错时才在此补齐（主线程与 Worker 共用同一份）。
  - 测试：`test/pdfjs-compat.test.mjs` 模拟缺失后验证补齐行为。
  - 选型说明：pdf.js 5.x 需补 ~13 个新 API；锁 **4.2.67**（CVE-2024-4367 修复起点）只需 3 个，且保留老浏览器兼容。勿升到 4.10+（又引入 `Promise.try`、`toHex/toBase64` 等）或降回 4.0.x（有 CVE）。

## 目录结构

前端整体在 `app/`（index.html、public、src 同迁入，由 `vite.config.js` 的 `root: 'app'` 指定），后端在 `worker/`（自带 `src/`），共享测试在 `test/`。

| 文件 | 职责 |
| --- | --- |
| `app/index.html` | 向导三步骤（导入 → 合并 → 下载/打印）、步骤条、弹窗、邮箱导入对话框、页脚（引用 `%BASE_URL%favicon.svg`） |
| `app/public/favicon.svg` | 站点图标（SVG，Vite 原样复制到 dist 根目录） |
| `docs/mail-import.md` | 邮箱导入用户文档：授权码开通、Cloudflare 部署、API_TOKEN/ALLOW_ORIGIN、安全与存储行为 |
| `app/src/main.js` | 全部 UI 状态与交互：导入/去重/页数上限、页管理（删页）、步骤切换、结果页删除与拖拽排序、拖拽自动滚动、resize 重渲染、邮箱对话框（搜索/勾选/逐封导入） |
| `app/src/styles.css` | 样式（容器 `min(1600px, 100% - 40px)` 自适应；预览框 aspect-ratio；邮箱对话框） |
| `app/src/modules/invoices.js` | 记录创建、页分类、`countKinds`/`isMergeable`、内容哈希去重、`MAX_IMPORT_PAGES=10` 与 `probePageCount` |
| `app/src/modules/import-pipeline.js` | 通用导入管道（文件/拖拽/ZIP/邮件附件四路共用）：去重 → 页数上限 → 建记录，`importEntries` |
| `app/src/modules/zip.js` | ZIP 解析（手动中央目录，GBK 文件名修复、zip 炸弹防护、ZIP64 拒绝）；`extractPdfEntries`/`isZipFile` |
| `app/src/modules/mime.js` | RFC822/MIME 解析：附件提取（pdf/zip）、RFC2047/RFC2231 解码、`parseMessageHeaders` |
| `app/src/modules/mail.js` | 邮箱服务商预设与 Worker API 客户端（`searchMail`/`fetchRaw`）、关键词过滤、`structureHasAttachment` 附件预判、错误分类 |
| `app/src/modules/mail-store.js` | localStorage 持久化：授权码 60 天滑动过期、关键词永存、界面偏好（`mi-mail.*` 前缀） |
| `app/src/modules/merge.js` | 合并规则（A5 两拼 / A4 整页 / 裁切标记）；`isPageIncluded` 排除已删页 |
| `app/src/modules/flatten.js` | 注解外观（印章/签名）扁平化烘焙进内容流 |
| `app/src/modules/preview.js` | pdf.js 打开与渲染（`renderInto` 按实测宽高适配） |
| `app/src/modules/print.js` | 打印（原生 iframe 优先，失败退图片模式） |
| `app/src/modules/pdfjs-compat.js` | pdf.js 4.2 运行时 API 兼容层（勿为业务代码追加补丁，见「代码风格与浏览器兼容基线」） |
| `worker/wrangler.toml` | Worker 配置：`main`、`[assets]` 指向 `../dist`、可选 vars（API_TOKEN/ALLOW_ORIGIN）说明 |
| `worker/src/index.js` | Worker 入口：静态资源透传 + `/api/mail/search`、`/api/mail/raw` 路由、校验、错误映射、`cloudflare:sockets` 连接 |
| `worker/src/imap.js` | 手写最小 IMAP4rev1 客户端（LOGIN/ID/SELECT/SEARCH/UID FETCH 邮件头 + BODYSTRUCTURE/正文/LOGOUT；流抽象 `{readable,writable}` 入参，`connect()` 仅在 index.js） |
| `worker/src/validate.js` | API 入参校验与服务商主机白名单（独立模块以便 Node 测试） |
| `scripts/dev.mjs` | 一键联调脚本：并行启动 Vite 与 wrangler dev，Ctrl+C 一并结束；Worker 端口可用 `MI_API_PORT` 覆盖（默认 8787，vite 代理读同一变量） |
| `vite.config.js` | Vite 配置：`root: 'app'`、`base: './'`、`build.outDir: '../dist'`、pdfjs 与 docs 资源复制、`worker: { format: 'es' }`、`server.proxy` 把 `/api` 转发到本地 Worker |
| `eslint.config.js` | ESLint 扁平配置：`app/src/**` 与 `worker/**` 按 ES2020 基线 + 禁 ES2021+ API（共用 `es2020Rules`） |
| `test/` | `node --test`；`helpers.mjs` 造发票/印章夹具与断言工具 |

## 业务规则（勿擅自改动）

- 分类阈值：有效宽 > 615pt → 跳过；有效高 < 841.889/2（≈420.9445pt）→ A5，否则 A4。有效盒 = MediaBox ∩ CropBox。
- A5 两两拼 A4：上半顶对齐水平居中，下半 `rotate: 180°` 锚点 `(x=居中+页宽, y=页高)`；中线画 10pt/1pt 裁切线（x 10→20、W−10→W−20）；奇数页单独成页仍画中线。
- A4 整页：`h + 50 < 页高` 才画底部裁切线。输出顺序：A5 在前、A4 在后，均保持导入顺序。
- 输出：`合并发票yyyyMMddHHmmss.pdf`；保存参数 `{ useObjectStreams: false }`。
- 导入限制：单 PDF > `MAX_IMPORT_PAGES`（10）页拒绝导入（`probePageCount` 结构级快查，拒绝前不做扁平化/渲染）。
- `vite.config.js`：`root: 'app'`（前端整体位于 app/，与 worker/ 对称），`base: './'`（相对路径部署），`build.outDir: '../dist'` + `emptyOutDir: true`（输出回项目根 dist/，`worker/wrangler.toml` 的 `[assets]` 指向不变；outDir 在 root 之外须显式开启清空）；静态资源复制的 `src` 须用相对 vite root 的路径（如 `../node_modules/pdfjs-dist/…`、`../docs/*.md`）——插件按 `config.root` 解析，Windows 绝对路径会让 glob 与 `stripBase` 的 `../` 剥离失效；pdfjs 复制保留 `rename: { stripBase: true }`，docs 复制 `dest: '.'` 以落到 `dist/docs/`；pdf.js 4.2 只复制 `cmaps`、`standard_fonts`（无 `wasm`/`iccs` 目录，JBIG2 等走 JS 解码）。

## 关键注意事项（踩过的坑）

- **pdf-lib**：`PDFObject` 没有 `.ref`；字符串经 `context.obj()` 会变 `PDFName`（不带前导斜杠）；typed `lookup` 类型不符会抛错（用 try/catch 包住）；`page.node.MediaBox()` 缺失时抛错；`PDFArray` 有 `get/insert/remove`。
- **重排/删页**：`/Kids` 在 `/Pages` 节点上（`catalog.lookup(PDFName.of('Pages'))`），**不在**文档目录上；数组元素为页面引用，改动后 `save` 生效。`removePage`/`getPageCount` 可直接用。
- **已保存 PDF 的内容流是 Flate 压缩的**：测试断言读页面内容须用 `decodePDFRawStream(stream).decode()`（夹具 `helpers.mjs` 已封装）；印章/签名文本在嵌入页 XObject 内，用 `readXObjectContents(page)`。
- **pdf.js 4.2**：worker 用自定义入口 `app/src/pdf-worker.js`（先导入 `./modules/pdfjs-compat.js` 再加载 pdf.js worker，经 `?worker&url` 打包），`vite.config.js` 必须保留 `worker: { format: 'es' }`（pdf.js 固定用 `{ type: 'module' }` 创建 Worker）；旧版浏览器缺少的新 API 由 `pdfjs-compat.js` 补齐（主线程与 Worker 共用同一份，仅允许为 pdf.js 补、不允许为业务代码补）；`render` 传 `transform`（dpr 放大）；同一 canvas 连续渲染先 abort 旧任务。`openPdf` 只传 `cMapUrl`/`cMapPacked`/`standardFontDataUrl`（4.2 无 `wasmUrl`/`iccUrl` 选项）。
- **Cloudflare Worker 侧约束**（`worker/`）：免费版 CPU 10ms/请求（网络等待不计）——Worker 只做 IMAP 字节中继与 BODYSTRUCTURE 附件预筛（正则，极轻量），MIME/ZIP 解析、关键词过滤全在前端；IMAP 主机白名单硬编码（163/126/yeah/QQ），无存储（不用 KV/D1）、不打印凭据；时间范围前后端双重校验 ≤ 90 天；`cloudflare:sockets` 的 `connect()` 仅出现在 `worker/src/index.js`（Node 无法加载该模块，故校验逻辑拆在 `worker/src/validate.js` 供测试），IMAP 客户端（`worker/src/imap.js`）入参为 `{readable,writable}` 流以便假服务器注入。授权码明文存浏览器 localStorage（60 天滑动过期、成功使用顺延），Worker 不落盘，详见 `docs/mail-import.md`。
- **注释一律用中文**（项目约定，源码与测试都要有注释）。
- **文件编码统一 UTF-8（无 BOM）**：中文 Windows 环境默认编码为 GBK/GB2312，用系统默认编码写文件会导致中文注释/文档乱码。
  - 所有源码、测试、Markdown、HTML、JSON/配置文件必须保存为 **UTF-8 无 BOM**；新增 HTML 文件须声明 `<meta charset="UTF-8">`；
  - 禁止依赖默认编码读写文件：PowerShell 中 `>`、`Out-File`、`Set-Content` 不带 `-Encoding` 时按版本输出 UTF-16LE 或 ANSI(GBK)，写文件必须显式 `-Encoding utf8`（或改用会自动输出 UTF-8 的工具）；
  - 读取含中文的文件做校验时显式指定 UTF-8（如 `Get-Content -Encoding utf8`），避免按 GBK 解码得到乱码后误判文件损坏；
  - **换行统一 CRLF**：本项目在 Windows 下开发（工作区文件为 CRLF），依赖 `core.autocrlf=true` 在提交时自动转换为 LF 入库；自动部署至 Linux 后检出即为 LF。不需要 `.gitattributes`，也不要强制把工作区改成 LF，避免同仓库换行风格混用产生 diff 噪声。
- 文件名可能含 HTML 特殊字符，写入 DOM 必须用 `textContent`。
- **Markdown 文档中禁止使用 ASCII 字符画**（`┌─┐│` 等框线字符在不同查看器/字体下宽度不一致，CJK 混排必然错位）：示意图改用 SVG/PNG 图片（存放于 `assets/`，如 `assets/merge-layout.svg`），或用纯文字/表格描述。目录树例外：代码块内「框线 + ASCII 路径、CJK 仅出现在尾部注释」的树形列表可以保留。

## Git

分支 `main`；`.gitignore` 忽略 `node_modules/`、`dist/`、`.wrangler/`，不提交依赖与构建产物。**未经用户明确要求不要 commit/push**。

自动部署为**分域**方案：前端走 Cloudflare Pages（`mergeinvoice.pages.dev`，构建命令 `npm run check`、输出 `dist`），后端走 Cloudflare Workers Builds（Worker `merge-invoice-web` 连同一仓库 `main`，构建命令 `npm run check`、部署命令 `npx wrangler deploy -c worker/wrangler.toml`）；跨域由 `worker/wrangler.toml` 的 `ALLOW_ORIGIN` 放行，前端默认 API 地址由 Pages 构建变量 `VITE_API_BASE` 注入。手动部署仍可 `npm.cmd run deploy`（本地凭 `npx wrangler login`）。

### 提交消息规范（Conventional Commits，摘要用中文）

```
<type>(<scope>): <摘要，中文，≤50字，不加句号>

<可选正文：以 - 列出关键要点>
```

- `type`：`feat`（新功能/行为变化）、`fix`（缺陷修复）、`docs`（仅文档）、`refactor`（无行为变化重构）、`test`（测试增改）、`chore`（构建/依赖/杂项）、`style`（格式/注释）
- `scope` 可选：`merge` / `flatten` / `ui` / `preview` / `import` 等模块名
- 摘要精确描述"做了什么"，不写"更新/修改"等模糊词；一次提交只表达一个主题
- 提交消息文件须为 UTF-8（用 `git commit -F` 传入文件可避免命令行转码问题）
