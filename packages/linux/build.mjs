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
  outfile: resolve(here, 'dist/googled.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: {
    // shebang + CJS 兼容 shim：undici 内部的动态 require（node:assert 等）在 ESM 里需要 createRequire
    js:
      '#!/usr/bin/env node\n' +
      "import { createRequire as __crequire } from 'node:module';\n" +
      'const require = __crequire(import.meta.url);\n'
  },
  define: { __VERSION__: JSON.stringify(version) },
  // undici / socks 是纯 JS，直接打进单文件，产物零运行时依赖
  packages: 'bundle',
  sourcemap: false,
  logLevel: 'info',
  legalComments: 'none'
})

const out = resolve(here, 'dist/googled.mjs')
chmodSync(out, 0o755)
console.log(`[googled-linux] 构建完成 v${version} → ${out}`)
