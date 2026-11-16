# 桌面摸鱼

项目刚建仓，玩法、技术栈都还没定。协作方式沿用《适者生存》（[etsevenday/shizheshengcun](https://github.com/etsevenday/shizheshengcun)）那套。

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
- `doc/开发记录/`：开发方每个批次一份记录（开始开发后建立）。

## GitHub 上的提醒

- 标签 `待策划确认`：开发方等策划答复，指派 dotpad1994。
- 标签 `待文案确认`：开发方等文案策划答复，指派 shioko0315。
