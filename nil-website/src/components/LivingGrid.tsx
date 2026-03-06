import React, { useEffect, useRef } from 'react';

interface BoxPacket {
  id: number;
  x: number; // Grid X (multiples of 30)
  y: number; // Grid Y (multiples of 30)
  vx: number; // -1, 0, 1 (grid units per jump)
  vy: number; // -1, 0, 1 (grid units per jump)
  life: number;
  maxLife: number;
  color: string;
  trail: { x: number; y: number }[];
}

export const LivingGrid: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const packetsRef = useRef<BoxPacket[]>([]);
  const mouseRef = useRef({ x: 0, y: 0, v: 0, accumulator: 0 });
  const lastJumpTimeRef = useRef(0);
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

    const updateMouse = (e: MouseEvent) => {
      const dx = e.clientX - mouseRef.current.x;
      const dy = e.clientY - mouseRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      
      const v = parseFloat(document.documentElement.style.getPropertyValue('--mouse-v') || '0');
      mouseRef.current.v = v;

      mouseRef.current.accumulator += dist;
      
      const threshold = Math.max(20, 100 - v * 40);
      
      if (mouseRef.current.accumulator > threshold) {
        spawnPacket(e.clientX, e.clientY);
        mouseRef.current.accumulator = 0;
      }
    };

    const spawnPacket = (x: number, y: number) => {
      if (packetsRef.current.length > 40) return; // Fewer, higher impact clusters

      const gx = Math.floor(x / gridSize) * gridSize;
      const gy = Math.floor(y / gridSize) * gridSize;

      const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      const hslColor = `hsl(${color})`;

      const dir = Math.floor(Math.random() * 4);
      let vx = 0, vy = 0;
      if (dir === 0) vx = 1;
      else if (dir === 1) vx = -1;
      else if (dir === 2) vy = 1;
      else vy = -1;

      packetsRef.current.push({
        id: idCounter.current++,
        x: gx,
        y: gy,
        vx,
        vy,
        life: 1.0,
        maxLife: 1.0,
        color: hslColor,
        trail: [],
      });
    };

    const stochasticSpawn = () => {
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      const dx = x - mouseRef.current.x;
      const dy = y - mouseRef.current.y;
      const r = Math.sqrt(dx * dx + dy * dy);
      const probability = 1 / (1 + (r / 300) ** 2);
      
      if (Math.random() < probability * 0.15) {
        spawnPacket(x, y);
      }
    };

    const animate = () => {
      const now = performance.now();
      // Discrete jump timing: packets jump every 80ms
      const isJumpFrame = now - lastJumpTimeRef.current > 80;

      if (isJumpFrame) {
        lastJumpTimeRef.current = now;
        if (Math.random() < 0.3) stochasticSpawn();
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const packets = packetsRef.current;

      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];

        if (isJumpFrame) {
          // Update trail
          p.trail.unshift({ x: p.x, y: p.y });
          if (p.trail.length > 4) p.trail.pop();

          // Move head
          p.x += p.vx * gridSize;
          p.y += p.vy * gridSize;
          
          // Life decay
          p.life -= 0.02;

          // Manhattan Stochastic Turn
          if (Math.random() < 0.15) {
            const turnRight = Math.random() < 0.5;
            const oldVx = p.vx;
            const oldVy = p.vy;
            if (oldVx !== 0) {
              p.vx = 0;
              p.vy = turnRight ? 1 : -1;
            } else {
              p.vy = 0;
              p.vx = turnRight ? 1 : -1;
            }
          }
        }

        if (p.life <= 0 || p.x < -gridSize || p.x > canvas.width || p.y < -gridSize || p.y > canvas.height) {
          packets.splice(i, 1);
          continue;
        }

        // Draw the Wave Packet Cluster
        // Head
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life * 0.8;
        ctx.fillRect(p.x + 1, p.y + 1, gridSize - 2, gridSize - 2);

        // Trail Boxes
        p.trail.forEach((pos, idx) => {
          const trailAlpha = p.life * (0.5 / (idx + 1));
          ctx.globalAlpha = trailAlpha;
          ctx.fillRect(pos.x + 1, pos.y + 1, gridSize - 2, gridSize - 2);
          
          // Subtle border for trail
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1;
          ctx.globalAlpha = trailAlpha * 0.5;
          ctx.strokeRect(pos.x + 0.5, pos.y + 0.5, gridSize - 1, gridSize - 1);
        });
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', updateMouse);
    resize();
    animate();

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', updateMouse);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[1] opacity-40 dark:opacity-60"
    />
  );
};
