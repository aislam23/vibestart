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

async function buildLanding(publicWebappUrl?: string) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'vibestart-landing-'))
  const environment = { ...process.env }

  if (publicWebappUrl === undefined) {
    delete environment.PUBLIC_WEBAPP_URL
  } else {
    environment.PUBLIC_WEBAPP_URL = publicWebappUrl
  }

  try {
    await execFileAsync(process.execPath, ['run', 'astro', 'build', '--outDir', outputDirectory], {
      cwd: websiteDirectory,
      env: environment,
    })

    return await readFile(join(outputDirectory, 'index.html'), 'utf8')
  } finally {
    await rm(outputDirectory, { recursive: true })
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
  const unsetUrlHtml = await buildLanding()

  assert.equal(countLinks(unsetUrlHtml, templateUrl, templateLabel), 4)
  assert.equal(countLinks(unsetUrlHtml, '#process', 'See how it works'), 1)
  assert.doesNotMatch(unsetUrlHtml, /Open the web app/)
})

test('configured webapp stays a separate secondary action', () => {
  assert.deepEqual(getSecondaryAction(), {
    href: '#process',
    label: 'See how it works',
  })
  assert.deepEqual(getSecondaryAction('   '), {
    href: '#process',
    label: 'See how it works',
  })
  assert.deepEqual(getSecondaryAction('  https://app.example.com  '), {
    href: 'https://app.example.com',
    label: 'Open the web app',
  })
})

test('configured webapp is rendered without replacing template acquisition', async () => {
  const webappUrl = 'https://app.example.com'
  const configuredHtml = await buildLanding(webappUrl)

  assert.equal(countLinks(configuredHtml, templateUrl, templateLabel), 4)
  assert.equal(countLinks(configuredHtml, webappUrl, 'Open the web app'), 1)
  assert.equal(countLinks(configuredHtml, '#process', 'See how it works'), 0)
})

test('blank webapp URL renders the local next step', async () => {
  const blankUrlHtml = await buildLanding('   ')

  assert.equal(countLinks(blankUrlHtml, templateUrl, templateLabel), 4)
  assert.equal(countLinks(blankUrlHtml, '#process', 'See how it works'), 1)
  assert.doesNotMatch(blankUrlHtml, /Open the web app/)
})
