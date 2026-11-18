// 把网页版发布成 Release 包放到 pc/.web，外壳从这里加载。构建号写成"PC 本地 · <提交>"；
// 打试玩包时 pack.mjs 用 MOYU_BUILD_PREFIX 换掉"PC 本地"（"PC 试玩版 · <日期>"）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PC = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(PC, '..');
const OUT = path.join(PC, '.web');

const git = args => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

fs.rmSync(OUT, { recursive: true, force: true });
console.log('发布网页 Release 包……');
const pub = spawnSync('dotnet', ['publish', 'web/Moyu.Web', '-c', 'Release', '-o', OUT], { cwd: REPO, encoding: 'utf8' });
if (pub.status !== 0) {
  console.error(pub.stdout, pub.stderr);
  process.exit(1);
}
const index = path.join(OUT, 'wwwroot', 'index.html');
const sha = git(['rev-parse', '--short=7', 'HEAD']) + (git(['status', '--porcelain', '--', 'src', 'web', 'pc/src']) ? '+改动' : '');
const html = fs.readFileSync(index, 'utf8')
  .replace('<meta name="app-build" content="本地开发版" />', `<meta name="app-build" content="${process.env.MOYU_BUILD_PREFIX || 'PC 本地'} · ${sha}" />`)
  .replace('<title>桌面摸鱼 · 网页试玩</title>', '<title>桌面摸鱼</title>')
  .replaceAll('?v=dev', '?v=pc');
fs.writeFileSync(index, html);
console.log('完成：', path.join(OUT, 'wwwroot'));
