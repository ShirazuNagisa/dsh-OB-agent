/**
 * Single-file client + ESM host build for dsh-ob-agent.
 *
 * The web server serves exactly one file per plugin (/plugins/dsh-ob-agent/client.js),
 * so the client half is one CJS bundle wrapped in the ModuleLoader factory
 * handshake; @deepseek-ai/dsh-*, cordis, schemastery and react stay external
 * (the profile's node_modules and the app's module system provide them). The
 * host half is plain ESM for Node, externalizing the same DSH packages while
 * bundling zod (the projection and tool schemas resolve it locally).
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

mkdirSync('lib', { recursive: true })

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*', '@deepseek-ai/schemastery']

const host = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
}

await build({ ...host, entryPoints: ['src/index.ts'], outfile: 'lib/index.js' })

await build({ ...host, entryPoints: ['src/invariant.ts'], outfile: 'lib/invariant.js' })

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [...dshExternal, 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-ob-agent', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// 直接用 node 跑 typescript 的入口，避免依赖 node_modules/.bin 的 shell shim
// （Windows 上不同包管理器生成的 shim 命名不一致）。
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })
