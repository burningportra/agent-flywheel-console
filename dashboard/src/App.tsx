const panels = [
  'PipelineView',
  'BeadBoard',
  'AgentPanel',
  'PromptLibrary',
  'LogStream',
  'MemoryPanel',
]

function App() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(253,224,71,0.18),_transparent_28%),linear-gradient(180deg,_#f7f1e8_0%,_#efe7db_55%,_#e6dece_100%)] text-stone-900">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-10 px-6 py-8 lg:px-10">
        <header className="flex flex-col gap-6 rounded-[2rem] border border-stone-900/10 bg-white/70 p-8 shadow-[0_24px_80px_rgba(33,24,12,0.12)] backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-700">
                Agent Flywheel Console
              </p>
              <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-stone-950 sm:text-5xl">
                Dashboard bootstrap is live and ready for the data layer.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-stone-700">
                This T11.1 slice wires Vite, Tailwind, TanStack Query, and the
                local server proxy so the next beads can focus on real pipeline,
                agent, and prompt data instead of setup work.
              </p>
            </div>
            <div className="rounded-full border border-emerald-700/20 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800">
              localhost:5173 → localhost:4200
            </div>
          </div>
          <div className="grid gap-3 text-sm text-stone-700 sm:grid-cols-3">
            <div className="rounded-2xl border border-stone-900/10 bg-stone-950 px-4 py-3 text-stone-100">
              Query client provider mounted
            </div>
            <div className="rounded-2xl border border-stone-900/10 bg-white px-4 py-3">
              Tailwind v4 wired through Vite
            </div>
            <div className="rounded-2xl border border-stone-900/10 bg-white px-4 py-3">
              WebSocket and API proxies configured
            </div>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {panels.map((panel, index) => (
            <article
              key={panel}
              className="group rounded-[1.75rem] border border-stone-900/10 bg-white/75 p-6 shadow-[0_20px_60px_rgba(33,24,12,0.08)] transition-transform duration-200 hover:-translate-y-1"
            >
              <div className="mb-5 flex items-center justify-between">
                <span className="rounded-full bg-stone-950 px-3 py-1 text-xs font-medium tracking-[0.2em] text-stone-100">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="text-xs uppercase tracking-[0.24em] text-stone-500">
                  planned panel
                </span>
              </div>
              <h2 className="text-2xl font-semibold tracking-tight text-stone-950">
                {panel}
              </h2>
              <p className="mt-3 text-sm leading-6 text-stone-600">
                Ready for the next bead to connect normalized server state and
                live events without replacing the app shell.
              </p>
            </article>
          ))}
        </section>
      </div>
    </main>
  )
}

export default App
