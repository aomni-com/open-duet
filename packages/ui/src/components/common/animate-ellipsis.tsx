export function AnimatedEllipsis({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="animate-ping">.</span>
      <span className="animate-ping delay-100">.</span>
      <span className="animate-ping delay-200">.</span>
    </span>
  )
}
