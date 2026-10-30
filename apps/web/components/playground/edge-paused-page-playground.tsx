// Visual-evidence mirror only. Runtime ownership stays in apps/edge/src/paused-page.ts;
// the app import firewall deliberately prevents this playground from importing it.
export function EdgePausedPagePlayground() {
  return (
    <div
      data-edge-paused-page
      className="grid min-h-[100dvh] place-items-center px-6 text-center text-[#2a2723]"
      style={{
        background: 'radial-gradient(circle at 50% 38%, #fffdf8 0, #f4f0e8 58%, #e8e1d4 100%)',
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <main className="w-full max-w-[560px]">
        <div
          data-edge-paused-brand
          className="mb-[52px] inline-flex items-center gap-2.5 text-sm font-semibold uppercase tracking-[.08em] text-[#625b50]"
        >
          <span
            className="grid size-7 place-items-center rounded-[9px] bg-[#29251f] font-serif text-[17px] normal-case tracking-normal text-[#fffdf8]"
            aria-hidden="true"
          >
            D
          </span>{' '}
          Duet
        </div>
        <div
          data-edge-paused-status
          className="mb-[18px] text-xs font-bold uppercase tracking-[.14em] text-[#9b5f3b]"
        >
          App paused
        </div>
        <h1
          data-edge-paused-title
          className="m-0 font-serif text-[clamp(38px,8vw,62px)] font-medium leading-[1.03] tracking-[-.035em]"
        >
          Field Notes is paused
        </h1>
        <p
          data-edge-paused-body
          className="mx-auto mt-6 max-w-[420px] text-[17px] leading-[1.65] text-[#70685d]"
        >
          This app isn’t available right now. Please check back soon.
        </p>
        <footer data-edge-paused-mark className="mt-16 text-[13px] text-[#8a8175]">
          Built with <strong className="font-bold text-[#4c463e]">Duet</strong>
        </footer>
      </main>
    </div>
  )
}
