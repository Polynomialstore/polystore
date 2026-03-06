import React, { useEffect, useRef } from 'react';

interface SmoothEntity {
  id: number;
  x: number; // Smooth pixel center X
  y: number; // Smooth pixel center Y
  theta: number; // Movement direction
  thetaDrift: number; // Angular velocity
  speed: number;
  life: number;
  color: string;
  radius: number; // Spacial extent of the wave packet
  wavePhase: number;
}

export const LivingGrid: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<SmoothEntity[]>([]);
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
      if (entitiesRef.current.length > 15) return;

      const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      const hslColor = `hsl(${color})`;
      
      entitiesRef.current.push({
        id: idCounter.current++,
        x,
        y,
        theta: Math.random() * Math.PI * 2,
        thetaDrift: (Math.random() - 0.5) * 0.02, // Subtle curve to break cardinal bias
        speed: 1.2 + Math.random() * 1.8,
        life: 1.0,
        color: hslColor,
        radius: 100 + Math.random() * 80,
        wavePhase: Math.random() * Math.PI * 2
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
        
        // 1. SMOOTH UNDERLYING MOTION WITH CURVATURE
        ent.theta += ent.thetaDrift * dt;
        ent.x += Math.cos(ent.theta) * ent.speed * dt;
        ent.y += Math.sin(ent.theta) * ent.speed * dt;
        ent.life -= 0.003 * dt;
        ent.wavePhase += 0.06 * dt;

        if (ent.life <= 0 || ent.x < -300 || ent.x > canvas.width + 300 || ent.y < -300 || ent.y > canvas.height + 300) {
          entities.splice(i, 1);
          continue;
        }

        // 2. FIXED-GRID CONDUIT ACTIVATION
        const minX = Math.floor((ent.x - ent.radius) / gridSize) * gridSize;
        const maxX = Math.ceil((ent.x + ent.radius) / gridSize) * gridSize;
        const minY = Math.floor((ent.y - ent.radius) / gridSize) * gridSize;
        const maxY = Math.ceil((ent.y + ent.radius) / gridSize) * gridSize;

        const pulse = (Math.sin(ent.wavePhase) + 1) / 2;
        const globalOpacity = ent.life * (0.4 + pulse * 0.6);

        // Draw Vertical Conduits
        for (let gx = minX; gx <= maxX; gx += gridSize) {
          const dx = Math.abs(gx - ent.x);
          if (dx > ent.radius) continue;

          const horizontalIntensity = Math.pow(1 - dx / ent.radius, 4);
          const yStart = minY;
          const yEnd = maxY;

          const grad = ctx.createLinearGradient(gx, yStart, gx, yEnd);
          const relativeCenter = (ent.y - yStart) / (yEnd - yStart);
          const gradWidth = (ent.radius * horizontalIntensity) / (yEnd - yStart);

          grad.addColorStop(Math.max(0, relativeCenter - gradWidth), 'transparent');
          grad.addColorStop(Math.max(0, Math.min(1, relativeCenter)), ent.color);
          grad.addColorStop(Math.min(1, relativeCenter + gradWidth), 'transparent');

          drawConduit(ctx, gx, yStart, gx, yEnd, grad, globalOpacity * horizontalIntensity);
        }

        // Draw Horizontal Conduits
        for (let gy = minY; gy <= maxY; gy += gridSize) {
          const dy = Math.abs(gy - ent.y);
          if (dy > ent.size) continue;

          const verticalIntensity = Math.pow(1 - dy / ent.radius, 4);
          const xStart = minX;
          const xEnd = maxX;

          const grad = ctx.createLinearGradient(xStart, gy, xEnd, gy);
          const relativeCenter = (ent.x - xStart) / (xEnd - xStart);
          const gradWidth = (ent.radius * verticalIntensity) / (xEnd - xStart);

          grad.addColorStop(Math.max(0, relativeCenter - gradWidth), 'transparent');
          grad.addColorStop(Math.max(0, Math.min(1, relativeCenter)), ent.color);
          grad.addColorStop(Math.min(1, relativeCenter + gradWidth), 'transparent');

          drawConduit(ctx, xStart, gy, xEnd, gy, grad, globalOpacity * verticalIntensity);
        }
      }

      if (Math.random() < 0.015) {
        spawnEntity(Math.random() * canvas.width, Math.random() * canvas.height);
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    const drawConduit = (
      ctx: CanvasRenderingContext2D, 
      x1: number, y1: number, 
      x2: number, y2: number, 
      gradient: CanvasGradient, 
      alpha: number
    ) => {
      if (alpha < 0.01) return;

      const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();

      // 1. THE BLEED (Wide and soft)
      ctx.beginPath();
      ctx.lineWidth = 20;
      ctx.strokeStyle = gradient;
      ctx.globalAlpha = alpha * 0.12;
      ctx.lineCap = 'butt';
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // 2. THE CORE (Sharp and precise)
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.globalAlpha = alpha * 0.85;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      
      // 3. THE GLOW (Tight bloom)
      ctx.shadowBlur = 4;
      ctx.shadowColor = `hsl(${primaryColor})`;
      ctx.globalAlpha = alpha * 0.4;
      ctx.stroke();
      ctx.shadowBlur = 0;
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
