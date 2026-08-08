import { e2eAdminEmail, e2eAdminPassword } from '../env'
import { e2ePassword, expect, test, uniqueEmail } from '../helpers/test'

test('redirects unauthenticated and role-mismatched visitors, and lets an admin change a role', async ({
  browser,
  page,
}) => {
  const userEmail = uniqueEmail('webapp-e2e-rbac-user')

  await page.goto('/admin')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin$/)

  await page.getByRole('link', { name: 'Sign up' }).click()
  // Waits for the RegisterForm to actually be mounted before filling: clicking straight into a
  // `.fill()` here can otherwise land the value on the LoginForm's own "Email" field for the
  // instant it's still on screen during the client-side route transition.
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible()
  await page.getByLabel('Email').fill(userEmail)
  await page.getByLabel('Password', { exact: true }).fill(e2ePassword)
  await page.getByLabel('Confirm Password').fill(e2ePassword)
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page).toHaveURL(/\/app$/)

  // A regular user's role never matches the admin workspace route - it redirects home instead of
  // rendering (src/pages.tsx, WorkspaceRoute).
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/app$/)

  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  await adminPage.goto('/login')
  await adminPage.getByLabel('Email').fill(e2eAdminEmail)
  await adminPage.getByLabel('Password', { exact: true }).fill(e2eAdminPassword)
  await adminPage.getByRole('button', { name: 'Login' }).click()

  await expect(adminPage).toHaveURL(/\/admin$/)
  await expect(adminPage.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(adminPage.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(adminPage.getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await expect(adminPage.getByRole('link', { name: 'Users' })).toBeVisible()
  await expect(adminPage.getByRole('link', { name: 'Home' })).toHaveCount(0)

  // Symmetric redirect: the admin's role never matches a user workspace route either.
  await adminPage.goto('/app')
  await expect(adminPage).toHaveURL(/\/admin$/)

  await adminPage.getByRole('link', { name: 'Users' }).click()
  await expect(adminPage).toHaveURL(/\/admin\/users$/)
  await adminPage.getByLabel('Search users').fill(userEmail)
  await adminPage.getByRole('button', { name: 'Search' }).click()

  const roleSelect = adminPage.getByLabel(`Role for ${userEmail}`)
  await expect(roleSelect).toBeVisible()
  await roleSelect.click()
  await adminPage.getByRole('option', { name: 'Admin' }).click()
  await expect(adminPage.getByRole('alertdialog')).toContainText(userEmail)
  await adminPage.getByRole('button', { name: 'Change role' }).click()
  await expect(adminPage.getByText('Role changed')).toBeVisible()

  await adminContext.close()

  // backend/README.md, "No session revocation on a role change": `profiles.role` is read fresh on
  // every request, so the already-signed-in user reaches the admin workspace on its very next
  // request - no logout/login round trip needed to observe the promotion.
  await page.reload()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0)
})
