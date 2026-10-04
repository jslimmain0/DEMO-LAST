import type { ReactNode } from 'react'
import '../design/workspace-pages.css'

export function PageHeader({ title, description, count, actions, children }: { title: string; description?: ReactNode; count?: number; actions?: ReactNode; children?: ReactNode }) {
  return <header className="fl-page-header">
    <div className="fl-page-heading"><div className="fl-page-intro"><h1><span className="fl-page-title">{title}</span>{count != null && <span className="fl-page-count">{count}</span>}</h1>{description && <p>{description}</p>}</div>{actions && <div className="fl-page-actions">{actions}</div>}</div>
    {children}
  </header>
}
