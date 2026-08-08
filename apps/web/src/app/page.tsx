import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { THEMES, type Theme } from "@werft/tokens"
import type { Metadata } from "next"
import { auth } from "@/auth"
import { AppShell } from "@/components/app-shell"
import {
  ArrowRight,
  Box,
  ExternalLink,
  Layers,
  Palette,
  Shield,
  Sparkles,
  Sun,
  Terminal,
  Zap,
} from "@/components/icons"
import { MarketplaceCard } from "@/components/marketplace-card"
import { ThemePreview } from "@/components/theme-preview"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Werft Marketplace",
}

const FEATURES = [
  {
    icon: <Zap size={20} />,
    title: "One-command deploy",
    description: "From a prompt to a live Next.js app on Vercel with a Neon database.",
  },
  {
    icon: <Shield size={20} />,
    title: "Closed by default",
    description: "Every route is protected until you explicitly open it.",
  },
  {
    icon: <Layers size={20} />,
    title: "Token-driven design",
    description: "Switch themes without touching a single component.",
  },
  {
    icon: <Terminal size={20} />,
    title: "Agent-ready",
    description: "Built for Claude Code and other agentic tools to extend safely.",
  },
]

export default async function HomePage() {
  const session = await auth()
  const werftJson = await readFile(join(process.cwd(), "werft.json"), "utf8").catch(() => "{}")
  const app = JSON.parse(werftJson) as {
    name?: string
    title?: string
    description?: string
    stack?: string[]
    tags?: string[]
    status?: string
    url?: string
  }

  const themes = Object.entries(THEMES).map(([key, theme]) => ({
    key,
    ...(theme as Theme),
  }))

  return (
    <AppShell userEmail={session?.user?.email}>
      <section className="hero">
        <div className="container">
          <div className="hero-content">
            <span className="hero-eyebrow">
              <Sparkles size={14} />
              Werft template marketplace
            </span>
            <h1 className="hero-title">Build and launch apps with a single command.</h1>
            <p className="hero-description">
              Werft scaffolds opinionated Next.js apps with auth, database, migrations, theming, and
              CI — then deploys them so you can focus on the product.
            </p>
            <div className="hero-actions">
              <a href="#featured" className="button">
                Explore the template
                <ArrowRight size={18} />
              </a>
              <a href="https://github.com/vinoth4v/werft-template" className="button-ghost">
                View on GitHub
                <ExternalLink size={16} />
              </a>
            </div>
          </div>
        </div>
      </section>

      <section id="featured" className="section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Featured app</h2>
            <p className="section-subtitle">The current app running on this deployment.</p>
          </div>
          <MarketplaceCard
            icon={<Box size={22} />}
            title={app.title ?? app.name ?? "Werft app"}
            description={app.description ?? "A Werft-scaffolded app."}
            tags={app.stack}
            status={app.status}
            href={app.url || undefined}
            action={<span className="button-ghost button-sm">Open app</span>}
          />
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Design themes</h2>
            <p className="section-subtitle">
              Same components, different personalities. The Kimi themes are sampled from public Kimi
              Websites showcases.
            </p>
          </div>
          <div className="grid" style={{ "--grid-item-min": "18rem" } as React.CSSProperties}>
            {themes.map((theme) => (
              <div key={theme.key} className="card">
                <ThemePreview colors={theme.color} />
                <h3 className="card-title">{theme.label}</h3>
                <p className="card-description">{theme.inspiration}</p>
                <div className="cluster tag-list">
                  {theme.key.startsWith("kimi") ? (
                    <span className="badge">
                      <Palette size={12} />
                      Kimi
                    </span>
                  ) : null}
                  {theme.fontFamily?.sans.includes("mono") ? (
                    <span className="tag">Mono</span>
                  ) : null}
                  {theme.fontFamily?.sans.includes("serif") ? (
                    <span className="tag">Serif</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Why Werft?</h2>
            <p className="section-subtitle">
              Conventions that keep agentic development safe and fast.
            </p>
          </div>
          <div className="grid" style={{ "--grid-item-min": "16rem" } as React.CSSProperties}>
            {FEATURES.map((feature) => (
              <div key={feature.title} className="card">
                <div className="card-icon">{feature.icon}</div>
                <h3 className="card-title">{feature.title}</h3>
                <p className="card-description">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Activity</h2>
            <p className="section-subtitle">Recent events from the audit log will appear here.</p>
          </div>
          <div className="empty-state">
            <span className="empty-state-icon">
              <Sun size={32} />
            </span>
            <p>No activity yet. Sign in events and deployments will be recorded here.</p>
          </div>
        </div>
      </section>
    </AppShell>
  )
}
