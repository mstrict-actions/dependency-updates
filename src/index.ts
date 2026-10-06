import * as core from '@actions/core'
import * as github from '@actions/github'
import { readFile, readdir } from 'node:fs/promises'
import { parseDocument } from 'yaml'
import {
  checkImages,
  latest,
  replaceImages,
  replaceTerraformVersion,
  stable,
  updateCollections,
  upgrade,
} from './main.ts'

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value))
    throw new Error(`Missing ${key}`)
  const result: unknown = Reflect.get(value, key)
  return result
}
function stringField(value: unknown, key: string): string {
  const result = field(value, key)
  if (typeof result !== 'string' || result.length === 0)
    throw new Error(`Invalid ${key}`)
  return result
}
function stringArray(value: unknown, key: string): string[] {
  const input = field(value, key)
  if (!Array.isArray(input)) throw new Error(`Invalid ${key}`)
  const rows: unknown[] = Array.from(input, (row: unknown): unknown => row)
  if (rows.some((row): boolean => typeof row !== 'string'))
    throw new Error(`Invalid ${key}`)
  return rows.filter((row): row is string => typeof row === 'string')
}
async function json(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/json' },
  })
  if (!response.ok)
    throw new Error(`Release API failed: ${response.status.toString()}`)
  return response.json()
}
async function image(name: string, tag: string): Promise<string> {
  const response = await json(
    `https://hub.docker.com/v2/repositories/${name}/tags/${tag}`,
  )
  const digest = stringField(response, 'digest')
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error('Image manifest digest is invalid')
  const short =
    name === 'library/node'
      ? 'node'
      : name === 'library/python'
        ? 'python'
        : name
  return `${short}:${tag}@${digest}`
}
async function galaxyVersion(name: string): Promise<string> {
  const [namespace, collection] = name.split('.')
  if (
    namespace === undefined ||
    collection === undefined ||
    !/^[a-z0-9_]+$/.test(namespace) ||
    !/^[a-z0-9_]+$/.test(collection)
  )
    throw new Error('Invalid Galaxy collection name')
  const versions: string[] = []
  let url: string | undefined =
    `https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/index/${namespace}/${collection}/versions/?limit=100`
  while (url !== undefined) {
    const page: unknown = await json(url)
    const entries = field(page, 'data')
    if (!Array.isArray(entries))
      throw new Error('Galaxy response has no versions')
    const rows: unknown[] = Array.from(entries, (row: unknown): unknown => row)
    for (const row of rows) versions.push(stringField(row, 'version'))
    const links = field(page, 'links')
    const next: unknown =
      typeof links === 'object' && links !== null && 'next' in links
        ? Reflect.get(links, 'next')
        : null
    if (next !== null && typeof next !== 'string')
      throw new Error('Invalid Galaxy pagination')
    url = next === null ? undefined : new URL(next, url).href
    if (
      url !== undefined &&
      new URL(url).origin !== 'https://galaxy.ansible.com'
    )
      throw new Error('Unexpected Galaxy pagination origin')
  }
  return latest(versions)
}
async function configuredRoots(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const names = await readdir(`${directory}/${entry.name}`)
    if (names.includes('root.json')) roots.push(entry.name)
  }
  return roots.sort()
}
async function check(config: unknown): Promise<string> {
  const tools: unknown = JSON.parse(
    await readFile(stringField(config, 'toolsFile'), 'utf8'),
  )
  const terraform = stringField(tools, 'terraform')
  const node = stringField(tools, 'node')
  const python = stringField(tools, 'python')
  checkImages(await readFile(stringField(config, 'dockerfile'), 'utf8'), {
    terraform,
    node,
    python,
  })
  const rootsDirectory = stringField(config, 'terraformRootsDirectory')
  const roots = await configuredRoots(rootsDirectory)
  if (roots.length === 0) throw new Error('No Terraform roots found')
  for (const root of roots) {
    const names = await readdir(`${rootsDirectory}/${root}`)
    for (const name of names.filter((file): boolean => file.endsWith('.tf'))) {
      const source = await readFile(`${rootsDirectory}/${root}/${name}`, 'utf8')
      const match = /required_version\s*=\s*"= ([0-9.]+)"/.exec(source)
      if (match !== null && match[1] !== terraform)
        throw new Error('Terraform CLI pins differ')
    }
  }
  const source = await readFile(stringField(config, 'collectionsFile'), 'utf8')
  const document = parseDocument(source)
  if (document.errors.length > 0) throw new Error('Invalid Galaxy requirements')
  const rows: unknown = field(document.toJS(), 'collections')
  if (!Array.isArray(rows)) throw new Error('Invalid Galaxy requirements')
  for (const row of Array.from(rows, (item: unknown): unknown => item)) {
    stringField(row, 'name')
    if (!stable(stringField(row, 'version')))
      throw new Error('Unstable Galaxy pin')
  }
  return `Pins consistent across ${roots.length.toString()} Terraform roots`
}
async function update(config: unknown): Promise<string> {
  const token = core.getInput('github-token', { required: true })
  const client = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const branch = stringField(config, 'branch')
  const baseBranch = stringField(config, 'baseBranch')
  const workflow = stringField(config, 'checksWorkflow')
  const frozen = async (): Promise<boolean> => {
    const pulls = await client.paginate(client.rest.pulls.list, {
      owner,
      repo,
      state: 'open',
      base: baseBranch,
      per_page: 100,
    })
    return pulls.some(
      (pull): boolean =>
        pull.head.repo.full_name === `${owner}/${repo}` &&
        pull.head.ref === branch,
    )
  }
  if (await frozen()) return 'Aggregate pull request open; updates frozen'
  let head: string
  try {
    head = (
      await client.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
    ).data.object.sha
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('status' in error) ||
      error.status !== 404
    )
      throw error
    const main = (
      await client.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` })
    ).data.object.sha
    head = (
      await client.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: main,
      })
    ).data.object.sha
  }
  const original = new Map<string, string>()
  const read = async (path: string): Promise<string> => {
    const response = await client.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: head,
    })
    const data = response.data
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data))
      throw new Error('Expected a repository file')
    const text = Buffer.from(data.content, 'base64').toString('utf8')
    original.set(path, text)
    return text
  }
  const toolsPath = stringField(config, 'toolsFile')
  const collectionsPath = stringField(config, 'collectionsFile')
  const dockerPath = stringField(config, 'dockerfile')
  const tools: unknown = JSON.parse(await read(toolsPath))
  const oldTerraform = stringField(tools, 'terraform')
  const oldNode = stringField(tools, 'node')
  const oldPython = stringField(tools, 'python')
  const enabled = stringArray(config, 'enabled')
  const updates = new Map<string, string>()
  if (enabled.includes('toolchain')) {
    const release = (
      await client.rest.repos.getLatestRelease({
        owner: 'hashicorp',
        repo: 'terraform',
      })
    ).data.tag_name.replace(/^v/, '')
    const terraform = upgrade(oldTerraform, release)
    const nodeIndex: unknown = await json('https://nodejs.org/dist/index.json')
    if (!Array.isArray(nodeIndex)) throw new Error('Invalid Node release index')
    const nodeRows: unknown[] = Array.from(
      nodeIndex,
      (row: unknown): unknown => row,
    )
    const node = upgrade(
      oldNode,
      latest(
        nodeRows
          .map((row): string => stringField(row, 'version').replace(/^v/, ''))
          .filter(stable),
      ).split('.')[0] ?? '',
    )
    const pythonTags = await client.paginate(client.rest.repos.listTags, {
      owner: 'python',
      repo: 'cpython',
      per_page: 100,
    })
    const python = upgrade(
      oldPython,
      latest(
        pythonTags
          .map((row): string => row.name.replace(/^v/, ''))
          .filter(stable),
      )
        .split('.')
        .slice(0, 2)
        .join('.'),
    )
    const images = await Promise.all([
      image('hashicorp/terraform', terraform),
      image('library/node', `${node}-bookworm-slim`),
      image('library/python', `${python}-slim-bookworm`),
    ])
    const terraformImage = images[0],
      nodeImage = images[1],
      pythonImage = images[2]
    updates.set(
      toolsPath,
      `${JSON.stringify({ terraform, node, python }, null, 2)}\n`,
    )
    updates.set(
      dockerPath,
      replaceImages(await read(dockerPath), {
        terraform: terraformImage,
        node: nodeImage,
        python: pythonImage,
      }),
    )
    const tree = (
      await client.rest.git.getTree({
        owner,
        repo,
        tree_sha: head,
        recursive: 'true',
      })
    ).data
    if (tree.truncated) throw new Error('Repository tree truncated')
    const directory = stringField(config, 'terraformRootsDirectory')
    const roots = new Set(
      tree.tree
        .filter(
          (item): boolean =>
            item.type === 'blob' &&
            item.path.startsWith(`${directory}/`) &&
            item.path.endsWith('/root.json'),
        )
        .map((item): string => item.path.slice(0, -'/root.json'.length)),
    )
    for (const item of tree.tree) {
      const path = item.path
      if (
        item.type !== 'blob' ||
        !path.endsWith('.tf') ||
        !roots.has(path.slice(0, path.lastIndexOf('/')))
      )
        continue
      const source = await read(path)
      if (/required_version\s*=\s*"= [0-9.]+"/.test(source))
        updates.set(path, replaceTerraformVersion(source, terraform))
    }
  }
  if (enabled.includes('galaxy')) {
    const source = await read(collectionsPath)
    const parsed = parseDocument(source)
    if (parsed.errors.length > 0) throw new Error('Invalid Galaxy requirements')
    const rows: unknown = field(parsed.toJS(), 'collections')
    if (!Array.isArray(rows)) throw new Error('Invalid Galaxy requirements')
    const versions = new Map<string, string>()
    for (const row of Array.from(rows, (item: unknown): unknown => item)) {
      const name = stringField(row, 'name')
      versions.set(name, await galaxyVersion(name))
    }
    updates.set(collectionsPath, updateCollections(source, versions))
  }
  const files = [...updates].filter(
    ([path, content]): boolean => original.get(path) !== content,
  )
  if (files.length === 0) return 'Runtime and collection pins are current'
  if (await frozen()) return 'Aggregate review opened; no commit published'
  if (
    (await client.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })).data
      .object.sha !== head
  )
    throw new Error('Accumulator changed during release discovery')
  const parent = (
    await client.rest.git.getCommit({ owner, repo, commit_sha: head })
  ).data
  const nextTree = (
    await client.rest.git.createTree({
      owner,
      repo,
      base_tree: parent.tree.sha,
      tree: files.map(
        ([path, content]): {
          path: string
          mode: '100644'
          type: 'blob'
          content: string
        } => ({
          path,
          mode: '100644',
          type: 'blob',
          content,
        }),
      ),
    })
  ).data
  const commit = (
    await client.rest.git.createCommit({
      owner,
      repo,
      message: 'chore(deps): update runtime and Ansible collection pins',
      tree: nextTree.sha,
      parents: [head],
    })
  ).data
  if (await frozen())
    return 'Aggregate review opened; generated commit not published'
  await client.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  })
  await client.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: workflow,
    ref: branch,
  })
  return `Updated ${files.length.toString()} files; checks dispatched`
}
async function run(): Promise<void> {
  let message = 'Dependency operation did not complete'
  try {
    const config: unknown = JSON.parse(
      await readFile(core.getInput('config', { required: true }), 'utf8'),
    )
    const operation = core.getInput('operation', { required: true })
    if (operation === 'check') message = await check(config)
    else if (operation === 'update') message = await update(config)
    else throw new Error('Unknown dependency operation')
    core.notice(message)
  } catch {
    message = 'Dependency operation failed; external response withheld'
    core.setFailed(message)
  } finally {
    if (process.env['GITHUB_STEP_SUMMARY'] !== undefined) {
      try {
        core.summary.addHeading('Dependency updates').addRaw(`${message}\n`)
        await core.summary.write()
      } catch {
        core.warning('Could not write dependency summary')
      }
    }
  }
}
await run()
