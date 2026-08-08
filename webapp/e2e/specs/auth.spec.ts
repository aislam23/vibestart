import { e2ePassword, expect, test, uniqueEmail } from '../helpers/test'

test('registers via the UI, reaches the workspace, updates the profile, and logs back in after logging out', async ({
  page,
}) => {
  const email = uniqueEmail()
  const displayName = 'Webapp E2E User'

  await page.goto('/signup')
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible()

  await page.getByLabel('Full Name').fill(displayName)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(e2ePassword)
  await page.getByLabel('Confirm Password').fill(e2ePassword)
  await page.getByRole('button', { name: 'Create Account' }).click()

  // Local dev/e2e has Supabase email autoconfirm on (infra/supabase/.env.example), so `signUp`
  // returns an active session immediately and the guest-only route redirects straight to /app -
  // see webapp/README.md, "Auth architecture", "Registration".
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: `Welcome, ${displayName}` })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Profile' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0)

  await page.getByRole('link', { name: 'Profile' }).click()
  await expect(page).toHaveURL(/\/app\/profile$/)
  await expect(page.getByLabel('Email')).toHaveValue(email)
  await expect(page.getByLabel('Email')).toHaveAttribute('readonly', '')
  await page.getByLabel('Display name').fill('Updated E2E User')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Profile saved')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Display name')).toHaveValue('Updated E2E User')

  // Back to Home first: logging out preserves the current path as `returnTo` (WorkspaceRoute in
  // src/pages.tsx), so logging out from /app/profile would land the next login back on
  // /app/profile instead of /app.
  await page.getByRole('link', { name: 'Home' }).click()
  await expect(page).toHaveURL(/\/app$/)

  await page.getByRole('button', { name: 'Open account menu' }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible()

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(e2ePassword)
  await page.getByRole('button', { name: 'Login' }).click()

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome, Updated E2E User' })).toBeVisible()
})

test('shows the forgot-password screen and accepts a reset request', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('link', { name: 'Forgot your password?' }).click()

  await expect(page).toHaveURL(/\/forgot-password$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible()

  await page.getByRole('button', { name: 'Send reset instructions' }).click()
  await expect(page.getByText('Invalid email address')).toBeVisible()

  // Email delivery is out of scope here (no SMTP is configured for e2e - see
  // e2e/plan.ts's SITE_URL/ADDITIONAL_REDIRECT_URLS comment): a never-registered address hits
  // GoTrue's anti-enumeration branch, which returns success without ever calling the mailer, so
  // this assertion only needs the request to succeed and the UI to reflect that - not an actual
  // email.
  await page.getByLabel('Email').fill(uniqueEmail('forgot-password'))
  await page.getByRole('button', { name: 'Send reset instructions' }).click()

  await expect(page.getByRole('alert')).toContainText(
    'If an account exists for that address, reset instructions are on the way.',
  )
})
