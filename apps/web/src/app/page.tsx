import { signOutAction } from "@/app/actions"
import { auth } from "@/auth"

// Reads the session cookie, so there is nothing to prerender.
export const dynamic = "force-dynamic"

export default async function HomePage() {
  const session = await auth()

  return (
    <main>
      <h1>Werft app</h1>
      <p>
        Signed in as <strong>{session?.user?.email ?? "unknown"}</strong>.
      </p>
      <p>Replace this page with the app you actually meant to build.</p>
      <form action={signOutAction}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
