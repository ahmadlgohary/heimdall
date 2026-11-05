import { zodResolver } from '@hookform/resolvers/zod'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { PasswordInput } from '@/components/common/password-input'
import { Button } from '@/components/ui/button'
import { Field, fieldA11y } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts/auth-context'
import { ApiError, errorMessage } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { registerSchema, type RegisterValues } from '@/schemas/auth'
import { AuthShell } from './auth-shell'

const RULES = [
  { label: '12+ characters', test: (v: string) => v.length >= 12 },
  { label: 'Upper and lowercase', test: (v: string) => /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { label: 'A number', test: (v: string) => /\d/.test(v) },
]

export default function RegisterPage() {
  const { register: signUp } = useAuth()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '', confirm: '' },
  })
  const password = useWatch({ control, name: 'password' })

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setFormError(null)
    try {
      await signUp({ email, password })
      navigate('/dashboard', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('email', { message: 'An account with this email already exists. Sign in instead.' })
      } else {
        setFormError(errorMessage(err))
      }
    }
  })

  return (
    <AuthShell
      title="Create your account"
      subtitle="Register endpoints and start sending signed webhooks."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
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
          <PasswordInput autoComplete="new-password" {...fieldA11y('password', errors.password?.message)} {...register('password')} />
        </Field>
        <ul className="-mt-1.5 flex flex-wrap gap-x-4 gap-y-1" aria-label="Password requirements">
          {RULES.map((r) => {
            const ok = r.test(password)
            return (
              <li key={r.label} className={cn('flex items-center gap-1.5 text-sm transition-colors', ok ? 'text-success' : 'text-faint')}>
                <Check className="size-3.5" aria-hidden strokeWidth={ok ? 3 : 2} />
                {r.label}
                <span className="sr-only">{ok ? '(met)' : '(not met)'}</span>
              </li>
            )
          })}
        </ul>
        <Field id="confirm" label="Confirm password" error={errors.confirm?.message}>
          <PasswordInput autoComplete="new-password" {...fieldA11y('confirm', errors.confirm?.message)} {...register('confirm')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthShell>
  )
}
