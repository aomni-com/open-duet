/**
 * A whisper-subtle living backdrop: two large, soft, blurred tone-blobs that drift
 * very slowly behind the hero, adding depth and gentle motion without competing
 * with the particle field — and without breaking the rationed-blue rule (neutral
 * band tones only, never the brand accent). Static under reduced motion (the
 * `@media (prefers-reduced-motion)` rule in landing-styles.css kills the keyframes).
 */
export function SubtleBackdrop({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
    >
      <div
        className="lv2-aurora absolute left-[-16%] top-[-24%] aspect-square w-[62%] rounded-full"
        style={{
          background: 'radial-gradient(circle at center, var(--lv2-band-cool), transparent 68%)',
          filter: 'blur(66px)',
          opacity: 0.75,
          animation: 'lv2-aurora-a 30s ease-in-out infinite',
        }}
      />
      <div
        className="lv2-aurora absolute right-[-14%] bottom-[-26%] aspect-square w-[54%] rounded-full"
        style={{
          background: 'radial-gradient(circle at center, var(--lv2-band-warm), transparent 68%)',
          filter: 'blur(74px)',
          opacity: 0.65,
          animation: 'lv2-aurora-b 38s ease-in-out infinite',
        }}
      />
    </div>
  )
}
