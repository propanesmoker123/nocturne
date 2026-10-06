// Release Nocturne: bump the version, build a signed installer, write latest.json and
// (when the GitHub CLI is available) publish a GitHub release that installed copies
// pick up through the updater.
//
//   npm run release -- 0.2.0 "Что нового в этой версии"
//
// Signing key: TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) or %USERPROFILE%\.tauri\nocturne.key.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildManifest, repoFromEndpoint } from './manifest.mjs'

const root = resolve(import.meta.dirname, '..')
const [version, notes = ''] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Укажите версию: npm run release -- 0.2.0 "Что нового"')
  process.exit(1)
}

const confPath = join(root, 'src-tauri', 'tauri.conf.json')
const conf = JSON.parse(readFileSync(confPath, 'utf8'))
const repo = repoFromEndpoint(conf.plugins.updater.endpoints[0])
if (repo.startsWith('REPLACE_ME/')) {
  console.error('Сначала впишите свой GitHub в plugins.updater.endpoints в src-tauri/tauri.conf.json')
  process.exit(1)
}

// 1. Version everywhere.
conf.version = version
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`)
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = version
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
const cargoPath = join(root, 'src-tauri', 'Cargo.toml')
writeFileSync(cargoPath, readFileSync(cargoPath, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`))

// 2. Signed build.
const keyFile = join(homedir(), '.tauri', 'nocturne.key')
const env = { ...process.env }
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyFile)) {
    console.error(`Нет ключа подписи: ${keyFile}`)
    process.exit(1)
  }
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, 'utf8')
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= ''
const build = spawnSync('npx', ['tauri', 'build'], { cwd: root, env, stdio: 'inherit', shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

// 3. latest.json next to the installer.
const file = `Nocturne_${version}_x64-setup.exe`
const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const exe = join(bundleDir, file)
const signature = readFileSync(`${exe}.sig`, 'utf8')
const outDir = join(root, 'release', `v${version}`)
mkdirSync(outDir, { recursive: true })
const manifestPath = join(outDir, 'latest.json')
writeFileSync(manifestPath, `${JSON.stringify(buildManifest({ version, notes, pubDate: new Date(), repo, file, signature }), null, 2)}\n`)
console.log(`\nУстановщик: ${exe}\nМанифест:   ${manifestPath}`)

// 4. Publish (needs `gh auth login` once). GH_PATH, a portable copy in
// %LOCALAPPDATA%\gh-cli, or gh on PATH.
const ghCandidates = [process.env.GH_PATH, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'gh-cli', 'bin', 'gh.exe'), 'gh'].filter(Boolean)
let ghBin = null
for (const candidate of ghCandidates) {
  try {
    execFileSync(candidate, ['--version'], { stdio: 'ignore' })
    ghBin = candidate
    break
  } catch {}
}
const hasGh = ghBin !== null
if (!hasGh) {
  console.log(`\nGitHub CLI не найден. Создайте релиз v${version} в https://github.com/${repo}/releases/new и приложите:\n  ${exe}\n  ${manifestPath}`)
  process.exit(0)
}
const gh = spawnSync(
  ghBin,
  ['release', 'create', `v${version}`, exe, manifestPath, '--repo', repo, '--title', `Nocturne ${version}`, '--notes', notes || `Nocturne ${version}`],
  { cwd: root, stdio: 'inherit', shell: false },
)
process.exit(gh.status ?? 1)
