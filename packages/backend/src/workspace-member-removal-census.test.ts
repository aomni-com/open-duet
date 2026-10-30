import { expect, test } from 'bun:test'
import { join, relative } from 'node:path'

import type { Node, SourceFile } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
} from 'typescript/unstable/ast/is'
import { API } from 'typescript/unstable/async'

const BACKEND_ROOT = join(import.meta.dir, '..')

test('all membership-generation deletes converge on the removal coordinator owner', async () => {
  const helperConsumers: string[] = []
  const domainPaths: string[] = []
  for await (const path of new Bun.Glob('convex/domains/**/*.ts').scan({
    cwd: BACKEND_ROOT,
    absolute: true,
  })) {
    if (path.includes('/convex/_generated/') || path.endsWith('.test.ts')) continue
    domainPaths.push(path)
    const source = await Bun.file(path).text()
    const relativePath = relative(BACKEND_ROOT, path)
    if (
      relativePath !== 'convex/domains/agentSessions/membershipRemoval.ts' &&
      source.includes('deleteWorkspaceMembershipGeneration')
    ) {
      helperConsumers.push(relativePath)
    }
  }
  expect(await workspaceMembershipDeletionSites(domainPaths)).toEqual([
    'convex/domains/agentSessions/membershipRemoval.ts:membership._id',
  ])
  expect(helperConsumers.sort()).toEqual([
    'convex/domains/internalAdmin/cleanup.ts',
    'convex/domains/users/retire.ts',
    'convex/domains/workspaces/mutations.ts',
  ])
})

test('the test deletion seam calls the same generation owner', async () => {
  const source = await Bun.file(join(BACKEND_ROOT, 'convex/testing/workspaces.ts')).text()
  expect(source.match(/deleteWorkspaceMembershipGeneration\(/g)).toHaveLength(2)
  expect(source).not.toMatch(/\.db\.delete\([^)]*(?:membership|memberId)/i)
})

async function workspaceMembershipDeletionSites(paths: string[]): Promise<string[]> {
  const api = new API({ cwd: BACKEND_ROOT })
  const configPath = join(BACKEND_ROOT, 'convex/tsconfig.json')
  const snapshot = await api.updateSnapshot({ openProject: configPath })
  try {
    const project = snapshot.getProject(configPath)
    if (project === undefined) throw new Error('Convex TypeScript project not found')
    const deletionArguments: Array<{ sourceFile: SourceFile; argument: Node }> = []
    for (const path of paths) {
      const sourceFile = await project.program.getSourceFile(path)
      if (sourceFile === undefined) throw new Error(`Convex source file not found: ${path}`)
      visit(sourceFile, node => {
        if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return
        if (
          !isIdentifier(node.expression.name) ||
          textOf(sourceFile, node.expression.name) !== 'delete'
        ) {
          return
        }
        const receiver = node.expression.expression
        if (
          !isPropertyAccessExpression(receiver) ||
          !isIdentifier(receiver.name) ||
          textOf(sourceFile, receiver.name) !== 'db'
        ) {
          return
        }
        const argument = node.arguments[0]
        if (argument !== undefined) deletionArguments.push({ sourceFile, argument })
      })
    }
    const sites: string[] = []
    for (const site of deletionArguments) {
      const type = await project.checker.getTypeAtLocation(site.argument)
      if (type === undefined) continue
      const typeName = await project.checker.typeToString(type)
      if (!typeName.includes('workspaceMembers')) continue
      sites.push(
        `${relative(BACKEND_ROOT, site.sourceFile.fileName)}:${textOf(
          site.sourceFile,
          site.argument,
        )}`,
      )
    }
    return sites
  } finally {
    await snapshot.dispose()
    await api.close()
  }
}

function visit(node: Node, visitor: (node: Node) => void): void {
  visitor(node)
  node.forEachChild(child => visit(child, visitor))
}

function textOf(sourceFile: SourceFile, node: Node): string {
  return sourceFile.text.slice(node.pos, node.end).trim()
}
