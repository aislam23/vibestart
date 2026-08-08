import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { getSecondaryAction } from '../src/lib/landing-actions'

const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
const description =
  'Ship a landing page, web app, and backend from one starter template. Describe what you want in plain language, and an AI coding agent makes the change and shows you the result.'
const execFileAsync = promisify(execFile)
const websiteDirectory = new URL('..', import.meta.url)
const templateUrl = 'https://github.com/your-org/vibestart'
const templateLabel = 'View the template on GitHub'

function countLinks(pageHtml: string, href: string, label: string) {
  return pageHtml.split(`href="${href}">${label}`).length - 1
}

type BuildResult =
  | { ok: true; html: string }
  | { ok: false; output: string }

/** Runs a real `astro build` with the given env overrides (undefined deletes the key). */
async function buildLanding(envOverrides: Record<string, string | undefined> = {}): Promise<BuildResult> {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'vibestart-landing-'))
  const environment = { ...process.env }

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete environment[key]
    } else {
      environment[key] = value
    }
  }

  try {
    await execFileAsync(process.execPath, ['run', 'astro', 'build', '--outDir', outputDirectory], {
      cwd: websiteDirectory,
      env: environment,
    })
    return { ok: true, html: await readFile(join(outputDirectory, 'index.html'), 'utf8') }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: `${execError.stdout ?? ''}${execError.stderr ?? ''}` || execError.message }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
}

test('landing build keeps SEO-critical content in semantic static HTML', () => {
  assert.match(html, /<html[^>]*\blang="en"/)
  assert.match(
    html,
    /<title>vibestart — a full-stack starter template for building with AI agents<\/title>/,
  )
  assert.ok(html.includes(`<meta name="description" content="${description}">`))
  assert.equal(html.match(/<h1\b/g)?.length, 1)
  assert.match(html, /Build a site or app with AI/)
  assert.match(html, /<header/)
  assert.match(html, /<main id="main-content"/)
  assert.match(html, /<footer/)
})

test('landing build contains the complete modular section flow with one isolated hero client island', () => {
  for (const sectionId of [
    'features',
    'audience',
    'launch-kit',
    'process',
    'scenarios',
    'results',
    'faq',
    'cta',
  ]) {
    assert.match(html, new RegExp(`id="${sectionId}"`))
  }
  assert.equal(html.match(/<astro-island\b/g)?.length, 1)
  assert.match(html, /data-hero-visual/)
  assert.match(html, /data-hero-scene-fallback/)
})

test('all section landmarks are labelled by their headings', () => {
  for (const [titleId, headingTag] of [
    ['hero-title', 'h1'],
    ['features-title', 'h2'],
    ['audience-title', 'h2'],
    ['launch-kit-title', 'h2'],
    ['process-title', 'h2'],
    ['scenarios-title', 'h2'],
    ['results-title', 'h2'],
    ['faq-title', 'h2'],
    ['cta-title', 'h2'],
  ]) {
    assert.match(html, new RegExp(`<section[^>]*aria-labelledby="${titleId}"[^>]*>[\\s\\S]*?<${headingTag}[^>]*id="${titleId}"`))
    assert.doesNotMatch(html, new RegExp(`<div[^>]*id="${titleId}"`))
  }
})

test('landing without a webapp URL offers the template and a local next step', async () => {
  const result = await buildLanding({ PUBLIC_WEBAPP_URL: undefined })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(countLinks(result.html, templateUrl, templateLabel), 4)
  assert.equal(countLinks(result.html, '#process', 'See how it works'), 1)
  assert.doesNotMatch(result.html, /Open the web app/)
})

test('configured webapp is rendered without replacing template acquisition', async () => {
  const webappUrl = 'https://app.example.com'
  const result = await buildLanding({ PUBLIC_WEBAPP_URL: webappUrl })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(countLinks(result.html, templateUrl, templateLabel), 4)
  assert.equal(countLinks(result.html, webappUrl, 'Open the web app'), 1)
  assert.equal(countLinks(result.html, '#process', 'See how it works'), 0)
})

test('blank webapp URL renders the local next step', async () => {
  const result = await buildLanding({ PUBLIC_WEBAPP_URL: '   ' })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(countLinks(result.html, templateUrl, templateLabel), 4)
  assert.equal(countLinks(result.html, '#process', 'See how it works'), 1)
  assert.doesNotMatch(result.html, /Open the web app/)
})

test('a dev build (PUBLIC_SITE_ENV unset) keeps the template placeholder and never fails', async () => {
  const result = await buildLanding({ PUBLIC_SITE_ENV: undefined, PUBLIC_REPO_URL: undefined })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(countLinks(result.html, templateUrl, templateLabel), 4)
})

test('a production build fails loudly when PUBLIC_REPO_URL is unset', async () => {
  const result = await buildLanding({ PUBLIC_SITE_ENV: 'production', PUBLIC_REPO_URL: undefined })
  assert.equal(result.ok, false)
  if (result.ok) return

  assert.match(result.output, /PUBLIC_REPO_URL is required for a production build/)
})

test('a production build fails loudly when PUBLIC_REPO_URL is still the template placeholder', async () => {
  const result = await buildLanding({ PUBLIC_SITE_ENV: 'production', PUBLIC_REPO_URL: templateUrl })
  assert.equal(result.ok, false)
  if (result.ok) return

  assert.match(result.output, /PUBLIC_REPO_URL is required for a production build/)
})

test('a production build succeeds once PUBLIC_REPO_URL is set to a real repository', async () => {
  const repoUrl = 'https://github.com/acme/vibestart-fork'
  const result = await buildLanding({
    PUBLIC_SITE_ENV: 'production',
    PUBLIC_REPO_URL: repoUrl,
    PUBLIC_WEBAPP_URL: undefined,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(countLinks(result.html, repoUrl, templateLabel), 4)
  assert.equal(countLinks(result.html, templateUrl, templateLabel), 0)
})

test('a production build fails loudly on a non-https PUBLIC_WEBAPP_URL', async () => {
  const result = await buildLanding({
    PUBLIC_SITE_ENV: 'production',
    PUBLIC_REPO_URL: 'https://github.com/acme/vibestart-fork',
    PUBLIC_WEBAPP_URL: 'http://app.example.com',
  })
  assert.equal(result.ok, false)
  if (result.ok) return

  assert.match(result.output, /PUBLIC_WEBAPP_URL must be an https:\/\/ URL in production/)
})

test('getSecondaryAction: blank/unset webapp URL falls back to the local next step', () => {
  assert.deepEqual(getSecondaryAction(), {
    href: '#process',
    label: 'See how it works',
  })
  assert.deepEqual(getSecondaryAction('   '), {
    href: '#process',
    label: 'See how it works',
  })
})

test('getSecondaryAction: an https:// URL is always accepted', () => {
  assert.deepEqual(getSecondaryAction('  https://app.example.com  '), {
    href: 'https://app.example.com',
    label: 'Open the web app',
  })
})

test('getSecondaryAction: http://localhost/127.0.0.1 is accepted outside production', () => {
  const previous = process.env.PUBLIC_SITE_ENV
  delete process.env.PUBLIC_SITE_ENV
  try {
    assert.deepEqual(getSecondaryAction('http://localhost:5173'), {
      href: 'http://localhost:5173',
      label: 'Open the web app',
    })
    assert.deepEqual(getSecondaryAction('http://127.0.0.1:5173'), {
      href: 'http://127.0.0.1:5173',
      label: 'Open the web app',
    })
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_SITE_ENV
    else process.env.PUBLIC_SITE_ENV = previous
  }
})

test('getSecondaryAction: a non-https, non-localhost URL falls back to the local next step outside production', () => {
  const previous = process.env.PUBLIC_SITE_ENV
  delete process.env.PUBLIC_SITE_ENV
  try {
    assert.deepEqual(getSecondaryAction('http://app.example.com'), {
      href: '#process',
      label: 'See how it works',
    })
    assert.deepEqual(getSecondaryAction('javascript:alert(1)'), {
      href: '#process',
      label: 'See how it works',
    })
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_SITE_ENV
    else process.env.PUBLIC_SITE_ENV = previous
  }
})

test('getSecondaryAction: a non-https URL throws in production instead of silently falling back', () => {
  const previous = process.env.PUBLIC_SITE_ENV
  process.env.PUBLIC_SITE_ENV = 'production'
  try {
    assert.throws(
      () => getSecondaryAction('http://app.example.com'),
      /PUBLIC_WEBAPP_URL must be an https:\/\/ URL in production/,
    )
    assert.throws(() => getSecondaryAction('javascript:alert(1)'))
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_SITE_ENV
    else process.env.PUBLIC_SITE_ENV = previous
  }
})
