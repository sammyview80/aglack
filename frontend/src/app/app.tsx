import { Agentation } from 'agentation'
import { AppProviders } from '@/app/providers'
import { AppRouter } from '@/app/router'

export default function App() {
  return (
    <>
      <AppProviders>
        <AppRouter />
      </AppProviders>
      {import.meta.env.DEV && <Agentation />}
    </>
  )
}
