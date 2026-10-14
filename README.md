# 雨课堂自动连播（Yuketang Auto Next）

一个油猴（Tampermonkey）脚本：**雨课堂课程视频播完后自动切到下一个视频**，不用每节都手动点一下。

适配 **2026 新版「学习空间」**（`/ai-workspace/lms-graph/…`），同时兼容 `/pro/lms` 与 `v2/web` 旧版页面。

> ⚠️ 仅供个人学习与前端技术研究使用。请先阅读文末的[免责声明](#免责声明)。

---

## 功能

- ✅ 视频播完自动切到下一节，无需手动点击
- ✅ 自动跳过目录里的**作业 / 讨论 / 考试 / 测验 / 直播**等非视频项，只接视频
- ✅ 适配 2026 新版学习空间；旧版 `pro/lms`、`v2/web` 走其它分支兜底
- ✅ 可选：播放结束后自动静音、倍速播放
- ✅ 可选：视频被暂停（切屏、失焦）后自动续播
- ❌ 不答题、不做作业、不刷时长、不修改任何学习记录

## 安装

1. 给浏览器装上 **Tampermonkey**（[Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) / [Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)）
2. 点击安装脚本：

   **https://raw.githubusercontent.com/114514592/yuketang-auto-next/main/ykt-auto-next.user.js**

   （或者把 `ykt-auto-next.user.js` 拖进浏览器窗口；若拖拽没反应，去 `edge://extensions` 给 Tampermonkey 打开「**允许访问文件网址**」）
3. 打开雨课堂的课程视频页，**刷新一次**

## 使用

打开课程 → 左侧目录点进任意一个**视频**章节 → F5 刷新。之后视频播完就会自动切到下一节，右下角会出现提示。

脚本默认不会加速、不会静音。想看剧式挂机可以在脚本开头调整配置。

## 配置

打开油猴里的脚本，修改顶部的 `CONFIG`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `PREFER` | `['api', 'leaf', 'arrow']` | 切换下一节的尝试顺序，见下方「工作原理」 |
| `DONE_PERCENT` | `99` | 完成度 ≥ 此值即认为本节已完成 |
| `DELAY_MS` | `3000` | 视频结束后等多久再切（给平台上报进度留时间） |
| `AUTO_RESUME` | `true` | 被暂停后 1.5 秒自动续播。**课程里有弹题时建议改成 `false`**，否则会和弹题抢焦点 |
| `SPEED` | `1` | 播放倍速，`1.5` / `2` 等 |
| `MUTE` | `false` | `true` = 静音播放 |
| `RETRY_COOLDOWN_MS` | `60000` | 某次切换失败后，隔多久才重试同一个视频 |

## 工作原理

脚本在视频结束（或顶部「完成度」达 100%）后，按 `CONFIG.PREFER` 的顺序依次尝试三种方式：

| 顺序 | 方式 | 做法 |
| --- | --- | --- |
| 1 | `api` | 调 `todo_list` 接口拿未完成清单，挑下一个视频直接改 URL 跳过去 |
| 2 | `leaf` | 点左侧目录 `.leaf-item.is-active` 之后**第一个文字含「视频」的** `.leaf-item` |
| 3 | `arrow` | 点播放器控制条上的「下一节」箭头 `.control-right i.unit-arrow.arrow-reverse`（仅当它未被禁用） |

关键选择器（新版学习空间）：

```js
'.leaf-item.is-active'                              // 左侧目录当前项
'.control-right i.unit-arrow.arrow-reverse'         // 下一节箭头
'.control-right i.unit-arrow:not(.arrow-reverse)'   // 上一节箭头
'.rate-detail .el-tooltip.text'                     // 顶部「完成度：x%」/「已完成」
'.leaf-item-status i[class*="yuanquangou"]'         // 目录里的完成图标
```

两个实测结论，能省下后来人不少时间：

1. **每讲只有一节时，`‹ ›` 箭头是永久禁用的**（带 `is-disable`），所以不能把它当主路径——真正能用的是左侧目录。
2. **`todo_list` / `sku_list` 接口目前调不通**：服务端返回 `CLASSROOM ID IS REQUIRED`，因为它要求的 `university-id` / `platform-id` 请求头来自 `document.cookie`，而这类 cookie 是 HttpOnly，页面脚本读不到。脚本在连续失败 3 次后会自动熔断该路径，只用目录方式。

## 排查

在雨课堂页面的控制台里：

```js
ykt.report()                    // 当前状态：页面版本、完成度、目录项、统计
ykt.resolveNext().then(console.log)   // 只读：看看脚本"打算"去哪里，不会跳转
```

如果控制台取不到 `ykt`（脚本可能运行在隔离上下文里），改用 DOM 通道：

```js
document.getElementById('__ykt_report__').textContent
```

正常启动时控制台会打印 `[雨课堂连播] vX.Y.Z 已启动（页面版本 new）`。

## 已知限制

- **依赖页面类名**：雨课堂改版（比如 `.leaf-item` 改名）就会失效，需要更新选择器。
- **目录树必须是展开状态**：脚本靠 DOM 里已有的 `.leaf-item` 判断顺序；如果目录是懒加载、当前节之后的项还没渲染，会找不到目标。
- **弹题冲突**：视频内弹题会暂停播放，`AUTO_RESUME` 会尝试续播，两者可能互相打断。有弹题的课程建议关掉 `AUTO_RESUME`。
- **进度仍由平台判定**：脚本只负责「切到下一个」，不改变平台对观看时长的判定，拖进度条不算完成。
- 未适配其他网课平台。

## 免责声明

本项目完全开源、免费，仅供**个人学习与前端技术交流**。

- 使用本脚本可能违反所在学校、课程或平台的使用条款，**由此产生的一切后果由使用者自行承担**。
- 作者不对脚本的可用性、稳定性、安全性作任何担保，也不对因使用本脚本导致的账号异常、成绩问题或数据丢失负责。
- 请勿将本项目用于任何商业或盈利目的。
- 如果你不同意上述条款，请不要使用本项目。

## 致谢

本项目在编写过程中参考了以下开源项目的思路与选择器（仅参考思路，代码为独立实现）：

- [ZeyrMe/yuketang-jiaoben](https://github.com/ZeyrMe/yuketang-jiaoben)（GPL-3.0）——雨课堂播放器的 DOM 结构分析
- [雨课堂连播助手](https://greasyfork.org/zh-CN/scripts/584407) by Acac1a（MIT）——新版「学习空间」的选择器与 `todo_list` 接口用法

## License

[MIT](LICENSE)
