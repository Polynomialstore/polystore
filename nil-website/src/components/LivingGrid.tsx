import React, { useEffect, useRef } from 'react';

interface SmoothEntity {
  id: number;
  x: number;
  y: number;
  theta: number;
  thetaDrift: number;
  speed: number;
  life: number;
  color: string;
  radius: number;
  wavePhase: number;
}

const INACTIVITY_TIMEOUT_MS = 15000;

export const LivingGrid: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<SmoothEntity[]>([]);
  const mouseRef = useRef({ x: 0, y: 0, v: 0, accumulator: 0 });
  const lastTimeRef = useRef(0);
  const idCounterRef = useRef(0);
  const lastMouseSpawnAtRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let animationFrameId = 0;
    let inactivityTimeoutId = 0;
    let isAnimating = false;
    const gridSize = 30;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const spawnEntity = (x: number, y: number) => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      const hslColor = `hsl(${color})`;

      entitiesRef.current.push({
        id: idCounterRef.current++,
        x,
        y,
        theta: Math.random() * Math.PI * 2,
        thetaDrift: (Math.random() - 0.5) * 0.02,
        speed: 1.2 + Math.random() * 1.8,
        life: 1,
        color: hslColor,
        radius: 100 + Math.random() * 80,
        wavePhase: Math.random() * Math.PI * 2
      });
    };

    const drawConduit = (
      ctx: CanvasRenderingContext2D,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      gradient: CanvasGradient,
      alpha: number
    ) => {
      if (alpha < 0.01) return;

      const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();

      ctx.beginPath();
      ctx.lineWidth = 20;
      ctx.strokeStyle = gradient;
      ctx.globalAlpha = alpha * 0.12;
      ctx.lineCap = 'butt';
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.globalAlpha = alpha * 0.85;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      ctx.shadowBlur = 4;
      ctx.shadowColor = `hsl(${primaryColor})`;
      ctx.globalAlpha = alpha * 0.4;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    };

    const updateMouse = (event: MouseEvent) => {
      const dx = event.clientX - mouseRef.current.x;
      const dy = event.clientY - mouseRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      mouseRef.current.x = event.clientX;
      mouseRef.current.y = event.clientY;
      const velocity = parseFloat(document.documentElement.style.getPropertyValue('--mouse-v') || '0');
      mouseRef.current.v = velocity;
      mouseRef.current.accumulator += distance;

      if (mouseRef.current.accumulator > 120) {
        const now = performance.now();
        if (now - lastMouseSpawnAtRef.current >= 300) {
          spawnEntity(event.clientX, event.clientY);
          lastMouseSpawnAtRef.current = now;
          mouseRef.current.accumulator = 0;
        }
      }
    };

    const stopAnimation = () => {
      if (!isAnimating) return;
      isAnimating = false;
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = 0;
      }
      lastTimeRef.current = 0;
    };

    const animate = (time: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = time;
      const dt = (time - lastTimeRef.current) / 16.66;
      lastTimeRef.current = time;

      context.clearRect(0, 0, canvas.width, canvas.height);
      const entities = entitiesRef.current;

      for (let index = entities.length - 1; index >= 0; index -= 1) {
        const entity = entities[index];
        entity.theta += entity.thetaDrift * dt;
        entity.x += Math.cos(entity.theta) * entity.speed * dt;
        entity.y += Math.sin(entity.theta) * entity.speed * dt;
        entity.life -= 0.003 * dt;
        entity.wavePhase += 0.06 * dt;

        if (
          entity.life <= 0 ||
          entity.x < -300 ||
          entity.x > canvas.width + 300 ||
          entity.y < -300 ||
          entity.y > canvas.height + 300
        ) {
          entities.splice(index, 1);
          continue;
        }

        const minX = Math.floor((entity.x - entity.radius) / gridSize) * gridSize;
        const maxX = Math.ceil((entity.x + entity.radius) / gridSize) * gridSize;
        const minY = Math.floor((entity.y - entity.radius) / gridSize) * gridSize;
        const maxY = Math.ceil((entity.y + entity.radius) / gridSize) * gridSize;
        const pulse = (Math.sin(entity.wavePhase) + 1) / 2;
        const globalOpacity = entity.life * (0.4 + pulse * 0.6);

        for (let gx = minX; gx <= maxX; gx += gridSize) {
          const dx = Math.abs(gx - entity.x);
          if (dx > entity.radius) continue;

          const horizontalIntensity = Math.pow(1 - dx / entity.radius, 4);
          const yStart = minY;
          const yEnd = maxY;
          const gradient = context.createLinearGradient(gx, yStart, gx, yEnd);
          const relativeCenter = (entity.y - yStart) / Math.max(1, yEnd - yStart);
          const gradientWidth = (entity.radius * horizontalIntensity) / Math.max(1, yEnd - yStart);

          gradient.addColorStop(Math.max(0, relativeCenter - gradientWidth), 'transparent');
          gradient.addColorStop(Math.max(0, Math.min(1, relativeCenter)), entity.color);
          gradient.addColorStop(Math.min(1, relativeCenter + gradientWidth), 'transparent');

          drawConduit(context, gx, yStart, gx, yEnd, gradient, globalOpacity * horizontalIntensity);
        }

        for (let gy = minY; gy <= maxY; gy += gridSize) {
          const dy = Math.abs(gy - entity.y);
          if (dy > entity.radius) continue;

          const verticalIntensity = Math.pow(1 - dy / entity.radius, 4);
          const xStart = minX;
          const xEnd = maxX;
          const gradient = context.createLinearGradient(xStart, gy, xEnd, gy);
          const relativeCenter = (entity.x - xStart) / Math.max(1, xEnd - xStart);
          const gradientWidth = (entity.radius * verticalIntensity) / Math.max(1, xEnd - xStart);

          gradient.addColorStop(Math.max(0, relativeCenter - gradientWidth), 'transparent');
          gradient.addColorStop(Math.max(0, Math.min(1, relativeCenter)), entity.color);
          gradient.addColorStop(Math.min(1, relativeCenter + gradientWidth), 'transparent');

          drawConduit(context, xStart, gy, xEnd, gy, gradient, globalOpacity * verticalIntensity);
        }
      }

      if (Math.random() < 0.015) {
        spawnEntity(Math.random() * canvas.width, Math.random() * canvas.height);
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    const startAnimation = () => {
      if (isAnimating) return;
      if (document.visibilityState !== 'visible') return;
      isAnimating = true;
      animationFrameId = requestAnimationFrame(animate);
    };

    const scheduleInactivityPause = () => {
      if (inactivityTimeoutId) window.clearTimeout(inactivityTimeoutId);
      inactivityTimeoutId = window.setTimeout(() => {
        stopAnimation();
      }, INACTIVITY_TIMEOUT_MS);
    };

    const registerActivity = () => {
      if (document.visibilityState !== 'visible') return;
      scheduleInactivityPause();
      startAnimation();
    };

    const handleMouseMove = (event: MouseEvent) => {
      updateMouse(event);
      registerActivity();
    };

    const handleGenericActivity = () => {
      registerActivity();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        registerActivity();
        return;
      }
      stopAnimation();
    };

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mousedown', handleGenericActivity);
    window.addEventListener('wheel', handleGenericActivity, { passive: true });
    window.addEventListener('touchstart', handleGenericActivity, { passive: true });
    window.addEventListener('keydown', handleGenericActivity);
    window.addEventListener('focus', handleGenericActivity);
    window.addEventListener('blur', stopAnimation);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resize();
    registerActivity();

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleGenericActivity);
      window.removeEventListener('wheel', handleGenericActivity);
      window.removeEventListener('touchstart', handleGenericActivity);
      window.removeEventListener('keydown', handleGenericActivity);
      window.removeEventListener('focus', handleGenericActivity);
      window.removeEventListener('blur', stopAnimation);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (inactivityTimeoutId) window.clearTimeout(inactivityTimeoutId);
      stopAnimation();
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[1] opacity-70 dark:opacity-90" />;
};
