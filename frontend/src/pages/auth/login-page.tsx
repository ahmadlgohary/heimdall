import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router'
import { PasswordInput } from '@/components/common/password-input'
import { Button } from '@/components/ui/button'
import { Field, fieldA11y } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'
import { ApiError, errorMessage } from '@/lib/api-client'
import { loginSchema, type LoginValues } from '@/schemas/auth'
import { AuthShell } from './auth-shell'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [formError, setFormError] = useState<string | null>(null)
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await login(values)
      navigate(from, { replace: true })
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 401 ? 'That email and password don’t match an account.' : errorMessage(err),
      )
    }
  })

  return (
    <AuthShell
      title="Sign in"
      subtitle="Check your endpoints and recent deliveries."
      footer={
        <>
          New to Heimdall?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {formError && (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {formError}
          </div>
        )}
        <Field id="email" label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" autoFocus {...fieldA11y('email', errors.email?.message)} {...register('email')} />
        </Field>
        <Field id="password" label="Password" error={errors.password?.message}>
          <PasswordInput autoComplete="current-password" {...fieldA11y('password', errors.password?.message)} {...register('password')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" loading={isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  )
}
