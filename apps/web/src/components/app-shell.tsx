import type { ReactNode } from "react"
import { signOutAction } from "@/app/actions"
import { Box, LayoutGrid, LogOut, User } from "@/components/icons"

type AppShellProps = {
  children: ReactNode
  userEmail?: string | null
}

export function AppShell({ children, userEmail }: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="container cluster" style={{ justifyContent: "space-between" }}>
          <a href="/" className="logo">
            <Box size={24} />
            <span>Werft</span>
          </a>

          <nav className="nav cluster">
            <a href="/" className="nav-link active">
              <LayoutGrid size={16} />
              Marketplace
            </a>
            <a href="https://github.com/vinoth4v/werft-template" className="nav-link">
              Docs
            </a>
          </nav>

          <div className="cluster user-menu">
            {userEmail ? (
              <>
                <span className="user-email">
                  <User size={14} />
                  {userEmail}
                </span>
                <form action={signOutAction}>
                  <button type="submit" className="icon-button" title="Sign out">
                    <LogOut size={16} />
                  </button>
                </form>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <main className="app-main">{children}</main>

      <footer className="app-footer">
        <div className="container">
          <p className="muted">Werft template — scaffold, deploy, and share apps.</p>
        </div>
      </footer>
    </div>
  )
}
