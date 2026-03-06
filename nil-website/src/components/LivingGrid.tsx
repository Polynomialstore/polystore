import React, { useEffect, useRef } from 'react';

interface WaveEntity {
  id: number;
  x: number; // Smooth sub-pixel X
  y: number; // Smooth sub-pixel Y
  theta: number;
  speed: number;
  life: number;
  color: string;
  size: number; // Radius of activation
  pulsePhase: number;
}

export const LivingGrid: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<WaveEntity[]>([]);
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

    const spawnEntity = (x: number, y: number, isStochastic = false) => {
      if (entitiesRef.current.length > 15) return;

      const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      const hslColor = `hsl(${color})`;
      
      entitiesRef.current.push({
        id: idCounter.current++,
        x,
        y,
        theta: Math.random() * Math.PI * 2,
        speed: 1.2 + Math.random() * 1.8,
        life: 1.0,
        color: hslColor,
        size: 60 + Math.random() * 60, // Sharper, smaller activation radius
        pulsePhase: Math.random() * Math.PI * 2
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
        
        ent.x += Math.cos(ent.theta) * ent.speed * dt;
        ent.y += Math.sin(ent.theta) * ent.speed * dt;
        ent.life -= 0.004 * dt;
        ent.pulsePhase += 0.08 * dt;

        if (ent.life <= 0 || ent.x < -200 || ent.x > canvas.width + 200 || ent.y < -200 || ent.y > canvas.height + 200) {
          entities.splice(i, 1);
          continue;
        }

        const startX = Math.floor((ent.x - ent.size) / gridSize) * gridSize;
        const endX = Math.ceil((ent.x + ent.size) / gridSize) * gridSize;
        const startY = Math.floor((ent.y - ent.size) / gridSize) * gridSize;
        const endY = Math.ceil((ent.y + ent.size) / gridSize) * gridSize;

        // Draw the core bright seed
        ctx.beginPath();
        ctx.fillStyle = ent.color;
        ctx.globalAlpha = ent.life * 0.9;
        ctx.arc(ent.x, ent.y, 2, 0, Math.PI * 2);
        ctx.fill();

        // Draw Vertical Active Lines
        for (let gx = startX; gx <= endX; gx += gridSize) {
          const dx = Math.abs(gx - ent.x);
          if (dx > ent.size) continue;

          // Aggressive falloff for tighter packets
          const falloff = Math.pow(1 - dx / ent.size, 4);
          const phase = ent.pulsePhase + (gx / 100);
          const pulse = (Math.sin(phase) + 1) / 2;
          
          ctx.beginPath();
          ctx.lineWidth = 2; // Thicker lines
          const grad = ctx.createLinearGradient(gx, ent.y - ent.size, gx, ent.y + ent.size);
          grad.addColorStop(0, 'transparent');
          grad.addColorStop(0.5, ent.color);
          grad.addColorStop(1, 'transparent');

          ctx.strokeStyle = grad;
          // Much higher intensity near center
          ctx.globalAlpha = ent.life * falloff * (0.4 + pulse * 0.6);
          ctx.moveTo(gx, ent.y - ent.size);
          ctx.lineTo(gx, ent.y + ent.size);
          ctx.stroke();
          
          // Core "Fiber" glow
          ctx.lineWidth = 4;
          ctx.globalAlpha = ent.life * falloff * 0.2;
          ctx.stroke();
        }

        // Draw Horizontal Active Lines
        for (let gy = startY; gy <= endY; gy += gridSize) {
          const dy = Math.abs(gy - ent.y);
          if (dy > ent.size) continue;

          const falloff = Math.pow(1 - dy / ent.size, 4);
          const phase = ent.pulsePhase + (gy / 100);
          const pulse = (Math.sin(phase) + 1) / 2;

          ctx.beginPath();
          ctx.lineWidth = 2;
          const grad = ctx.createLinearGradient(ent.x - ent.size, gy, ent.x + ent.size, gy);
          grad.addColorStop(0, 'transparent');
          grad.addColorStop(0.5, ent.color);
          grad.addColorStop(1, 'transparent');

          ctx.strokeStyle = grad;
          ctx.globalAlpha = ent.life * falloff * (0.4 + pulse * 0.6);
          ctx.moveTo(ent.x - ent.size, gy);
          ctx.lineTo(ent.x + ent.size, gy);
          ctx.stroke();

          // Core "Fiber" glow
          ctx.lineWidth = 4;
          ctx.globalAlpha = ent.life * falloff * 0.2;
          ctx.stroke();
        }
      }

      if (Math.random() < 0.02) {
        spawnEntity(Math.random() * canvas.width, Math.random() * canvas.height, true);
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
      className="fixed inset-0 pointer-events-none z-[1] opacity-70 dark:opacity-100"
    />
  );
};
