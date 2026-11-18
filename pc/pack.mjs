// 打 PC 试玩包：pc/dist/zhuomianmoyu-pc-win-x64.zip。解开是一个"桌面摸鱼"文件夹，双击 桌面摸鱼.exe 就能玩，
// 不用装 Node、.NET：Electron 运行时整个带上，采集程序按自带运行时的单个 exe 发布。
// 包里：Electron 运行时（exe 改名，只留中文、英文语言包，去掉自带的默认页）+ resources/app（外壳 src/、package.json、
// 网页 Release 包 .web/wwwroot、采集程序 .input/MoyuInput.exe），路径和开发时一样，外壳不用分两种找法。
// 包名用英文：GitHub Releases 不认中文文件名。构建号"PC 试玩版 · <UTC 日期> · <提交>"。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PC = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(PC, 'dist');
const NAME = '桌面摸鱼';
const STAGE = path.join(DIST, NAME);
const APP = path.join(STAGE, 'resources', 'app');
const ZIP = path.join(DIST, 'zhuomianmoyu-pc-win-x64.zip');
const ELECTRON = path.join(PC, 'node_modules', 'electron', 'dist');
const LOCALES = ['zh-CN.pak', 'en-US.pak'];

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: PC, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败`);
};

if (!fs.existsSync(path.join(ELECTRON, 'electron.exe'))) throw new Error('没有 Electron 运行时：先 npm install，再 node node_modules/electron/install.js');
fs.rmSync(DIST, { recursive: true, force: true });

run(process.execPath, ['build-web.mjs'], { env: { ...process.env, MOYU_BUILD_PREFIX: `PC 试玩版 · ${new Date().toISOString().slice(0, 10)}` } });

console.log('复制 Electron 运行时……');
fs.cpSync(ELECTRON, STAGE, {
  recursive: true,
  filter: src => {
    const rel = path.relative(ELECTRON, src);
    if (rel === path.join('resources', 'default_app.asar')) return false;
    if (path.dirname(rel) === 'locales') return LOCALES.includes(path.basename(rel));
    return true;
  },
});
fs.renameSync(path.join(STAGE, 'electron.exe'), path.join(STAGE, `${NAME}.exe`));

console.log('放外壳和网页包……');
const pkg = JSON.parse(fs.readFileSync(path.join(PC, 'package.json'), 'utf8'));
fs.mkdirSync(APP, { recursive: true });
// 名字不变：数据目录（%APPDATA%\moyu-pc）和开发时 npm start 是同一个
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: pkg.name, description: pkg.description, main: pkg.main }, null, 2));
fs.cpSync(path.join(PC, 'src'), path.join(APP, 'src'), { recursive: true });
fs.cpSync(path.join(PC, '.web', 'wwwroot'), path.join(APP, '.web', 'wwwroot'), { recursive: true });

console.log('发布采集程序（自带运行时）……');
run('dotnet', ['publish', 'input', '-c', 'Release', '-r', 'win-x64', '--self-contained', '-p:PublishSingleFile=true',
  '-p:EnableCompressionInSingleFile=true', '-p:DebugType=none', '-o', path.join(APP, '.input'), '--nologo', '-v', 'q']);

console.log('压缩……');
// 资源管理器能认的 zip：.NET 的 ZipFile 写 UTF-8 文件名并打上标记，中文名解开不乱码。路径经环境变量传，不经命令行转义
run('powershell', ['-NoProfile', '-Command',
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:PACK_SRC, $env:PACK_ZIP, 'Optimal', $true)"],
  { env: { ...process.env, PACK_SRC: STAGE, PACK_ZIP: ZIP } });
console.log(`完成：${ZIP}（${(fs.statSync(ZIP).size / 1048576).toFixed(1)} MB）`);
