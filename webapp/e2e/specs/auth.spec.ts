import { psql } from '../db'
import { readE2ePlan } from '../plan'
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

test('completes a real password-recovery flow end to end via a generated recovery link', async ({
  page,
}) => {
  const plan = readE2ePlan()
  const email = uniqueEmail('recovery')
  const newPassword = 'a-different-password-456'

  // Registers the account this test recovers into - a recovery link only makes sense for a user
  // that already exists. Bypasses the UI (like global-setup.ts's seedAdmin) since that isn't what
  // this test is exercising.
  const signupResponse = await page.request.post(`${plan.supabaseUrl}/auth/v1/signup`, {
    headers: { apikey: plan.anonKey },
    data: { email, password: e2ePassword },
  })
  expect(signupResponse.ok()).toBe(true)

  // Drives the *real* client-side `resetPasswordForEmail` call (ForgotPasswordForm ->
  // `AuthProvider.requestPasswordReset`) in this browser, exactly like a genuine "forgot
  // password" click - not GoTrue's admin `generate_link` API. That distinction matters here:
  // `generate_link` mints an implicit-flow link (a `#access_token=...` fragment) with no PKCE code
  // challenge behind it, which this PKCE-only client (platform/supabase/client.ts) rejects outright
  // (`AuthPKCEGrantCodeExchangeError`) - only a request that originates from the browser generates
  // and stores the PKCE code verifier this flow actually needs. There is no SMTP/mailbox in e2e to
  // read the resulting email out of (see the previous test's comment), so the recovery token is
  // read directly off `auth.users` below instead - but the verify redirect, the PKCE code exchange,
  // and where the session lands from here on are the exact mechanism a real emailed link would
  // drive, in the same browser context that holds the stored verifier.
  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send reset instructions' }).click()
  await expect(page.getByRole('alert')).toContainText('reset instructions are on the way')

  // GoTrue stores a PKCE-flow recovery request as a `pkce_<hash>`-prefixed token directly on
  // `auth.users.recovery_token` (confirmed against this exact GoTrue version by inspecting the
  // table after a real `/recover` call) - there is no separate outbox table to read the link out
  // of for this token type.
  const recoveryToken = psql(plan, `SELECT recovery_token FROM auth.users WHERE email = '${email}';`)
  if (!recoveryToken) {
    throw new Error(`No recovery_token found for ${email} - did the reset request above fail?`)
  }

  // Same GET a real email's link would point at (GOTRUE_MAILER_URLPATHS_RECOVERY in
  // infra/supabase/.env.example): GoTrue verifies the token server-side and 303s to `redirect_to`
  // with a PKCE `?code=` appended, which AuthCallbackPage (pages.tsx) waits on before continuing to
  // `/reset-password`.
  const redirectTo = `${plan.webUrl}/auth/callback?next=/reset-password`
  const verifyUrl = `${plan.supabaseUrl}/auth/v1/verify?token=${encodeURIComponent(recoveryToken)}&type=recovery&redirect_to=${encodeURIComponent(redirectTo)}`
  await page.goto(verifyUrl)
  await expect(page).toHaveURL(/\/reset-password$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeVisible()

  await page.getByLabel('New Password').fill(newPassword)
  await page.getByLabel('Confirm Password').fill(newPassword)
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByText('Password updated')).toBeVisible()

  // `updatePassword` keeps the recovery session active as a normal signed-in session (Supabase
  // does not force a re-login after a password change) - navigating straight to `/login` would
  // just redirect back to `/app` (GuestAuthPage in pages.tsx). Log out first so the next login is
  // a genuine proof that the new password is the one that now works.
  await page.goto('/app')
  await page.getByRole('button', { name: 'Open account menu' }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible()

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(newPassword)
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page).toHaveURL(/\/app$/)
})
