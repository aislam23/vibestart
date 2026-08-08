import { useForm } from '@tanstack/react-form'
import { Link } from '@tanstack/react-router'
import { passwordSchema } from '@vibestart/contracts'
import { useId, useState } from 'react'

import { Typography } from '@/components/typography'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { ApiRequestError } from '@/platform/api'
import { useAuth } from '../use-auth'
import { FormAlert } from './form-errors'
import type { FieldErrors } from './form-model'
import { clearFieldError, errorId, hasErrors } from './form-validation'
import { PasswordInput } from './PasswordInput'

const invalidLinkMessage = 'This password reset link is invalid or has expired. Request a new one.'

/**
 * Consumes the recovery session Supabase establishes by parsing the reset-link URL on load
 * (`detectSessionInUrl`, on by default) - there is no token to thread through props here, only
 * `auth.isPasswordRecovery`, which the provider sets once it observes the `PASSWORD_RECOVERY`
 * auth event.
 */
export function ResetPasswordForm() {
  const auth = useAuth()
  const linkIsValid = auth.isPasswordRecovery
  const passwordId = useId()
  const passwordDescriptionId = useId()
  const passwordErrorId = useId()
  const confirmPasswordId = useId()
  const confirmPasswordErrorId = useId()
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(linkIsValid ? null : invalidLinkMessage)
  const [completed, setCompleted] = useState(false)
  const form = useForm({
    defaultValues: { password: '', confirmPassword: '' },
    onSubmit: async ({ value }) => {
      if (!linkIsValid) return
      setFormError(null)
      const result = passwordSchema.safeParse(value.password)
      const nextErrors: FieldErrors = result.success
        ? {}
        : { password: result.error.issues.map((issue) => ({ message: issue.message })) }
      if (value.password !== value.confirmPassword) {
        nextErrors.confirmPassword = [{ message: 'Passwords do not match' }]
      }
      if (!result.success || hasErrors(nextErrors.confirmPassword)) {
        setFieldErrors(nextErrors)
        return
      }

      setFieldErrors({})
      try {
        await auth.updatePassword(result.data)
        setCompleted(true)
      } catch (caughtError) {
        setFormError(
          caughtError instanceof ApiRequestError
            ? caughtError.message
            : 'Unable to reset your password',
        )
      }
    },
  })

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <Typography as="h1" variant="h3" balance>
            Choose a new password
          </Typography>
          <Typography variant="bodySm" tone="muted" balance>
            Pick a new password for your account
          </Typography>
        </div>

        {completed ? (
          <Alert>
            <AlertTitle>Password updated</AlertTitle>
            <AlertDescription>You can now sign in with your new password.</AlertDescription>
          </Alert>
        ) : (
          <>
            <form.Field name="password" children={(field) => (
              <Field data-invalid={hasErrors(fieldErrors.password)}>
                <FieldLabel htmlFor={passwordId}>New Password</FieldLabel>
                <PasswordInput
                  aria-describedby={[
                    passwordDescriptionId,
                    errorId(fieldErrors.password, passwordErrorId),
                  ].filter(Boolean).join(' ')}
                  aria-invalid={hasErrors(fieldErrors.password)}
                  autoComplete="new-password"
                  className="bg-background"
                  disabled={!linkIsValid}
                  id={passwordId}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    clearFieldError('password', setFieldErrors)
                    clearFieldError('confirmPassword', setFieldErrors)
                    setFormError(linkIsValid ? null : invalidLinkMessage)
                  }}
                  value={field.state.value}
                  visibilityLabel="replacement password"
                />
                <FieldDescription id={passwordDescriptionId}>
                  Must be at least 8 characters long.
                </FieldDescription>
                <FieldError id={passwordErrorId} errors={fieldErrors.password} />
              </Field>
            )} />

            <form.Field name="confirmPassword" children={(field) => (
              <Field data-invalid={hasErrors(fieldErrors.confirmPassword)}>
                <FieldLabel htmlFor={confirmPasswordId}>Confirm Password</FieldLabel>
                <PasswordInput
                  aria-describedby={errorId(fieldErrors.confirmPassword, confirmPasswordErrorId)}
                  aria-invalid={hasErrors(fieldErrors.confirmPassword)}
                  autoComplete="new-password"
                  className="bg-background"
                  disabled={!linkIsValid}
                  id={confirmPasswordId}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    clearFieldError('confirmPassword', setFieldErrors)
                    setFormError(linkIsValid ? null : invalidLinkMessage)
                  }}
                  value={field.state.value}
                  visibilityLabel="password confirmation"
                />
                <FieldError id={confirmPasswordErrorId} errors={fieldErrors.confirmPassword} />
              </Field>
            )} />

            <FormAlert message={formError} title="Password reset failed" />

            <Field>
              <form.Subscribe selector={(state) => state.isSubmitting} children={(isSubmitting) => (
                <Button disabled={isSubmitting || !linkIsValid} type="submit">
                  {isSubmitting ? 'Updating password…' : 'Update password'}
                </Button>
              )} />
            </Field>
          </>
        )}

        <Typography align="center" variant="bodySm">
          <Link className="underline underline-offset-4" search={{ returnTo: undefined }} to="/login">
            Back to login
          </Link>
        </Typography>
      </FieldGroup>
    </form>
  )
}
