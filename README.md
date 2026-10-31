# MergeInvoice-web · 发票拼版工具

> 将两张 A5 版式发票自动拼版到单张 A4（第二张旋转 180°），页缘附裁切标记线。纯浏览器本地解析，文件数据不出本机。

![Vite](https://img.shields.io/badge/Vite-8.3.5-646CFF?logo=vite&logoColor=white)
![pdf-lib](https://img.shields.io/badge/pdf--lib-1.17.1-1B1B1B)
![pdf.js](https://img.shields.io/badge/pdf.js-5.7.284-E84A27)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A520.19-5FA04E?logo=nodedotjs&logoColor=white)

---

## 效果示意

![拼版布局示意：单张 A4 上半为发票 A（顶对齐、水平居中），中线附裁切标记，下半为旋转 180° 的发票 B](assets/merge-layout.svg)

- 奇数张 A5 时，最后一张单独占一页，中线裁切标记照常绘制；
- A4 版式整页发票逐张输出（内容高度不足整页时底部附裁切线）；
- 数字签名与电子印章的**可视外观**在合并时烘焙进页面内容流，打印/分发所见即所得。

## 功能特性

| 类别 | 说明 |
| --- | --- |
| 批量导入 | 点击选择 / 拖拽导入，支持多选与多次追加 |
| 智能去重 | 基于内容哈希（SHA-256）检测重复文件，自动跳过 |
| 导入保护 | 单个 PDF **最多 10 页**，超出拒绝导入并明确提示 |
| 页管理 | 逐页缩略图预览，单页删除 / 恢复，统计与合并结果实时联动 |
| 顺序调整 | 导入列表与合并结果均支持**拖拽排序**（含边缘自动滚动） |
| 结果编辑 | 合并结果可删除单页、重排页面，下载与打印始终按当前预览输出 |
| 预览 | 卡片内自适应缩略图、点击放大弹窗、窗口缩放自动重渲染 |
| 打印 | 调起系统打印对话框（失败自动降级为图片模式） |
| 隐私 | 全程浏览器本地解析，**无任何网络上传**，文件数据不出本机 |

## 快速开始

```bash
# 环境要求：Node.js ≥ 20.19
git clone <repo-url> MergeInvoice-web
cd MergeInvoice-web
npm install

npm run dev        # 开发服务器，默认 http://localhost:5173
npm run build      # 生产构建 → dist/
npm run preview    # 本地预览构建产物
npm test           # 单元测试（node --test，18 个用例）
```

## 使用流程

1. **导入发票** —— 拖入或选择 PDF（可多选）。卡片上可翻页预览、点击「页」管理单页删除，拖拽卡片调整文件顺序；
2. **合并** —— 查看待合并清单（A5 / A4 / 跳过 / 已删 页数与预计输出张数），确认后一键合并；
3. **下载 / 打印** —— 结果页可继续删除单页或拖拽排序，然后下载 PDF 或调起系统打印。

## 拼版规则

- **页面分类**：取 MediaBox ∩ CropBox 有效盒；有效宽 > 615pt 判定为超出 A4 宽度而跳过；有效高 < 420.9445pt（A4 高度一半）判为 A5 横向发票，否则判为 A4 整页；
- **A5 两拼**：两页拼入同一张 A4 —— 第一页顶部对齐、水平居中；第二页旋转 180° 落于下半区；中线左右各绘制一段 10pt / 1pt 裁切标记线；
- **A4 整页**：一页占一张 A4、顶部对齐水平居中；仅当内容高度不足整页（`h + 50 < 页高`）时在内容底部绘制裁切线；
- **输出顺序**：所有 A5 页在前、A4 页在后，各自保持导入顺序；
- **文件命名**：`合并发票yyyyMMddHHmmss.pdf`。

## 技术架构

无框架纯 ES Modules 前端，Vite 构建：

```
MergeInvoice-web/
├── app/                    # 前端（vite root）
│   ├── index.html          # 向导式三步骤界面（导入 → 合并 → 下载/打印）
│   ├── public/favicon.svg  # 站点图标
│   └── src/
│       ├── main.js         # 全部 UI 状态与交互（导入/页管理/排序/结果编辑/打印）
│       ├── styles.css      # 自适应布局（宽屏至 1600px，窄屏可用）
│       └── modules/
│           ├── invoices.js # 记录创建、页面分类、去重哈希、10 页导入上限
│           ├── merge.js    # 拼版规则（A5 两拼 / A4 整页 / 裁切标记）
│           ├── flatten.js  # 注解外观扁平化（印章/签名烘焙进内容流）
│           ├── preview.js  # pdf.js 渲染（自适应宽高、DPR、任务中止）
│           └── print.js    # 系统打印（原生优先，图片模式降级）
├── worker/                 # 可选：Cloudflare Worker（IMAP 中继 API，与静态前端同域部署）
│   ├── wrangler.toml
│   └── src/
├── vite.config.js          # root 'app'、base './' 相对路径部署 + pdf.js 运行时资源复制
└── test/                   # node --test 单元测试与发票/印章夹具
```

| 组件 | 选型 | 用途 |
| --- | --- | --- |
| [pdf-lib](https://pdf-lib.js.org/) | ^1.17.1 | PDF 解析、注解扁平化、拼版合成、删页/重排 |
| [pdf.js](https://mozilla.github.io/pdf.js/) | ~4.2.67 | 页面渲染预览与打印图片降级（锁 4.2.67：CVE-2024-4367 修复起点，见 AGENTS.md） |
| [Vite](https://vite.dev/) | ^8.3.5 | 开发服务器与生产构建 |

## 打印建议

浏览器不提供本地打印机枚举接口，点击「打印」后请在系统对话框中选择目标打印机。推荐参数：

- 纸张：**A4**
- 缩放：**100% / 实际大小**
- 页边距：**无**

## 测试与部署

**一键测试**：`npm run check`（= `lint` + `test` + `build`，任一环节失败即中止）。

**本地联调**：`npm run dev` 同时启动 Vite（`http://localhost:5173`，前端热更新）与 wrangler dev（Worker，代码变更自动重载），`/api` 由 Vite 代理到 Worker，邮箱导入可直接测试；首次运行若缺 `dist/` 会自动构建一次。仅想跑前端可执行 `npx vite`。

**一键部署**：`npm run deploy`（= `vite build` + `wrangler deploy`，首次需 `npx wrangler login` 授权）。

**自动部署（推送即更新）**：在 Cloudflare 控制台把 Worker 连接到 GitHub 仓库（Workers & Pages → 选择已有 Worker 的 Settings → Builds → Connect，或新建应用时直接导入仓库），选择 `main` 分支，之后每次推送 Cloudflare 自动构建并部署：

- 构建命令（Build command）：`npm run check`（lint + test + build，失败则不部署）
- 部署命令（Deploy command）：`npx wrangler deploy -c worker/wrangler.toml`

无需在 GitHub 配置任何 Secret（Cloudflare 会自动生成部署令牌）；构建记录见 Worker 的 Deployments → View build history。

说明：旧的 Cloudflare Pages 项目（纯静态时代）建议在仪表盘停用或删除，避免旧入口继续自动构建旧版且不含邮箱 API。构建产物 `dist/` 仍为纯静态（相对路径部署），单独拷贝到任意静态托管也能用，但「从邮箱导入」需要 Worker 同域或分域配置（见 `docs/mail-import.md`）。

## 浏览器支持与已知限制

- 需支持 PDF.js 与 ES Modules 的现代浏览器（推荐近两年版本的 Chrome / Edge / Firefox）；
- 加密 PDF 不做真实解密（仍尝试读取结构，内容渲染可能失败）；
- 仅处理注解的默认外观流（`/AP/N`），不处理外观状态字典；
- 页面合并不保留可交互表单与链接注解，仅保留印章/签名等可视外观。

## 隐私声明

所有解析、拼版、预览、打印均在浏览器本地完成，本地 PDF 文件内容不会上传至任何服务器。可选的「从邮箱导入」仅在用户主动发起时经自建 Cloudflare Worker 中继 IMAP 字节流，Worker 零存储（不用 KV/D1、不落盘、不打印凭据），详见 `docs/mail-import.md`。

---

© 2026 Sharper 版权所有 · All Rights Reserved
