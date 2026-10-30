export default function DesktopFrameFixture() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[radial-gradient(circle_at_28%_22%,#7796b7_0,#34516d_32%,#162536_75%)] font-sans text-[#ecf3fa]">
      <div className="flex h-[34px] items-center bg-[#121821e0] px-[15px] text-[13px] shadow-lg">
        <strong className="mr-auto">Duet workspace</strong>
        <span>Tue 05:45</span>
      </div>
      <section className="absolute inset-x-[72px] bottom-[78px] top-[58px] overflow-hidden rounded-[10px] bg-[#f7f8fa] text-[#1d2733] shadow-2xl">
        <div className="flex h-[42px] items-center bg-[#e9edf2] px-[15px] text-[13px]">
          <span className="mr-[14px] flex gap-[7px]" aria-hidden>
            <i className="size-[11px] rounded-full bg-[#ff665f]" />
            <i className="size-[11px] rounded-full bg-[#eab846]" />
            <i className="size-[11px] rounded-full bg-[#52bf6a]" />
          </span>
          <span className="h-[27px] flex-1 rounded-lg bg-white px-3 py-1.5 text-[#647080]">
            https://docs.example.com/research
          </span>
        </div>
        <div className="grid h-[calc(100%-42px)] place-items-center bg-gradient-to-br from-[#fbfdff] to-[#e9f0f8] text-center">
          <div>
            <h1 className="text-[38px] font-semibold">Research workspace</h1>
            <p className="mt-3 text-[17px] text-[#657487]">The shared browser is ready.</p>
          </div>
        </div>
      </section>
      <div className="absolute bottom-4 left-1/2 flex h-[52px] -translate-x-1/2 gap-2.5 rounded-[15px] border border-white/20 bg-[#111927cc] px-[13px] py-[7px] shadow-xl">
        <i className="relative size-[38px] rounded-[10px] bg-gradient-to-br from-[#72a9ff] to-[#335ecc] after:absolute after:-bottom-[5px] after:left-4 after:size-[5px] after:rounded-full after:bg-white" />
        {[0, 1, 2].map(item => (
          <i
            key={item}
            className="size-[38px] rounded-[10px] bg-gradient-to-br from-[#e4eaf2] to-[#8ca2bc]"
          />
        ))}
      </div>
    </main>
  )
}
