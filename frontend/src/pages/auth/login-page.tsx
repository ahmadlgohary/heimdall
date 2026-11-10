import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
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
import { authService } from '@/services/auth.service'
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

  const signIn = async (values: LoginValues) => {
    setFormError(null)
    try {
      await login(values)
      navigate(from, { replace: true })
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 401 ? 'That email and password don’t match an account.' : errorMessage(err),
      )
    }
  }
  const onSubmit = handleSubmit(signIn)

  const demo = useQuery({ queryKey: ['demo-info'], queryFn: authService.demo, staleTime: Infinity, retry: false })
  const [demoPending, setDemoPending] = useState(false)

  return (
    <AuthShell
      aside={
        demo.data?.enabled && demo.data.email && demo.data.password ? (
          <DemoPanel
            email={demo.data.email}
            password={demo.data.password}
            pending={demoPending}
            onSignIn={async () => {
              setDemoPending(true)
              await signIn({ email: demo.data.email!, password: demo.data.password! })
              setDemoPending(false)
            }}
          />
        ) : null
      }
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

function DemoPanel({
  email,
  password,
  pending,
  onSignIn,
}: {
  email: string
  password: string
  pending: boolean
  onSignIn: () => void
}) {
  return (
    <section aria-labelledby="demo-title" className="mt-6 rounded-lg border border-dashed border-border-strong px-5 py-4">
      <h2 id="demo-title" className="text-base font-semibold">
        Try the demo
      </h2>
      <p className="mt-1 text-sm text-muted">
        A shared account with sample history and a built-in test receiver, so the events you send are really delivered.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Email</dt>
        <dd className="mono-tight break-all">{email}</dd>
        <dt className="text-muted">Password</dt>
        <dd className="mono-tight">{password}</dd>
      </dl>
      <Button variant="secondary" className="mt-4 w-full" loading={pending} onClick={onSignIn}>
        Sign in to the demo
      </Button>
    </section>
  )
}
