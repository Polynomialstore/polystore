export const LogoShowcase = () => {
  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-12 text-center">
        
        {/* SVG Container */}
        <div className="relative w-96 h-96 mx-auto">
          <img 
            src="/logo_vector.svg" 
            alt="NilStore Vector Logo" 
            className="w-full h-full object-contain"
          />
        </div>

        {/* Brand Mark */}
        <div className="space-y-2">
          <h1 
            className="text-6xl font-extrabold tracking-widest uppercase"
            style={{
              fontFamily: "'Montserrat', sans-serif",
              background: "linear-gradient(90deg, #00E5FF 0%, #7B2CBF 50%, #E056FD 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              filter: "drop-shadow(0 0 10px rgba(0, 229, 255, 0.3))"
            }}
          >
            NilStore
          </h1>
          <p className="text-slate-500 font-mono tracking-[0.5em] text-sm uppercase">
            Structured Infinity
          </p>
        </div>

        <div className="grid grid-cols-2 gap-8 text-left text-slate-400 text-sm border-t border-slate-800 pt-8">
            <div>
                <h3 className="text-cyan-400 font-bold mb-2">Color Palette</h3>
                <div className="flex gap-2 mb-2">
                    <div className="w-6 h-6 bg-[#00E5FF]" title="#00E5FF"></div>
                    <div className="w-6 h-6 bg-[#7B2CBF]" title="#7B2CBF"></div>
                    <div className="w-6 h-6 bg-[#E056FD]" title="#E056FD"></div>
                </div>
                <p>Electric Cyan to Neon Violet</p>
            </div>
            <div>
                <h3 className="text-purple-400 font-bold mb-2">Typography</h3>
                <p className="font-bold" style={{ fontFamily: "'Montserrat', sans-serif" }}>Montserrat Bold</p>
                <p>Geometric Sans-Serif</p>
            </div>
        </div>

      </div>
    </div>
  );
};
