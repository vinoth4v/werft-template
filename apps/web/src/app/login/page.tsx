import { signInAction } from "./actions.ts"

export const dynamic = "force-dynamic"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Sign in</h1>
        <p className="lead">Enter the operator credentials to open the marketplace.</p>

        {error ? <p role="alert">That email and password combination was not accepted.</p> : null}

        <form action={signInAction} className="login-form">
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="operator@example.com"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              required
            />
          </div>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </div>
  )
}
