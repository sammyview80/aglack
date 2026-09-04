import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { SlackOnboardingLayout } from './slack-onboarding-layout'
import { logout } from '@/features/auth/api'

vi.mock('@/features/auth/api', () => ({ logout: vi.fn() }))

beforeEach(() => vi.mocked(logout).mockReset())

it('logs out and returns to the login page', async () => {
  vi.mocked(logout).mockResolvedValue(undefined)
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={<SlackOnboardingLayout split={false}>Content</SlackOnboardingLayout>}
        />
        <Route path="/login" element={<p>Signed out</p>} />
      </Routes>
    </MemoryRouter>,
  )

  await userEvent.click(screen.getByRole('button', { name: 'Log out' }))

  expect(logout).toHaveBeenCalledOnce()
  expect(await screen.findByText('Signed out')).toBeInTheDocument()
})
