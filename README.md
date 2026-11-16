# 桌面摸鱼

Windows 桌面上的透明小窗伙伴：一边工作一边让小熊在角落钓鱼、摸鱼。协作方式和开发方式都沿用《适者生存》（[etsevenday/shizheshengcun](https://github.com/etsevenday/shizheshengcun)）：先做网页版，纯 C# 内核，以后用 Unity 出 PC 端。

**网页试玩：** https://etsevenday.github.io/zhuomianmoyu/（推到 main 后自动发布）

- 整页是一块按 16:9 等比缩放的**模拟桌面**（壁纸、桌面图标、记事本、任务栏），游戏小窗浮在上面，宽高各占桌面的 1/4。
- 按住小熊或水面拖动小窗；单击岸边（路亚、手竿）或浅水（摸鱼）给小熊换位置，放不下就留在原处。
- 透明区穿透默认开：点小窗留白处，点击落到下面的桌面或记事本；设置里可以关。
- 右上"—"收起成头像，单击头像恢复；"×"关闭后双击桌面图标或点任务栏图标再打开。
- 地址加 `?dev=1` 时右上角有开发入口（模拟鱼获、重置小窗）。
- 第一阶段只有窗口与界面骨架：没有捕鱼计数和结算，面板里的鱼是示例数据；界面文字和美术都是占位。

## 工程结构

```
src/Core/                纯 C# 内核，不依赖 UnityEngine；同时是一个 Unity 本地包（com.moyu.core）
  Desktop/               桌面与小窗几何（16:9、1/4 宽高、工作区夹取、收起头像）
  Scene/                 画布坐标、三模式、三张地图的岸边/浅水区域、选位与自动安排
  State/ Engine/         小窗状态、面板、设置保存与恢复
web/Moyu.Core/           .NET 类库，编译 src/Core 的源码
web/Moyu.Core.Tests/     NUnit：第一阶段可在内核判定的验收（UI、SPACE、CONTENT 等编号）
web/Moyu.Web/            Blazor WebAssembly 网页壳：模拟桌面、小窗、面板；手势在 wwwroot/js/pet.js
```

将来接 Unity：在 Unity 工程的 `Packages/manifest.json` 里加 `"com.moyu.core": "file:../../src/Core"`。

本地运行需要 .NET 8 SDK：`dotnet test web/Moyu.sln`；`dotnet run --project web/Moyu.Web --launch-profile http`（http://localhost:5188）。

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

## GitHub 上的提醒

- 标签 `待策划确认`：开发方等策划答复，指派 dotpad1994。
- 标签 `待文案确认`：开发方等文案策划答复，指派 shioko0315。
