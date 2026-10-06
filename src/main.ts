import { parseDocument } from 'yaml'

export function stable(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

export function compare(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function latest(values: string[]): string {
  const version = values.filter(stable).sort(compare).at(-1)
  if (version === undefined) throw new Error('No stable release found')
  return version
}

export function upgrade(current: string, discovered: string): string {
  if (
    !/^\d+(\.\d+){0,2}$/.test(discovered) ||
    compare(discovered, current) < 0
  ) {
    throw new Error('Release discovery is unstable or would downgrade a pin')
  }
  return discovered
}

export function checkImages(
  dockerfile: string,
  versions: { terraform: string; node: string; python: string },
): void {
  for (const image of [
    `hashicorp/terraform:${versions.terraform}@sha256:`,
    `node:${versions.node}-bookworm-slim@sha256:`,
    `python:${versions.python}-slim-bookworm@sha256:`,
  ]) {
    if (!dockerfile.includes(`FROM ${image}`)) {
      throw new Error('Dockerfile and tool pins differ')
    }
  }
}

export function replaceImages(
  dockerfile: string,
  images: { terraform: string; node: string; python: string },
): string {
  const stages: [string, string, string][] = [
    ['hashicorp/terraform', ' AS terraform', images.terraform],
    ['node', ' AS node', images.node],
    ['python', '', images.python],
  ]
  let result = dockerfile
  for (const [prefix, suffix, image] of stages) {
    const pattern = new RegExp(
      `^FROM ${prefix.replaceAll('/', '\\/')}:[^\\s]+${suffix}$`,
      'm',
    )
    if (!pattern.test(result))
      throw new Error('Dockerfile runtime stage differs')
    result = result.replace(pattern, `FROM ${image}${suffix}`)
  }
  return result
}

export function replaceTerraformVersion(
  source: string,
  version: string,
): string {
  const pattern = /required_version\s*=\s*"= ([0-9.]+)"/g
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1)
    throw new Error('Expected one exact Terraform CLI pin')
  return source.replace(pattern, `required_version = "= ${version}"`)
}

export function updateCollections(
  source: string,
  versions: Map<string, string>,
): string {
  const document = parseDocument(source)
  if (document.errors.length > 0)
    throw new Error('Invalid Galaxy requirements YAML')
  const parsed: unknown = document.toJS()
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('collections' in parsed) ||
    !Array.isArray(parsed.collections)
  ) {
    throw new Error('Galaxy requirements must contain collections')
  }
  const rows: unknown[] = Array.from(
    parsed.collections,
    (item: unknown): unknown => item,
  )
  for (const [index, row] of rows.entries()) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('name' in row) ||
      typeof row.name !== 'string' ||
      !('version' in row) ||
      typeof row.version !== 'string' ||
      !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(row.name)
    ) {
      throw new Error('Invalid Galaxy collection')
    }
    const next = versions.get(row.name)
    if (next === undefined) throw new Error('Missing Galaxy release')
    const version = upgrade(row.version, next)
    document.setIn(['collections', index, 'version'], version)
  }
  if (source.trimStart().startsWith('{')) {
    const updated: unknown = document.toJS()
    return `${JSON.stringify(updated, null, 2)}\n`
  }
  return document.toString()
}
