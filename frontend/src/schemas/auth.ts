import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Enter your password.'),
})

export const passwordRules = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use 128 characters or fewer.')
  .regex(/[a-z]/, 'Include a lowercase letter.')
  .regex(/[A-Z]/, 'Include an uppercase letter.')
  .regex(/\d/, 'Include a number.')

export const registerSchema = z
  .object({
    email: z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.')),
    password: passwordRules,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords don’t match.' })

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, 'Enter your current password.'),
    new_password: passwordRules,
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, { path: ['confirm'], message: 'Passwords don’t match.' })

export type LoginValues = z.infer<typeof loginSchema>
export type RegisterValues = z.infer<typeof registerSchema>
export type ChangePasswordValues = z.infer<typeof changePasswordSchema>
