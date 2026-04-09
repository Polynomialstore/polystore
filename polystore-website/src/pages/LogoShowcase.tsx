export const LogoShowcase = () => {
  return (
    <div className="relative min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-8 overflow-hidden">
      <div className="absolute inset-0 cyber-grid opacity-35 pointer-events-none" />

      <div className="relative w-full max-w-3xl glass-panel industrial-border p-8 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.08)]">
        <div className="absolute inset-0 opacity-10 pointer-events-none cyber-grid" />

        <div className="text-center space-y-10">
          <div className="inline-flex items-center border border-border/50 bg-background/40 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
            /brand/assets
          </div>

          {/* Logo Preview */}
          <div className="relative mx-auto h-44 w-44 glass-panel industrial-border p-3 dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.18)]">
            <img
              src="/brand/logo-light-256.png"
              className="absolute inset-0 h-full w-full object-contain opacity-100 dark:opacity-0 transition-opacity"
              alt="PolyStore Logo (Light)"
            />
            <img
              src="/brand/logo-dark-256.png"
              className="absolute inset-0 h-full w-full object-contain opacity-0 dark:opacity-100 transition-opacity"
              alt="PolyStore Logo (Dark)"
            />
          </div>

          {/* Wordmark */}
          <div className="space-y-3">
            <div className="text-4xl sm:text-5xl font-extrabold tracking-tight">
              <span className="text-foreground">POLY</span>
              <span className="text-primary">STORE</span>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-[0.5em] font-mono-data text-muted-foreground">
              Structured Infinity
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-8 text-left">
            <div className="space-y-3">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">
                Palette
              </div>
              <div className="flex gap-3">
                <div className="h-8 w-8 border border-border bg-background" title="background" />
                <div className="h-8 w-8 border border-border bg-primary" title="primary" />
                <div className="h-8 w-8 border border-border bg-accent" title="accent" />
                <div className="h-8 w-8 border border-border bg-destructive" title="destructive" />
              </div>
              <p className="text-[11px] font-mono-data text-muted-foreground">
                Safety Orange for primary ops, Signal Green for healthy states, Alarm Red for faults.
              </p>
            </div>

            <div className="space-y-3">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">
                Typography
              </div>
              <p className="text-[11px] font-mono-data text-muted-foreground">
                Montserrat 700/800 for headers. <span className="text-foreground">`font-mono-data`</span> for CIDs, addresses, and readouts.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
