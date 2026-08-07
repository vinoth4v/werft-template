"use server"

import { redirect } from "next/navigation"
import { AuthError } from "next-auth"
import { signIn } from "@/auth"

export async function signInAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
  const password = String(formData.get("password") ?? "")

  try {
    await signIn("credentials", { email, password, redirectTo: "/" })
  } catch (error) {
    // A successful sign-in also throws — NEXT_REDIRECT — so only auth errors
    // are ours to handle. Anything else has to keep travelling.
    if (error instanceof AuthError) {
      redirect("/login?error=invalid")
    }
    throw error
  }
}
