/* 启动本地联调服务器（供后台任务使用） */
import { spawn } from 'node:child_process'

const env = Object.assign({}, process.env, {
  PORT: process.env.PORT || '8787',
  NODE_ENV: 'development'
})

const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: 'D:\\清理\\server',
  env,
  stdio: 'inherit'
})

child.on('exit', code => {
  console.log('[launcher] server exited with', code)
})
