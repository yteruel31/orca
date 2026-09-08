import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, win32 as winPath } from 'node:path'

// What the relocated host is made of: which files are mirrored, where each lands,
// and which of a package's files are runtime rather than bulk. The lifecycle
// around it -- when to materialize, what keeps a host valid, pruning -- is in
// daemon-host-relocation.ts.

/**
 * The host exe keeps the app exe's own file name, so the relocated image is a byte-for-byte,
 * name-included copy of a signed binary — nothing for EDR to read as a renamed image (MITRE T1036).
 * Survival comes from the path (see daemon-host-relocation.ts). The one name-sensitive updater path is the
 * no-PowerShell `taskkill /IM` fallback, where the daemon is killed and terminals cold-restore —
 * the documented pre-relocation outcome, not a failure.
 */
export const daemonHostExeName = (execPath: string): string => winPath.basename(execPath)

// V8 snapshots + ICU data the Electron bootstrap reads even under ELECTRON_RUN_AS_NODE; siblings of Orca.exe.
const RUNTIME_DATA_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']

/** The addon inside its package; the lifecycle hashes this same file. */
export const ADDON_REL_PATH = 'build/Release/windows_process_tree.node'

export type CopyOp = {
  sourcePath: string
  /** Destination path relative to the host root, posix-separated. */
  destRel: string
  kind: 'file' | 'dir'
  /** When true, a missing source is skipped rather than failing the copy. */
  optional?: boolean
  /** Per-source-path predicate for dir copies: return false to skip a path. */
  filter?: (sourcePath: string) => boolean
}

export type DaemonHostSources = {
  appDir: string
  execPath: string
  resourcesPath: string
  entrySourcePath: string
  entryRelPath: string
  /** The addon's package; without it the daemon forks a shell per poll (#16905). */
  windowsProcessTreeDir: string
}

// win32 path semantics so Windows paths decompose correctly off-win32 in cross-platform unit tests; production runs on win32 only.
export function toPosixRelative(fromDir: string, absPath: string): string {
  return winPath.relative(fromDir, absPath).split(winPath.sep).join('/')
}

export function destPath(root: string, destRel: string): string {
  return join(root, ...destRel.split('/'))
}

// What require('@vscode/windows-process-tree') reaches: package.json -> lib/index.js
// -> the addon. src/, deps/ and build junk are the tarball's bulk.
const WINDOWS_PROCESS_TREE_RUNTIME = ['package.json', 'lib']

function isRuntimeWindowsProcessTreePath(packageDir: string, sourcePath: string): boolean {
  const relative = toPosixRelative(packageDir, sourcePath)
  // The package root and the dirs above a kept path must pass too, or cpSync
  // prunes the subtree before it ever reaches the file.
  return (
    relative === '' ||
    WINDOWS_PROCESS_TREE_RUNTIME.some(
      (keep) =>
        keep === relative || keep.startsWith(`${relative}/`) || relative.startsWith(`${keep}/`)
    )
  )
}

// Drop node-pty's .pdb symbols and non-host-arch prebuilds (its bulk); keyed on host arch so a future win32-arm64 build keeps the prebuild it needs.
const HOST_WIN_PREBUILD_DIR = `win32-${process.arch}`.toLowerCase()

function isRuntimeNodePtyPath(sourcePath: string): boolean {
  const p = sourcePath.toLowerCase()
  if (p.endsWith('.pdb')) {
    return false
  }
  // Keep only the host arch's win32 prebuild; drop any other win32-<arch> dir.
  const prebuild = p.match(/prebuilds[\\/](win32-[^\\/]+)/)
  return !prebuild || prebuild[1] === HOST_WIN_PREBUILD_DIR
}

/**
 * The ordered copy plan. Every destRel mirrors the source's win-unpacked relative path so require()
 * and node-pty's loader resolve the mirror identically to the packaged app. Pure so tests can assert layout.
 */
export function buildDaemonHostManifest(sources: DaemonHostSources): CopyOp[] {
  const { appDir, execPath, resourcesPath, entrySourcePath, entryRelPath } = sources
  const ops: CopyOp[] = []

  // Host exe (verbatim name) + V8/ICU blobs at dest root. Top-level DLLs omitted: GPU/media libs a windowless run-as-node host never loads (~48MB saved).
  ops.push({ sourcePath: execPath, destRel: daemonHostExeName(execPath), kind: 'file' })
  for (const name of RUNTIME_DATA_FILES) {
    ops.push({ sourcePath: join(appDir, name), destRel: name, kind: 'file', optional: true })
  }

  // Daemon bundle: entry + sibling chunks/ + out/package.json (CJS/ESM loader resolution), mirrored verbatim.
  ops.push({ sourcePath: entrySourcePath, destRel: entryRelPath, kind: 'file' })
  const chunksDir = join(winPath.dirname(entrySourcePath), 'chunks')
  ops.push({
    sourcePath: chunksDir,
    destRel: toPosixRelative(appDir, chunksDir),
    kind: 'dir',
    optional: true
  })
  const pkgJson = join(resourcesPath, 'app.asar.unpacked', 'out', 'package.json')
  ops.push({
    sourcePath: pkgJson,
    destRel: toPosixRelative(appDir, pkgJson),
    kind: 'file',
    optional: true
  })

  // @vscode/windows-process-tree, mirrored so the daemon's require() resolves it; without it every snapshot forks a powershell.exe (#16905).
  const { windowsProcessTreeDir } = sources
  ops.push({
    sourcePath: windowsProcessTreeDir,
    destRel: toPosixRelative(appDir, windowsProcessTreeDir),
    kind: 'dir',
    filter: (sourcePath) => isRuntimeWindowsProcessTreePath(windowsProcessTreeDir, sourcePath)
  })
  // Its own required op, and outside the dir filter above: a package that lost its
  // binary must fail before the copy, or the host publishes, gets refused for the
  // missing addon, and rebuilds ~260MB on every launch.
  const addonSourcePath = join(windowsProcessTreeDir, ...ADDON_REL_PATH.split('/'))
  ops.push({
    sourcePath: addonSourcePath,
    destRel: toPosixRelative(appDir, addonSourcePath),
    kind: 'file'
  })

  // node-pty tree, mirrored so require('node-pty') resolves it; filtered to drop unused .pdb/other-arch prebuilds.
  const nodePtyDir = join(resourcesPath, 'node_modules', 'node-pty')
  ops.push({
    sourcePath: nodePtyDir,
    destRel: toPosixRelative(appDir, nodePtyDir),
    kind: 'dir',
    filter: isRuntimeNodePtyPath
  })

  return ops
}

export function executeManifest(ops: CopyOp[], stagingRoot: string): void {
  // Up front: a missing required input must cost nothing, not a discarded ~260MB copy.
  const missing = ops.find((op) => !op.optional && !existsSync(op.sourcePath))
  if (missing) {
    throw new Error(`daemon-host relocation: missing required input ${missing.sourcePath}`)
  }
  for (const op of ops) {
    if (!existsSync(op.sourcePath)) {
      continue
    }
    const dest = destPath(stagingRoot, op.destRel)
    mkdirSync(dirname(dest), { recursive: true })
    const { filter } = op
    // Dereference symlinks so the copy holds no link back into the install dir.
    cpSync(op.sourcePath, dest, {
      recursive: op.kind === 'dir',
      dereference: true,
      force: true,
      ...(filter ? { filter: (src: string) => filter(src) } : {})
    })
  }
}
