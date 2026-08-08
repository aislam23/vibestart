import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Known limitation: this check is regex-based, not a real parser. It is deliberately conservative
// (broad patterns, a few dedicated bypass fixtures in architecture-check.test.mjs) rather than
// exhaustive - a determined rewrite of an import statement can still slip past it. The upgrade
// path, if that ever matters more than the simplicity of a dependency-free script, is an AST walk
// (e.g. via `typescript`'s own parser) instead of pattern matching source text.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// `collectSourceFiles` below returns [] for a directory that does not exist yet (ENOENT), so
// listing `webapp/src` and `website/src` here before either workspace has source files is safe -
// they simply contribute zero files to this check until a later task adds them.
const sourceRoots = ['backend/src', 'packages/contracts/src', 'webapp/src', 'website/src']
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/
// Anchored on `^`/`\n`/`;`, not just `^`/`\n`: an `import`/`export ... from` declaration is valid
// JS/TS syntax anywhere in a module's top-level statement sequence (it is hoisted), including
// packed onto the same physical line after another statement with a `;` - `const x = 1; import
// {Prisma} from '@prisma/client'` is not a syntax error. Anchoring on line start alone missed it.
const importPattern = /(?:^|\n|;)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
// Tolerates a comment between `import`/`require` and the specifier, e.g. `import(/* lazy */ 'pg')`.
// Built from plain strings, not a `String.raw` template literal, because the second pattern below
// needs a literal backtick in its source and `String.raw` cannot produce one via escape.
const commentOrWhitespace = '(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\n]*)*'
const runtimeModulePattern = new RegExp(
  '\\b(?:import|require)\\s*\\(' + commentOrWhitespace + '[\'"]([^\'"]+)[\'"]' + commentOrWhitespace + '\\)',
  'g',
)
// A template-literal specifier - `import(`pg`)`, or worse `import(`${x}`)` - cannot be resolved by
// any text-matching check, string-literal or AST: flag it outright rather than silently passing it
// through unchecked.
const dynamicImportTemplateLiteralPattern = new RegExp(
  '\\b(?:import|require)\\s*\\(' + commentOrWhitespace + '`',
  'g',
)
const DYNAMIC_TEMPLATE_LITERAL_SPECIFIER = '<dynamic-import-template-literal>'
const applicationForbiddenPackages = ['@prisma/', 'hono', 'react', 'react-native', 'expo-', 'jose', 'pg']
const contractForbiddenPackages = ['@prisma/', 'hono', 'react', 'react-native', 'expo-', 'jose']
const transportForbiddenPackages = ['@prisma/', 'jose', 'pg']

export function checkArchitectureSources(files) {
  const violations = []

  for (const file of files) {
    const normalizedPath = normalizePath(file.path)
    const imports = staticImports(file.source)

    for (const imported of imports) {
      const report = (rule, message) => {
        violations.push({
          path: normalizedPath,
          line: imported.line,
          rule,
          message,
        })
      }

      checkUnresolvableDynamicImport(imported.specifier, report)
      checkBackendLayers(normalizedPath, imported.specifier, report)
      checkBackendModuleBoundary(normalizedPath, imported.specifier, report)
      checkClientBoundary(normalizedPath, imported.specifier, report)
      checkContracts(normalizedPath, imported.specifier, report)
    }
  }

  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule),
  )
}

async function main() {
  const files = []

  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = path.join(repositoryRoot, sourceRoot)
    for (const filePath of await collectSourceFiles(absoluteRoot)) {
      files.push({
        path: path.relative(repositoryRoot, filePath),
        source: await readFile(filePath, 'utf8'),
      })
    }
  }

  const violations = checkArchitectureSources(files)
  if (violations.length === 0) {
    console.log(`Architecture check passed (${files.length} source files).`)
    return
  }

  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line} [${violation.rule}] ${violation.message}`)
  }
  process.exitCode = 1
}

function checkBackendLayers(filePath, specifier, report) {
  const layer = filePath.match(
    /^backend\/src\/modules\/[^/]+\/(domain|application|transport|infrastructure)\//,
  )?.[1]
  if (!layer) return

  const forbiddenPackage = applicationForbiddenPackages.find((name) => packageMatches(specifier, name))
  const importsPrisma = specifier.includes('generated/prisma') || packageMatches(specifier, '@prisma/')
  const target = resolveRepositoryImport(filePath, specifier)
  const targetLayer = target?.match(/^backend\/src\/modules\/[^/]+\/(domain|application|transport|infrastructure)(?:\/|$)/)?.[1]

  if ((layer === 'domain' || layer === 'application') && (forbiddenPackage || importsPrisma)) {
    report(
      `backend-${layer}-dependencies`,
      `${layer} must not import framework, persistence, environment, or provider SDK code (${specifier}).`,
    )
  }

  if (
    (layer === 'domain' || layer === 'application') &&
    (specifier.includes('/env') || specifier.endsWith('/env'))
  ) {
    report(
      `backend-${layer}-dependencies`,
      `${layer} must depend on feature types and ports, not environment or infrastructure (${specifier}).`,
    )
  }

  if (
    layer === 'transport' &&
    (importsPrisma || transportForbiddenPackages.some((name) => packageMatches(specifier, name)))
  ) {
    report(
      'backend-transport-dependencies',
      `transport must not import persistence or provider SDK code (${specifier}).`,
    )
  }

  const invalidTargetLayer =
    (layer === 'domain' && targetLayer && targetLayer !== 'domain') ||
    (layer === 'application' && (targetLayer === 'transport' || targetLayer === 'infrastructure')) ||
    (layer === 'transport' && targetLayer === 'infrastructure') ||
    (layer === 'infrastructure' && targetLayer === 'transport')

  if (invalidTargetLayer) {
    report(
      `backend-${layer}-dependencies`,
      `${layer} must not depend on outer backend layer ${targetLayer} (${specifier}).`,
    )
  }
}

function checkBackendModuleBoundary(filePath, specifier, report) {
  const sourceModule = filePath.match(/^backend\/src\/modules\/([^/]+)\//)?.[1]
  const target = resolveRepositoryImport(filePath, specifier)
  const match = target?.match(/^backend\/src\/modules\/([^/]+)(?:\/(.*))?$/)
  if (!match || match[1] === sourceModule) return

  if (match[2] && match[2] !== 'index' && match[2] !== 'index.ts') {
    const boundaryMessage = sourceModule
      ? `module ${sourceModule} must import module ${match[1]}`
      : `code outside module ${match[1]} must import it`
    report(
      'backend-module-public-api',
      `${boundaryMessage} through its public index (${specifier}).`,
    )
  }
}

function checkClientBoundary(filePath, specifier, report) {
  const client = filePath.match(/^(webapp|website)\/src\//)?.[1]
  if (!client) return

  const target = resolveRepositoryImport(filePath, specifier)
  if (!target) return

  const sourceFeature = filePath.match(new RegExp(`^${client}/src/features/([^/]+)/`))?.[1]
  const targetFeature = target.match(new RegExp(`^${client}/src/features/([^/]+)(?:/(.*))?$`))
  if (targetFeature && targetFeature[2] && targetFeature[2] !== 'index' && targetFeature[2] !== 'index.ts') {
    const crossesPublicBoundary = !sourceFeature || targetFeature[1] !== sourceFeature
    if (crossesPublicBoundary) {
      report(
        'client-feature-public-api',
        `code outside feature ${targetFeature[1]} must import it through its public index (${specifier}).`,
      )
    }
  }

  const isLowerLayer =
    filePath.startsWith(`${client}/src/platform/`) ||
    filePath.startsWith(`${client}/src/components/ui/`)
  if (isLowerLayer && targetFeature) {
    report(
      'client-dependency-direction',
      `platform and UI primitives must not import product features (${specifier}).`,
    )
  }
}

function checkUnresolvableDynamicImport(specifier, report) {
  if (specifier !== DYNAMIC_TEMPLATE_LITERAL_SPECIFIER) return
  report(
    'dynamic-import-unresolvable',
    'dynamic import()/require() with a template-literal specifier cannot be statically verified; use a string literal.',
  )
}

function checkContracts(filePath, specifier, report) {
  if (!filePath.startsWith('packages/contracts/src/')) return

  const target = resolveRepositoryImport(filePath, specifier)
  const forbiddenTarget = target && /^(backend|webapp|website)\//.test(target)
  const forbiddenPackage = contractForbiddenPackages.some((name) => packageMatches(specifier, name))
  if (forbiddenTarget || forbiddenPackage) {
    report(
      'contracts-dependency-direction',
      `contracts must not import backend, client, framework, or provider code (${specifier}).`,
    )
  }
}

function resolveRepositoryImport(importer, specifier) {
  if (specifier.startsWith('.')) {
    return normalizePath(path.normalize(path.join(path.dirname(importer), specifier)))
  }

  if (specifier.startsWith('@/')) {
    const workspace = importer.split('/')[0]
    return `${workspace}/src/${specifier.slice(2)}`
  }

  const workspaceAlias = specifier.match(/^@vibestart\/(backend|contracts|webapp|website)(?:\/(.*))?$/)
  if (workspaceAlias) {
    return `${workspaceAlias[1]}/src/${workspaceAlias[2] ?? 'index'}`
  }

  return null
}

function staticImports(source) {
  const imports = []
  for (const pattern of [importPattern, runtimeModulePattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (!specifier) continue
      const specifierOffset = (match.index ?? 0) + match[0].lastIndexOf(specifier)
      imports.push({
        specifier,
        line: source.slice(0, specifierOffset).split('\n').length,
      })
    }
  }

  for (const match of source.matchAll(dynamicImportTemplateLiteralPattern)) {
    const matchEnd = (match.index ?? 0) + match[0].length
    imports.push({
      specifier: DYNAMIC_TEMPLATE_LITERAL_SPECIFIER,
      line: source.slice(0, matchEnd).split('\n').length,
    })
  }

  return imports
}

async function collectSourceFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(entryPath)))
    else if (sourceExtension.test(entry.name)) files.push(entryPath)
  }
  return files
}

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, '/')
}

function packageMatches(specifier, packagePrefix) {
  // Two different prefix styles: a scoped-package prefix like `@prisma/` (only ever a path
  // separator before the rest of the name) and a hyphenated-family prefix like `expo-` (the family
  // member's own name continues directly after the hyphen, e.g. `expo-router` - no `/` involved).
  // Treating both the same as "must be followed by `/`" made `expo-` match nothing at all:
  // `'expo-router'.startsWith('expo-/')` is false.
  if (packagePrefix.endsWith('/') || packagePrefix.endsWith('-')) {
    return specifier.startsWith(packagePrefix)
  }
  return specifier === packagePrefix || specifier.startsWith(`${packagePrefix}/`)
}

if (import.meta.main) await main()
