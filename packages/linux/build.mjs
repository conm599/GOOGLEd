import * as esbuild from 'esbuild'
import { readFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 版本号统一以根 package.json 为准（CI bump 只动根包，win/linux 版本天然一致）
const version = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf-8')).version

mkdirSync(resolve(here, 'dist'), { recursive: true })

await esbuild.build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'dist/googled'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  // CJS：产物是无扩展名可执行文件，node 直跑时按 CJS 解析（ESM 需 .mjs 扩展名）
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(version) },
  // undici / socks 是纯 JS，直接打进单文件，产物零运行时依赖
  packages: 'bundle',
  sourcemap: false,
  logLevel: 'info',
  legalComments: 'none'
})

const out = resolve(here, 'dist/googled')
chmodSync(out, 0o755)
console.log(`[googled-linux] 构建完成 v${version} → ${out}`)
