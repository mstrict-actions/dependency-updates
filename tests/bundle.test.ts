import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let directory: string
beforeAll((): void => {
  directory = mkdtempSync(join(tmpdir(), 'dependency-updates-'))
  execFileSync(process.execPath, [
    resolve('build.config.mjs'),
    join(directory, 'fresh.mjs'),
  ])
  copyFileSync(resolve('dist/index.js'), join(directory, 'committed.mjs'))
  cpSync(resolve('tests/fixtures'), join(directory, 'tests/fixtures'), {
    recursive: true,
  })
})
afterAll((): void => {
  if (typeof directory === 'string')
    rmSync(directory, { recursive: true, force: true })
})
describe.each(['fresh.mjs', 'committed.mjs'])(
  'standalone bundle %s',
  (entry): void => {
    it('checks pins outside the repository without node_modules', (): void => {
      const summary = join(directory, `${entry}.summary`)
      writeFileSync(summary, '')
      const result = spawnSync(process.execPath, [join(directory, entry)], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          INPUT_OPERATION: 'check',
          INPUT_CONFIG: 'tests/fixtures/config.json',
          GITHUB_STEP_SUMMARY: summary,
          NODE_PATH: '',
        },
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain(
        'Pins consistent across 1 Terraform roots',
      )
      expect(readFileSync(summary, 'utf8')).toContain('Pins consistent')
    })
  },
)
