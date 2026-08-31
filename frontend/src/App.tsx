/**
 * Minimal route table for the revamp scaffold. This only wires up enough
 * routing to render the copied CreateWorkspace screen at "/create" (and
 * redirects "/" there, since HomePage hasn't been ported yet). Modeled on
 * the original project's src/App.tsx route-table pattern.
 */
import { Navigate, Route, Routes } from 'react-router-dom'
import { CreatePage } from './routes/CreatePage'
import { useState } from 'react'

function App() {
  const [error, setError] = useState('')

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/create" replace />} />
      <Route path="/create" element={<CreatePage error={error} setError={setError} />} />
      <Route path="*" element={<Navigate to="/create" replace />} />
    </Routes>
  )
}

export default App
