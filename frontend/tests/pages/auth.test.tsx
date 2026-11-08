import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEMO } from '@/mocks/db'
import { renderApp } from '../utils'

describe('authentication', () => {
  it('renders the login form', async () => {
    renderApp('/login')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('validates required fields before submitting', async () => {
    const { user } = renderApp('/login')
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
  })

  it('toggles password visibility', async () => {
    const { user } = renderApp('/login')
    const input = await screen.findByLabelText('Password')
    expect(input).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')
  })

  it('shows an error for wrong credentials', async () => {
    const { user } = renderApp('/login')
    await user.type(await screen.findByLabelText('Email'), DEMO.email)
    await user.type(screen.getByLabelText('Password'), 'not-the-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password don’t match an account.')
  })

  it('redirects to the dashboard after signing in', async () => {
    const { user, router } = renderApp('/login')
    await user.type(await screen.findByLabelText('Email'), DEMO.email)
    await user.type(screen.getByLabelText('Password'), DEMO.password)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })

  it('redirects unauthenticated users from protected routes to login', async () => {
    const { router } = renderApp('/events')
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('registers a new account and rejects duplicate emails', async () => {
    const { user, router } = renderApp('/register')
    await user.type(await screen.findByLabelText('Email'), DEMO.email)
    await user.type(screen.getByLabelText('Password'), 'StrongPassword1')
    await user.type(screen.getByLabelText('Confirm password'), 'StrongPassword1')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/already exists/)).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Email'))
    await user.type(screen.getByLabelText('Email'), 'fresh@example.com')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
  })
})
