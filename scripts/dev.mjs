// 一键本地联调：同时启动 Vite 开发服务器（前端热更新）与 wrangler dev（Worker 代码变更自动重载）。
// 访问 http://localhost:5173：前端 HMR 生效，/api 由 Vite 代理到 wrangler 的 8787（见 vite.config.js）。
// 说明：wrangler 的 [assets] 目录必须存在，故首次未构建时先自动跑一次 vite build。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
// Worker 端口默认 8787；端口被占用时可用 MI_API_PORT 覆盖（vite.config.js 的 /api 代理读同一变量）
const apiPort = process.env.MI_API_PORT || '8787';

if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.log('[dev] 未发现 dist/ 构建产物，先执行一次 vite build …');
  const built = spawnSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status || 1);
}

const children = [];
let stopping = false;

/** 结束子进程：Windows 需要连带子进程树（wrangler 会再拉起 workerd），其它平台发 SIGTERM。 */
function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 进程已退出 */
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 进程已退出 */
    }
  }
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) stopChild(child);
  process.exit(code);
}

function start(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
  });
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[dev] ${name} 已退出（code=${code}），正在停止其余进程`);
      shutdown(code || 1);
    }
  });
  children.push(child);
  return child;
}

start('wrangler', [wranglerBin, 'dev', '-c', 'worker/wrangler.toml', '--port', apiPort]);
start('vite', [viteBin]);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
