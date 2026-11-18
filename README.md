# 桌面摸鱼

Windows 桌面上的透明小窗伙伴：一边工作一边让小熊在角落钓鱼、摸鱼。协作方式和开发方式都沿用《适者生存》（[etsevenday/shizheshengcun](https://github.com/etsevenday/shizheshengcun)）：先做网页版，纯 C# 内核；PC 版用 Electron 外壳装同一份网页包（B4 起）。

**网页试玩：** https://etsevenday.github.io/zhuomianmoyu/（推到 main 后自动发布）

- 整页是一块按 16:9 等比缩放的**模拟桌面**（壁纸、桌面图标、记事本、任务栏），游戏小窗浮在上面，宽高各占桌面的 1/4。
- 按住小熊或水面拖动小窗；单击岸边（路亚、手竿）或浅水（摸鱼）给小熊换位置，放不下就留在原处。
- 透明区穿透默认开：点小窗留白处，点击落到下面的桌面或记事本；设置里可以关。
- 右上"—"收起成头像，单击头像恢复；"×"关闭后双击桌面图标或点任务栏图标再打开。
- 网页核心循环（B1）：在页面里游戏以外的地方按键、点鼠标都算工作输入，底栏常驻总累计、本轮进度、金币和保存状态；路亚每 500 次、摸鱼每 200 次判定一次，周期末必出鱼；鱼进鱼篓，可放进收藏（一个鱼缸 20 条，可设为场景最底层的观赏鱼缸）、按体长卖金币，金币抽皮肤、装备。
- 策划答复接入（B2）：手竿按真实时间计，每张图满 30 分钟出 1 条（网页开着、收起照计，关闭或切走停，两次检查隔了 5 分钟以上那段不计，不补离线）；出鱼时头顶卡片加鱼篓上的新鱼数；记录页没抓到的鱼只显示"？"；设置里多了"置顶""后台输入"两个演示开关；界面文字按文案定稿接入。
- 同图房间（B3，本机模拟）：房间页可以创建或加入模拟房间，最多 4 人同图；只有房主能切图、全房一起去；好友断线立即释放位置、房主离开会迁移；场景主题和背景鱼缸跟房主；好友收获有头顶卡片和提示音（受静音控制）、可以只读看好友的背景鱼缸。都是本机模拟，刷新就结束，不连真实好友或 Steam，也不碰你自己的鱼和金币。
- 玩法档存在本浏览器的 IndexedDB，窗口偏好存在 localStorage；同站只有一个标签页能写，其他标签页只读。
- 地址加 `?dev=1` 时右上角有开发入口（注入鱼、+100 币、模拟保存失败、重置小窗），开发来源的鱼和金币在档里有标记；控制台另有 `moyuDev.skew(毫秒)`、`moyuDev.poleTick()` 拨手竿时间。
- 美术是开发方的临时素材；鱼名、外观名和界面文字已按文案定稿。

**PC 版（B4、B5，Electron）：** 透明无框小窗直接浮在真实桌面上，界面和玩法与网页同一份。

**PC 试玩包（B6）：** 每次推送 main 自动打包，下载地址固定：<https://github.com/etsevenday/zhuomianmoyu/releases/download/pc-latest/zhuomianmoyu-pc-win-x64.zip>（[发布页](https://github.com/etsevenday/zhuomianmoyu/releases/tag/pc-latest)写着是哪次提交）。解压后双击"桌面摸鱼/桌面摸鱼.exe"，不用装别的；没签名，第一次打开点"更多信息 → 仍要运行"。存档在 `%APPDATA%\moyu-pc`，换新包不丢，和本地 `npm start` 是同一份。

- 留白处鼠标穿透到下层软件（设置里可关）；按住小熊或水面拖动窗口；右下角拖动自由缩放，锁 16:9，最小 400×225，记住占屏比例，换屏、改分辨率、重启都按它恢复。
- 收起成头像、置顶真实生效；关闭就是存档后退出程序；只能开一个。
- 窗口设置存在数据目录的 `window.json`，和玩法存档分开。
- 后台输入（B5）：默认开（设置里可关，关过重启仍关），在别的软件（包括浏览器）里每按下一次键、点一次鼠标都算一次，和网页版页面里的口径一样；点小窗自己、小窗在前台时打字不算。关着时什么都不采；设置里显示实际状态（正在采集 / 尚未采集 / 已关闭）。只数次数，不记按了什么、点在哪个软件。
- 还没有：Steam 联机、安装包、签名和自动升级。

## 工程结构

```
src/Core/                纯 C# 内核，不依赖 UnityEngine；同时是一个 Unity 本地包（com.moyu.core）
  Desktop/               桌面与小窗几何（16:9、1/4 宽高、工作区夹取、收起头像）
  Scene/                 画布坐标、三模式、三张地图的岸边/浅水区域、选位与自动安排
  State/ Engine/         小窗状态、面板、设置保存与恢复
  Play/                  玩法：捕获节点、可重建随机数、临时鱼表与鱼价、档案、收藏、出售、皮肤抽取与装备
web/Moyu.Core/           .NET 类库，编译 src/Core 的源码
web/Moyu.Core.Tests/     NUnit：第一阶段可在内核判定的验收（UI、SPACE、CONTENT 等编号）
web/Moyu.Web/            Blazor WebAssembly 网页壳：模拟桌面、小窗、面板；手势在 wwwroot/js/pet.js，工作输入、存档、写权在 wwwroot/js/play.js
pc/                      PC 外壳（Electron）：src/main.js 窗口、穿透与后台输入转发，src/layout.js 窗口尺寸计算，input/ 后台输入采集程序（C#，Raw Input），build-web.mjs 把网页发布进来，pack.mjs 打试玩包
tools/verify/            浏览器验收脚本（零依赖 Node + CDP），每批一个，对应 doc/测试用例/ 的用例表；b4.mjs 启动 Electron 测
```

将来接 Unity：在 Unity 工程的 `Packages/manifest.json` 里加 `"com.moyu.core": "file:../../src/Core"`。

本地运行需要 .NET 8 SDK：`dotnet test web/Moyu.sln`；`dotnet run --project web/Moyu.Web --launch-profile http`（http://localhost:5188）。PC 版：`cd pc && npm install && npm run build && npm start`（`build` = 网页包 + 采集程序；采集程序要 .NET 8 运行时）（`node_modules/electron/dist` 没下来时补 `node node_modules/electron/install.js`）。浏览器验收需要 Node 22+ 和 Chrome/Edge：推送前跑 `node tools/verify/b4.mjs --release`（PC 窗口，要先 `cd pc && npm install`，不占鼠标键盘）；`b5.mjs`（后台输入，开记事本发真实按键点击）和 `b6.mjs`（打包后用包跑 b4、b5）由 CI 在 GitHub 的 Windows 机器上跑，过了才发布 PC 试玩包，本机要跑时别动鼠标键盘，回归 `b3.mjs`、`b2.mjs`、`b1.mjs`、`b0.mjs`（都带 `--release`）（照 CI 发布本地 Release 包再测）；也可给开发服务器网址，不给网址就测线上。改了内核还要跑变异测试：`dotnet tool restore` 后在 `web/Moyu.Core.Tests` 里 `dotnet stryker --since:origin/main`（见测试用例准则 §5）。

## 分工

| 角色 | GitHub 账号 | 负责什么 | 怎么提交 |
| --- | --- | --- | --- |
| 开发方 | [etsevenday](https://github.com/etsevenday) | 代码、配置、网页、开发记录；按策划案实现，有缺口写进待确认问题 | Claude Code |
| 策划 | [dotpad1994](https://github.com/dotpad1994) | 玩法、UI 布局与流程、数值；答复开发方的待确认问题 | Codex，约定见 [AGENTS.md](AGENTS.md) |
| 文案策划 | [shioko0315](https://github.com/shioko0315) | 世界观、人物、剧情和一切玩家可见文字，规则见 [文案设计归属与修改规则](<doc/策划案/00 总则/05 文案设计归属与修改规则.md>) | GitHub issue 答复，或经 Codex 推送 |

## 目录

- `doc/策划案/`：策划案，只由策划（经 Codex）增改；开发方只在里面补【实现同步】句子和文末「修改记录」。
  - `00 总则/02 开发方待确认问题.md`：开发方提问、策划答复的唯一位置；已结案的整节移到 `02a 开发方待确认问题归档.md`。
  - `00 总则/系统策划案模板.md`：新系统策划案照它写。
- `doc/开发记录/`：开发方每个批次一份记录（工程映射、开发假设、实施记录与偏差、验收结论）。
- `doc/测试用例/`：开发方每个批次一份用例表（从验收编号推出、写明执行方式、只按真实运行填结果），规则见 [测试用例准则](<doc/测试用例/00 测试用例准则.md>)；开发方工作约定见 [CLAUDE.md](CLAUDE.md)。
- `doc/画面巡检/`：开发方每批推送前跑 `node tools/verify/shots.mjs --release` 截固定一套画面（网页三档尺寸 + PC 小窗）、逐张看图，记下发现的画面问题和处理；CI 每次推送也截一套，存成那次运行的 `shots` 附件。

## GitHub 上的提醒

- 标签 `待策划确认`：开发方等策划答复，指派 dotpad1994。
- 标签 `待文案确认`：开发方等文案策划答复，指派 shioko0315。
