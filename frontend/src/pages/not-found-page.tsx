import { Link } from 'react-router'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-start py-16">
      <p className="mono-tight text-sm text-muted">404</p>
      <h1 className="display mt-2 text-2xl font-semibold">This page doesn’t exist</h1>
      <p className="mt-2 text-base text-muted">The link may be outdated, or the resource was deleted.</p>
      <Button asChild variant="secondary" className="mt-6">
        <Link to="/dashboard">Go to overview</Link>
      </Button>
    </div>
  )
}
