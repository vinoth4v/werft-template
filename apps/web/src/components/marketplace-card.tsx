import type { ReactNode } from "react"
import { ArrowRight, ExternalLink } from "@/components/icons"

type MarketplaceCardProps = {
  icon: ReactNode
  title: string
  description: string
  tags?: string[]
  status?: string
  href?: string
  action?: ReactNode
}

export function MarketplaceCard({
  icon,
  title,
  description,
  tags,
  status,
  href,
  action,
}: MarketplaceCardProps) {
  const content = (
    <>
      <div className="card-header">
        <div className="card-icon">{icon}</div>
        {status ? <span className="badge">{status}</span> : null}
      </div>
      <h3 className="card-title">{title}</h3>
      <p className="card-description">{description}</p>
      {tags && tags.length > 0 ? (
        <div className="cluster tag-list">
          {tags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {action ? <div className="card-action">{action}</div> : null}
    </>
  )

  if (href) {
    return (
      <a href={href} className="card card-interactive">
        {content}
        <span className="card-link-indicator">
          <ExternalLink size={14} />
        </span>
      </a>
    )
  }

  return <div className="card">{content}</div>
}

export function CardAction({ children, href }: { children: ReactNode; href?: string }) {
  if (href) {
    return (
      <a href={href} className="button-ghost button-sm">
        {children}
        <ArrowRight size={14} />
      </a>
    )
  }
  return (
    <button type="submit" className="button-ghost button-sm">
      {children}
      <ArrowRight size={14} />
    </button>
  )
}
