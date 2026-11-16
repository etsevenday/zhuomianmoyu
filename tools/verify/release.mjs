// 本地 Release 发布包：照 .github/workflows/pages.yml 的方式发布并改写，再挂在和线上一样的子路径下提供。
// 推送前用它跑验收脚本，覆盖开发版测不到的差异：IL 裁剪、子路径 base href、资源版本号、404 回落。
// 各批验收脚本共用：const rel = await startRelease(); ...; rel.close();
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUBPATH = '/zhuomianmoyu/'; // 和 GitHub Pages 上的仓库名一致
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.dat': 'application/octet-stream', '.pdb': 'application/octet-stream',
};

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** 发布 Release 包并在 http://127.0.0.1:<port>/zhuomianmoyu/ 提供；返回 { url, build, close }。 */
export async function startRelease({ port = Number(process.env.RELEASE_PORT || 5199) } = {}) {
  const outDir = path.join(os.tmpdir(), 'moyu-release');
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('发布 Release 包……');
  const pub = spawnSync('dotnet', ['publish', 'web/Moyu.Web', '-c', 'Release', '-o', outDir], { cwd: REPO, encoding: 'utf8' });
  if (pub.status !== 0) throw new Error('dotnet publish 失败：\n' + (pub.stdout || '') + (pub.stderr || ''));

  // 与 pages.yml「适配 Pages 子路径」一步相同的改写；构建号标成"本地 Release"，便于和线上区分
  const root = path.join(outDir, 'wwwroot');
  const indexPath = path.join(root, 'index.html');
  const sha = git(['rev-parse', '--short=7', 'HEAD']) + (git(['status', '--porcelain', '--', 'src', 'web']) ? '+改动' : '');
  const build = `本地 Release · ${sha}`;
  let html = fs.readFileSync(indexPath, 'utf8')
    .replace('<base href="/" />', `<base href="${SUBPATH}" />`)
    .replace('<meta name="app-build" content="本地开发版" />', `<meta name="app-build" content="${build}" />`)
    .replaceAll('?v=dev', '?v=local');
  if (!html.includes(`<base href="${SUBPATH}" />`)) throw new Error('index.html 里没找到要改写的 base href');
  fs.writeFileSync(indexPath, html);
  fs.copyFileSync(indexPath, path.join(root, '404.html'));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send404 = () => { res.writeHead(404, { 'Content-Type': MIME['.html'] }); fs.createReadStream(path.join(root, '404.html')).pipe(res); };
    if (!url.pathname.startsWith(SUBPATH)) return send404();
    let rel = decodeURIComponent(url.pathname.slice(SUBPATH.length)) || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root)) return send404();
    fs.stat(file, (err, st) => {
      if (err) return send404();
      const target = st.isDirectory() ? path.join(file, 'index.html') : file;
      if (!fs.existsSync(target)) return send404();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(target).pipe(res);
    });
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', ok); });
  return { url: `http://127.0.0.1:${port}${SUBPATH}`, build, close: () => server.close() };
}
