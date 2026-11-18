# Steam 联机小实验

[NET-EVAL-001 真实联机接入评估](<../../doc/开发记录/NET-EVAL-001 真实联机接入评估.md>) 的第一步：用 Steam 公用测试 ID 480，在两台互为好友、不在同一局域网的电脑之间验证建房、邀请、房间数据和成员数据同步、消息往返延迟、连发丢包、换房主。不进游戏，也不在 `web/Moyu.sln` 里。

- 房主（开发方）：`dotnet run -c Release -- host`，建仅好友房间，等好友打开本程序后只邀请这一位，然后自动跑完全部测试。
- 加入方（策划）：双击 `SteamSpike.exe`（不带参数），等邀请、自动进房、配合测试。
- 两边都要先开 Steam 并登录；运行时 Steam 好友列表里显示在玩"Spacewar"（480 的名字）。
- 结果写在程序旁边的 `steam-spike-<身份>-<时间>.txt`。

打包给加入方：`dotnet publish -c Release -r win-x64 --self-contained true -o <目录>`，压缩成 zip 发到 GitHub Releases（对方不用装 .NET）。

480 的限制：对方没开着本程序时点邀请会启动 Valve 的 Spacewar 而不是本程序，所以两边都要先开着。换成自己的 App ID 后没有这个问题。
