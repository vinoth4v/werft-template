import { signInAction } from "./actions.ts"

export const dynamic = "force-dynamic"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main>
      <h1>Sign in</h1>

      {error ? (
        // Never say which half was wrong.
        <p role="alert">That email and password combination was not accepted.</p>
      ) : null}

      <form action={signInAction}>
        <p>
          <label htmlFor="email">Email</label>
          <br />
          <input id="email" name="email" type="email" autoComplete="username" required />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </p>
        <button type="submit">Sign in</button>
      </form>
    </main>
  )
}
