# Google OAuth login

Replace shared admin-password login with Google Authorization Code OAuth.

- `GET /auth/google` creates one-time CSRF state and redirects to Google.
- `GET /auth/google/callback` exchanges code, reads verified Google identity,
  stores user/session, sets existing `HttpOnly` session cookie, then redirects
  to `FRONTEND_ORIGIN`.
- Existing logout, session middleware, and `/auth/me` remain unchanged.
- Any verified Google account is accepted for this prototype.
- OAuth provider URLs and credentials come from gateway env config.
