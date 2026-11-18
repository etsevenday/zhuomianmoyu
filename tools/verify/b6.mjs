// B6 PC 试玩包验收：node tools/verify/b6.mjs [--release] [--online] [输出目录]
// 本地：pc/pack.mjs 打包；--online：下载 Releases 上 pc-latest 的包（README 里的固定地址），构建号要等于 origin/main。
// 用资源管理器同一套解压（Shell.Application）解开，查包内容；以正常模式启动包里的 桌面摸鱼.exe（只换数据目录），
// 看载入、构建号、采集程序自带运行时；再让 b4、b5 改测这个包（MOYU_PC_APP）。b5 发系统层面的输入，跑的时候不要动鼠标键盘。
// --online 不重跑 b4、b5：线上的包就是 CI 发布前刚用它们测过的那个 zip。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './b4.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PC = path.join(REPO, 'pc');
const ONLINE = process.argv.includes('--online');
const out = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(os.tmpdir(), 'moyu-b6'));
const ZIP_NAME = 'zhuomianmoyu-pc-win-x64.zip';
const URL_ = `https://github.com/etsevenday/zhuomianmoyu/releases/download/pc-latest/${ZIP_NAME}`;
fs.mkdirSync(out, { recursive: true });

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail !== '' ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
const git = args => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const ps = (script, env = {}) => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
};
const exists = p => fs.existsSync(p);

/** 资源管理器"全部解压缩"同一套：Shell.Application 的 CopyHere。等到文件数和 zip 里一样。 */
function shellExtract(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead($env:X_ZIP); $want = @($z.Entries | Where-Object { $_.Name }).Count; $z.Dispose()
$sh = New-Object -ComObject Shell.Application
$sh.NameSpace($env:X_DEST).CopyHere($sh.NameSpace($env:X_ZIP).Items(), 0x614)
$end = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $end -and @(Get-ChildItem -LiteralPath $env:X_DEST -Recurse -File -Force).Count -lt $want) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 2`, { X_ZIP: zip, X_DEST: dest });
}

let fatal = null, build_ = null;
const errorsSeen = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-b6-'));

async function run() {
  // ── 拿到包 ──
  let zip, want;
  if (ONLINE) {
    spawnSync('git', ['fetch', 'origin', 'main', '--tags', '--force', '-q'], { cwd: REPO, stdio: 'inherit' });
    // 只改文档、工具的推送不构建，所以对的是 main 上最近一次跑成功的工作流，不是 main 的最新提交
    const r = spawnSync('gh', ['run', 'list', '--workflow', 'pages.yml', '--branch', 'main', '--status', 'success', '-L', '1', '--json', 'headSha', '--jq', '.[0].headSha'],
      { cwd: REPO, encoding: 'utf8' });
    const built = r.stdout.trim();
    const tag = git(['rev-parse', 'refs/tags/pc-latest^{commit}']);
    const onMain = spawnSync('git', ['merge-base', '--is-ancestor', tag, 'origin/main'], { cwd: REPO }).status === 0;
    check('B6-07 pc-latest 标签指向 main 上最近一次跑成功的工作流的提交', !!built && tag === built && onMain, { tag, built, onMain });
    want = built.slice(0, 7);
    zip = path.join(tmp, ZIP_NAME);
    const res = await fetch(URL_);
    if (!res.ok) throw new Error(`下载失败 ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    check('B6-08 固定下载地址直接下到包', res.ok && fs.statSync(zip).size > 0, { url: URL_, size: fs.statSync(zip).size });
  } else {
    const r = spawnSync(process.execPath, [path.join(PC, 'pack.mjs')], { cwd: PC, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('打包失败');
    want = git(['rev-parse', '--short=7', 'HEAD']) + (git(['status', '--porcelain', '--', 'src', 'web', 'pc/src']) ? '+改动' : '');
    zip = path.join(PC, 'dist', ZIP_NAME);
  }
  const size = fs.statSync(zip).size;
  check('B6-05 包不超过 200 MB', size <= 200 * 1048576, `${(size / 1048576).toFixed(1)} MB`);

  // ── B6-01 包的结构 ──
  const x = path.join(tmp, 'x');
  shellExtract(zip, x);
  const top = fs.readdirSync(x);
  const root = path.join(x, '桌面摸鱼');
  const exe = path.join(root, '桌面摸鱼.exe');
  const app = path.join(root, 'resources', 'app');
  const need = ['package.json', 'src/main.js', 'src/preload.js', 'src/layout.js', '.web/wwwroot/index.html', '.input/MoyuInput.exe'];
  const missing = need.filter(f => !exists(path.join(app, f)));
  const extra = ['resources/default_app.asar', 'resources/app/node_modules', 'resources/app/input', 'resources/app/build-web.mjs', 'resources/app/pack.mjs', 'electron.exe']
    .filter(f => exists(path.join(root, f)));
  const locales = exists(path.join(root, 'locales')) ? fs.readdirSync(path.join(root, 'locales')).sort() : [];
  const pkg = exists(path.join(app, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')) : {};
  // zip 条目名按规范用 /；条目数和解开的文件数一样（资源管理器没丢东西）
  const names = JSON.parse(ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead($env:X_ZIP); ConvertTo-Json -Compress @($z.Entries | ForEach-Object { $_.FullName }); $z.Dispose()`, { X_ZIP: zip }));
  const backslash = names.filter(n => n.includes('\\')).length;
  const files = fs.readdirSync(x, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).length;
  check('B6-01 资源管理器解开是"桌面摸鱼"文件夹和 桌面摸鱼.exe；外壳、网页包、采集程序都在；没有默认页和开发用的东西；条目名用 /',
    top.length === 1 && top[0] === '桌面摸鱼' && exists(exe) && missing.length === 0 && extra.length === 0
    && locales.join() === 'en-US.pak,zh-CN.pak' && pkg.name === 'moyu-pc' && pkg.main === 'src/main.js'
    && backslash === 0 && files === names.length,
    { top, missing, extra, locales, pkg, entries: names.length, files, backslash });

  // ── B6-02、B6-03 正常模式启动 ──
  const userData = path.join(tmp, 'data');
  fs.mkdirSync(userData);
  const p = await launch({ userData, input: null, test: false, app: [exe, []], port: 9356 });
  try {
    await sleep(1500);
    const page = await p.ev(`({ title: document.title, build: document.querySelector('meta[name=app-build]')?.content,
      dev: typeof window.moyuDev, test: typeof window.moyuPc?.test, pc: !!window.moyuPc,
      save: document.querySelector('[data-stat=save]')?.innerText.trim() ?? null })`);
    build_ = page.build;
    const m = /^PC 试玩版 · (\d{4}-\d{2}-\d{2}) · (.+)$/.exec(page.build || '');
    check('B6-02 正常模式载入：标题"桌面摸鱼"、构建号"PC 试玩版 · 日期 · 提交号"是这次提交、没有开发和测试入口、存档已保存',
      page.title === '桌面摸鱼' && m && m[2] === want && page.dev === 'undefined' && page.test === 'undefined' && page.pc
      && (page.save === null || page.save === '已保存'), { ...page, want });

    // 采集程序：全新数据目录默认开。找包里那个 MoyuInput 进程，看它载入的模块
    let cap = null;
    for (let i = 0; i < 40 && !cap; i++) {
      const j = ps(`$p = Get-CimInstance Win32_Process -Filter "Name='MoyuInput.exe'" | Where-Object { $_.ExecutablePath -like ($env:X_APP + '*') } | Select-Object -First 1
if ($p) { @{ pid = $p.ProcessId; path = $p.ExecutablePath; modules = @((Get-Process -Id $p.ProcessId).Modules | ForEach-Object { $_.FileName }) } | ConvertTo-Json -Compress }`,
        { X_APP: app });
      if (j) cap = JSON.parse(j); else await sleep(250);
    }
    const input = JSON.parse(fs.readFileSync(path.join(userData, 'input.json'), 'utf8'));
    const system = (cap?.modules || []).filter(f => /\\dotnet\\(shared|host)\\/i.test(f) || /\\(coreclr|hostfxr|hostpolicy|clrjit)\.dll$/i.test(f));
    const inputDir = fs.readdirSync(path.join(app, '.input'));
    check('B6-03 采集程序默认开着跑起来；单个 exe、自带运行时，没载入系统装的 .NET',
      cap && input.on === true && inputDir.join() === 'MoyuInput.exe' && system.length === 0,
      { pid: cap?.pid, modules: cap?.modules?.length, system, inputDir, input });
    errorsSeen.push(...p.errors);
  } finally {
    await p.kill();
  }

  // ── B6-04 用包跑 b4、b5 ──（线上包就是 CI 发布前刚跑过 b4、b5 的那个 zip，线上确认不重跑，不占开发机的鼠标键盘）
  if (ONLINE) return;
  const suite = async name => {
    const dir = path.join(out, name);
    const r = await new Promise(ok => spawn(process.execPath, [path.join(REPO, 'tools/verify', `${name}.mjs`), '--release', dir],
      { stdio: 'inherit', env: { ...process.env, MOYU_PC_APP: exe } }).once('exit', ok));
    const j = JSON.parse(fs.readFileSync(path.join(dir, `${name}-results.json`), 'utf8'));
    return { code: r, passed: j.passed, failed: j.failed, fatal: !!j.fatal, build: j.build };
  };
  const b4 = await suite('b4');
  const b5 = await suite('b5');
  check('B6-04 用包里的 exe 跑 b4、b5 全部通过', b4.code === 0 && b5.code === 0 && b4.failed === 0 && b5.failed === 0 && b4.build === build_ && b5.build === build_,
    { b4, b5 });
}

function staticChecks() {
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/pages.yml'), 'utf8').replace(/\r\n/g, '\n');
  const job = /\n  pc:\n([\s\S]*?)(?=\n  \w[\w-]*:\n|$)/.exec(wf)?.[1] || '';
  const ignore = /paths-ignore:\n((?:\s+(?:- .*|#.*)\n)+)/.exec(wf)?.[1] || '';
  const top = /\npermissions:\n((?:  .*\n)+)/.exec(wf)?.[1] || '';
  const ok = {
    trigger: /on:\n  push:\n    branches: \[main\]/.test(wf) && !/pc\//.test(ignore),
    afterTests: /needs: build/.test(job) && /runs-on: windows-/.test(job),
    pack: /node tools\/verify\/b6\.mjs --release/.test(job) && /electron\/install\.js/.test(job)
      && job.indexOf('b6.mjs') < job.indexOf('name: 发布到 Releases'),
    release: /pc-latest/.test(job) && /--clobber/.test(job) && new RegExp(ZIP_NAME.replace(/\./g, '\\.')).test(job) && /git push -f origin .*refs\/tags\/pc-latest/.test(job) && /GITHUB_SHA/.test(job),
    perms: /contents: write/.test(job) && /contents: read/.test(top) && (wf.match(/contents: write/g) || []).length === 1,
  };
  // 发布那一步的脚本真用 bash 跑一遍（git、gh 换成桩，只记下发出去的标题和说明）：引号写错这类问题静态看不出来
  const step = /name: 发布到 Releases[\s\S]*?run: \|\n((?: {10}.*\n|\n)+)/.exec(wf + '\n')?.[1].replace(/^ {10}/gm, '') || '';
  const sh = path.join(tmp, 'release.sh');
  fs.writeFileSync(sh, step);
  // 用 Git 自带的 bash（Windows 上 PATH 里的 bash 可能是 WSL 的）
  const bash = process.platform === 'win32'
    ? path.resolve(git(['--exec-path']), '../../../bin/bash.exe') : 'bash';
  const dry = spawnSync(bash, ['-e', '-o', 'pipefail', '-c',
    'git(){ :; }; gh(){ [ "$2" = view ] && return 1; printf "%s\\n" "$6" "$8"; }; source "$1"', 'dry', sh.replace(/\\/g, '/')],
    { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'abc1234def', GITHUB_REPOSITORY: 'etsevenday/zhuomianmoyu' } });
  ok.script = dry.status === 0 && dry.stdout.startsWith('PC 试玩版 abc1234\n') && dry.stdout.includes(URL_)
    && dry.stdout.includes('"更多信息 → 仍要运行"') && dry.stdout.includes('%APPDATA%\\moyu-pc');
  check('B6-06 工作流：推 main 触发，内核测试过了才在 Windows 上打包并用包跑 b6（含 b4、b5），过了才发到 pc-latest（挪标签、替换包、写提交号），只有它能写仓库；发布脚本试跑出的标题、说明对',
    Object.values(ok).every(Boolean), { ...ok, dry: dry.stdout || dry.stderr });
}

try {
  staticChecks();
  await run();
  check('B6 正常模式控制台没有报错', errorsSeen.length === 0, errorsSeen.slice(0, 5));
} catch (e) {
  fatal = String(e?.stack || e);
  console.error('脚本中断：', fatal);
}
const failed = results.filter(r => !r.pass).length;
const file = path.join(out, 'b6-results.json');
fs.writeFileSync(file, JSON.stringify({ build: build_, online: ONLINE, time: new Date().toISOString(), passed: results.length - failed, failed, fatal, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} 通过${fatal ? '（脚本中断）' : ''}；构建 ${build_}；结果 ${file}`);
process.exit(failed || fatal ? 1 : 0);
