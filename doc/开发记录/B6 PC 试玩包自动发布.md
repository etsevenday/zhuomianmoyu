# B6 PC 试玩包自动发布

日期：2026-11-18　|　依据：用户要求"每次提交后 GitHub Actions 自动打包发布"PC 版，给策划试玩。没有策划案。
用例：[B6 PC 试玩包自动发布](<../测试用例/B6 PC 试玩包自动发布.md>)。

不做：安装包、代码签名、自动升级、Steam。

## 1. 做了什么

| 部分 | 实现 |
| --- | --- |
| 打包（`pc/pack.mjs`） | 网页 Release 包（构建号"PC 试玩版 · <UTC 日期> · <提交>"）+ Electron 运行时（`electron.exe` 改名 `桌面摸鱼.exe`，只留中文、英文语言包，去掉自带的默认页）+ `resources/app`（外壳 `src/`、精简的 `package.json`、`.web/wwwroot`、`.input/MoyuInput.exe`）。目录和开发时一样，外壳不用分两种找法。打成 `pc/dist/zhuomianmoyu-pc-win-x64.zip`，解开是一个"桌面摸鱼"文件夹 |
| 采集程序自带运行时 | 打包时按 `win-x64` 自带运行时、单个 exe、压缩发布（约 34 MB），玩家不用装 .NET。开发时 `npm run build:input` 照旧按依赖框架发布，快 |
| 自动发布（`.github/workflows/pages.yml` 的 `pc` 任务） | 推 main 时、内核测试（`build` 任务）过了以后，在 `windows-2022` 上装 Electron、跑 `tools/verify/b6.mjs --release`（打包、解开、正常启动、用包跑 b4 和 b5），全过了才发到固定的 Releases `pc-latest`；验收结果作为 `pc-verify` 附件留在那次运行里：标签强推到这次提交，`--clobber` 替换包，标题和说明写提交号。和网页发布并行，互不等待。只有这个任务有 `contents: write` |
| 下载地址 | `https://github.com/etsevenday/zhuomianmoyu/releases/download/pc-latest/zhuomianmoyu-pc-win-x64.zip`，固定不变 |
| 数据目录 | 包里 `package.json` 的名字不变（`moyu-pc`），存档在 `%APPDATA%\moyu-pc`，换新包不丢，和本地 `npm start` 是同一份 |

## 2. 取舍

- **滚动的一个发布，不是每次提交一个**：策划只要"最新的"，地址固定好记；每次一个会堆出几百个 170 MB 的发布。要回看旧版本时看 Actions 的提交记录，本地按那个提交 `node pc/pack.mjs` 重打。
- **自己拼目录，不用 electron-builder / packager**：要的就是"运行时 + app 文件夹 + 改名"，自己拼几十行，不多一个依赖；exe 图标和版本信息还是 Electron 的，试玩够用，做安装包时再换。
- **包名用英文**：GitHub Releases 会把中文文件名改掉；包里面的文件夹和 exe 用中文，zip 用 .NET 的 `ZipFile` 写（UTF-8 文件名带标记），资源管理器解开不乱码（B6-01 用资源管理器同一套解压验证）。
- **体积**：约 174 MB，大头是 Electron 45 自己（exe 约 250 MB）。去掉其他语言包省约 48 MB；再小要换外壳技术，不值得。
- **b5 放到 CI 上跑**（用户 2026-11-18 定）：b5 要往记事本发真实按键点击，本机跑时 7 分钟不能碰鼠标键盘、还会被聊天应用的通知打扰。GitHub 的 Windows 机器有自己的桌面，SendInput、Raw Input、记事本都能用；放在发布前面还能挡住坏包。固定 windows-2022：b5 读经典记事本 Edit 控件里的字数。代价是每次推送 CI 多十来分钟。只改 `tools/` 的推送不触发工作流，要验证时手动 `gh workflow run pages.yml`。
- **测试模式开关还在包里**：`MOYU_TEST` 等环境变量在包里照样认，正常双击不会带上；这样 b4、b5 能直接测打好的包。

## 3. 测试方法

`tools/verify/b6.mjs`：本地打包（或 `--online` 下载线上的包），用 `Shell.Application`（资源管理器"全部解压缩"同一套）解开，查结构；只换数据目录、不开测试模式启动包里的 exe，查构建号、开发入口、采集程序进程和它载入的模块（没有系统装的 .NET）；再设 `MOYU_PC_APP` 让 b4、b5 改测包里的 exe（不重新发布，直接用包里的网页包和采集程序）。

干净电脑（没装 .NET、Node）上下载双击只能人工（B6-M1）。

## 4. 测试结果

推送前（6ece00e+改动）：`b6.mjs --release` 7/7，用包跑 `b4` 26/26、`b5` 18/18。调试中 b5 两类失败都是测试环境（Claude 桌面应用的通知盖住小窗、测试中真鼠标被动过），见[用例表](<../测试用例/B6 PC 试玩包自动发布.md>)"本轮失败归类"；为此发送器加了"有人在动鼠标就停"的检查。网页、内核没改，不跑 b0—b3 和变异测试。人工 B6-M1（干净电脑）还没做。

上线后：第一次发布的 89fa682 包缺外壳和网页包（CI 的 Node 22 `cpSync` 没复制），修好后把 b4、b5 搬到 CI 上用包跑、过了才发。CI（windows-2022）a1a2b09：b6 7/7（b4 26/26、b5 18/18），发布；线上确认 `b6.mjs --online` 8/8（b4、b5 不在线上重跑）。网页版构建号同为 a1a2b09。

在开发机上跑 b5 时开发方不要往聊天里发消息：Claude 桌面应用会在右下角弹通知，盖住小窗。平时 b5 交给 CI。
