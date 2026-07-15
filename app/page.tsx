export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 p-8 text-slate-100">
      <h1 className="text-3xl font-bold tracking-tight">BrawlRanks</h1>
      <p className="max-w-md text-center text-slate-400">
        Infrastructure proof-of-concept scaffold. This is a temporary page used to
        verify the Next.js 16 + Hostinger deployment pipeline. It is not the
        production BrawlRanks site.
      </p>
      <a
        href="/api/health"
        className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-slate-500 hover:bg-slate-900"
      >
        Check /api/health
      </a>
    </main>
  );
}
