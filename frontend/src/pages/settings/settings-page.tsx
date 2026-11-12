import { zodResolver } from '@hookform/resolvers/zod'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { PasswordInput } from '@/components/common/password-input'
import { PageHeader, Panel } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Field, fieldA11y } from '@/components/ui/field'
import { useAuth } from '@/contexts/auth-context'
import { useTheme, type ThemePreference } from '@/contexts/theme-context'
import { ApiError, errorMessage } from '@/lib/api-client'
import { cn, formatDateTime } from '@/lib/utils'
import { changePasswordSchema, type ChangePasswordValues } from '@/schemas/auth'
import { authService } from '@/services/auth.service'

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'Match system', icon: Monitor },
]

const RETRY_SCHEDULE = [
  { n: 1, delay: 'Immediately' },
  { n: 2, delay: '30 seconds later' },
  { n: 3, delay: '2 minutes later' },
  { n: 4, delay: '8 minutes later' },
  { n: 5, delay: '30 minutes later' },
]

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-border py-8 first:pt-0 last:border-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-base text-muted">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function ChangePasswordForm() {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current_password: '', new_password: '', confirm: '' },
  })

  return (
    <Panel bodyClassName="p-4 sm:p-5">
      <form
        noValidate
        className="grid max-w-md gap-4"
        onSubmit={handleSubmit(async ({ current_password, new_password }) => {
          try {
            await authService.changePassword({ current_password, new_password })
            reset()
            toast.success('Password changed')
          } catch (err) {
            if (err instanceof ApiError && (err.status === 400 || err.status === 401)) {
              setError('current_password', { message: 'That isn’t your current password.' })
            } else {
              toast.error(errorMessage(err))
            }
          }
        })}
      >
        <Field id="current_password" label="Current password" error={errors.current_password?.message}>
          <PasswordInput autoComplete="current-password" {...fieldA11y('current_password', errors.current_password?.message)} {...register('current_password')} />
        </Field>
        <Field id="new_password" label="New password" error={errors.new_password?.message} hint="At least 12 characters, with upper and lowercase letters and a number.">
          <PasswordInput autoComplete="new-password" {...fieldA11y('new_password', errors.new_password?.message, true)} {...register('new_password')} />
        </Field>
        <Field id="confirm_new" label="Confirm new password" error={errors.confirm?.message}>
          <PasswordInput autoComplete="new-password" {...fieldA11y('confirm_new', errors.confirm?.message)} {...register('confirm')} />
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={isSubmitting}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  )
}

export default function SettingsPage() {
  const { user } = useAuth()
  const { preference, setPreference } = useTheme()

  return (
    <>
      <PageHeader title="Settings" description="Your account and how Heimdall looks for you." />

      <Section title="Account" description="The email you sign in with.">
        <Panel bodyClassName="p-4 sm:p-5">
          <dl className="grid gap-3 text-base sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted">Email</dt>
              <dd className="mt-0.5 font-medium break-all">{user?.email}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Member since</dt>
              <dd className="mt-0.5">{user?.created_at ? formatDateTime(user.created_at).split(',')[0] : '—'}</dd>
            </div>
          </dl>
        </Panel>
      </Section>

      <Section title="Password" description="Changing your password signs out your other sessions.">
        {user?.is_demo ? (
          <Panel bodyClassName="p-4 sm:p-5">
            <p className="text-base text-muted">
              Demo copies don’t have a password: you’re signed in for this visit only. Create your own account to try
              this.
            </p>
          </Panel>
        ) : (
          <ChangePasswordForm />
        )}
      </Section>

      <Section title="Appearance" description="Saved in this browser.">
        <div role="radiogroup" aria-label="Theme" className="grid max-w-lg grid-cols-3 gap-2">
          {THEMES.map(({ value, label, icon: Icon }) => {
            const active = preference === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setPreference(value)}
                className={cn(
                  'flex flex-col items-start gap-3 rounded-md border px-3.5 py-3 text-left text-base transition-colors',
                  active ? 'border-primary bg-primary-soft text-foreground' : 'border-border-strong text-muted hover:bg-surface-hover hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            )
          })}
        </div>
      </Section>

      <Section
        title="Retry policy"
        description="Failed deliveries are retried on this schedule. A per-account policy is planned."
      >
        <Panel>
          <ol className="divide-y divide-border">
            {RETRY_SCHEDULE.map((r) => (
              <li key={r.n} className="flex items-center justify-between px-4 py-2.5 text-base sm:px-5">
                <span>Attempt {r.n}</span>
                <span className="tabular text-muted">{r.delay}</span>
              </li>
            ))}
          </ol>
          <p className="border-t border-border px-4 py-3 text-sm text-muted sm:px-5">
            Retried: timeouts, connection errors, 408, 425, 429 and 5xx. Other 4xx responses fail immediately.
          </p>
        </Panel>
      </Section>
    </>
  )
}
