import React, { useEffect, useRef } from 'react';

interface SubLine {
  dx: number; // grid offset from entity center
  dy: number; // grid offset from entity center
  horizontal: boolean;
  length: number; // in grid cells
  offset: number; // animation offset for the "glow"
  speed: number;  // animation speed for the "glow"
}

interface ThetaEntity {
  id: number;
  x: number; // Screen pixel X
  y: number; // Screen pixel Y
  theta: number; // Intended direction
  speed: number;
  life: number;
  color: string;
  subLines: SubLine[];
}

export const LivingGrid: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<ThetaEntity[]>([]);
  const mouseRef = useRef({ x: 0, y: 0, v: 0, accumulator: 0 });
  const lastTimeRef = useRef(0);
  const idCounter = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const gridSize = 30;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const spawnEntity = (x: number, y: number) => {
      if (entitiesRef.current.length > 12) return;

      const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      const hslColor = `hsl(${color})`;
      
      const subLines: SubLine[] = [];
      const lineCount = 3 + Math.floor(Math.random() * 3);
      
      for (let i = 0; i < lineCount; i++) {
        subLines.push({
          dx: (Math.floor(Math.random() * 5) - 2) * gridSize,
          dy: (Math.floor(Math.random() * 5) - 2) * gridSize,
          horizontal: Math.random() > 0.5,
          length: 1 + Math.floor(Math.random() * 3),
          offset: Math.random() * 100,
          speed: 0.05 + Math.random() * 0.1
        });
      }

      entitiesRef.current.push({
        id: idCounter.current++,
        x,
        y,
        theta: Math.random() * Math.PI * 2,
        speed: 1.2 + Math.random() * 1.8,
        life: 1.0,
        color: hslColor,
        subLines
      });
    };

    const updateMouse = (e: MouseEvent) => {
      const dx = e.clientX - mouseRef.current.x;
      const dy = e.clientY - mouseRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      const v = parseFloat(document.documentElement.style.getPropertyValue('--mouse-v') || '0');
      mouseRef.current.v = v;

      mouseRef.current.accumulator += dist;
      if (mouseRef.current.accumulator > 120) {
        spawnEntity(e.clientX, e.clientY);
        mouseRef.current.accumulator = 0;
      }
    };

    const animate = (time: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = time;
      const dt = (time - lastTimeRef.current) / 16.66;
      lastTimeRef.current = time;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const entities = entitiesRef.current;

      for (let i = entities.length - 1; i >= 0; i--) {
        const ent = entities[i];
        
        // Smooth movement in Theta direction
        ent.x += Math.cos(ent.theta) * ent.speed * dt;
        ent.y += Math.sin(ent.theta) * ent.speed * dt;
        ent.life -= 0.004 * dt;

        if (ent.life <= 0 || ent.x < -300 || ent.x > canvas.width + 300 || ent.y < -300 || ent.y > canvas.height + 300) {
          entities.splice(i, 1);
          continue;
        }

        ent.subLines.forEach(line => {
          line.offset += line.speed * dt;
          
          // Drift the sub-lines slightly from center
          line.dx += (Math.random() - 0.5) * 0.4 * dt;
          line.dy += (Math.random() - 0.5) * 0.4 * dt;

          // Snap drawing to grid relative to entity center
          const gx = Math.round((ent.x + line.dx) / gridSize) * gridSize;
          const gy = Math.round((ent.y + line.dy) / gridSize) * gridSize;
          
          const x1 = line.horizontal ? gx - gridSize : gx;
          const y1 = line.horizontal ? gy : gy - gridSize;
          const x2 = line.horizontal ? gx + gridSize * line.length : gx;
          const y2 = line.horizontal ? gy : gy + gridSize * line.length;

          // Drawing with "Bleed"
          const pulse = (Math.sin(line.offset) + 1) / 2;
          const baseAlpha = ent.life * (0.4 + pulse * 0.6);

          // 1. THE BLEED: Wide, soft stroke that "blurs into the boxes"
          ctx.beginPath();
          ctx.lineWidth = 15; // Spans half the grid cell
          ctx.strokeStyle = ent.color;
          ctx.globalAlpha = baseAlpha * 0.15;
          ctx.lineCap = 'round';
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // 2. THE CORE: Sharp, bright grid line
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.globalAlpha = baseAlpha * 0.8;
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // 3. OPTIONAL GLOW: Tighter bloom
          ctx.shadowBlur = 6;
          ctx.shadowColor = ent.color;
          ctx.globalAlpha = baseAlpha * 0.3;
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.shadowBlur = 0;
        });
      }

      // Stochastic spawn
      if (Math.random() < 0.015) {
        spawnEntity(Math.random() * canvas.width, Math.random() * canvas.height);
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', updateMouse);
    resize();
    requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', updateMouse);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[1] opacity-70 dark:opacity-90"
    />
  );
};
