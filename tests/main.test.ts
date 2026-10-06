import { describe, expect, it } from 'vitest'
import {
  checkImages,
  compare,
  latest,
  replaceImages,
  replaceTerraformVersion,
  stable,
  updateCollections,
  upgrade,
} from '../src/main.ts'

const docker =
  'FROM hashicorp/terraform:1.0.0@sha256:a AS terraform\nFROM node:24-bookworm-slim@sha256:b AS node\nFROM python:3.14-slim-bookworm@sha256:c\n'

describe('supplemental dependency policy', (): void => {
  it('selects the highest stable release and orders numeric segments', (): void => {
    expect(stable('1.2.3')).toBe(true)
    expect(stable('1.2.3-rc1')).toBe(false)
    expect(compare('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compare('1.0.0', '1.0.0')).toBe(0)
    expect(compare('1.0.0', '1.1.0')).toBeLessThan(0)
    expect(latest(['1.2.0-rc1', '1.9.0', '1.10.0'])).toBe('1.10.0')
    expect((): string => latest(['1.0.0-rc1'])).toThrow('No stable')
  })
  it('rejects downgrade and unstable discoveries', (): void => {
    expect(upgrade('24', '26')).toBe('26')
    expect(upgrade('3.14', '3.14')).toBe('3.14')
    expect((): string => upgrade('26', '24')).toThrow('downgrade')
    expect((): string => upgrade('1.0.0', '1.1.0-rc1')).toThrow('unstable')
  })
  it('checks and replaces exact Docker stages', (): void => {
    expect((): void => {
      checkImages(docker, { terraform: '1.0.0', node: '24', python: '3.14' })
    }).not.toThrow()
    expect((): void => {
      checkImages(docker, { terraform: '1.0.1', node: '24', python: '3.14' })
    }).toThrow('differ')
    const next = replaceImages(docker, {
      terraform: 'hashicorp/terraform:1.1.0@sha256:d',
      node: 'node:26-bookworm-slim@sha256:e',
      python: 'python:3.15-slim-bookworm@sha256:f',
    })
    expect(next).toContain('FROM node:26-bookworm-slim@sha256:e AS node')
    expect((): string =>
      replaceImages('FROM other:1', { terraform: 'x', node: 'y', python: 'z' }),
    ).toThrow('stage differs')
  })
  it('updates only one exact Terraform CLI pin', (): void => {
    expect(
      replaceTerraformVersion('required_version = "= 1.0.0"', '1.1.0'),
    ).toBe('required_version = "= 1.1.0"')
    expect((): string =>
      replaceTerraformVersion('terraform {}', '1.1.0'),
    ).toThrow('one exact')
    expect((): string =>
      replaceTerraformVersion(
        'required_version = "= 1.0.0"\nrequired_version = "= 1.0.0"',
        '1.1.0',
      ),
    ).toThrow('one exact')
  })
  it('preserves collection names and updates JSON or YAML versions', (): void => {
    const versions = new Map([['vendor.collection', '2.0.0']])
    const json =
      '{"collections":[{"name":"vendor.collection","version":"1.0.0"}]}'
    expect(updateCollections(json, versions)).toContain('"version": "2.0.0"')
    expect(
      updateCollections(
        'collections:\n  - name: vendor.collection\n    version: 1.0.0\n',
        versions,
      ),
    ).toContain('version: 2.0.0')
    expect((): string => updateCollections('collections: [', versions)).toThrow(
      'Invalid Galaxy',
    )
    expect((): string => updateCollections('other: []', versions)).toThrow(
      'must contain',
    )
    expect((): string =>
      updateCollections('collections: [1]', versions),
    ).toThrow('Invalid Galaxy collection')
    expect((): string => updateCollections(json, new Map())).toThrow(
      'Missing Galaxy',
    )
    expect((): string =>
      updateCollections(json, new Map([['vendor.collection', '0.1.0']])),
    ).toThrow('downgrade')
  })
})
