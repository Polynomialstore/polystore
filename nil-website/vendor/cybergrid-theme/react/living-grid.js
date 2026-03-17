import React, { useEffect, useRef } from "react";

const INACTIVITY_TIMEOUT_MS = 15000;
const TARGET_FRAME_INTERVAL_MS = 1000 / 24;

export function LivingGrid() {
  const canvasRef = useRef(null);
  const entitiesRef = useRef([]);
  const mouseRef = useRef({ x: 0, y: 0, v: 0, accumulator: 0 });
  const lastTimeRef = useRef(0);
  const idCounterRef = useRef(0);
  const lastMouseSpawnAtRef = useRef(0);
  const primaryColorRef = useRef("hsl(190 100% 50%)");
  const primaryShadowColorRef = useRef("hsl(190 100% 50%)");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const context = canvas.getContext("2d", { desynchronized: true });
    if (!context) return undefined;

    let animationFrameId = 0;
    let inactivityTimeoutId = 0;
    let isAnimating = false;
    const gridSize = 30;
    const entityBoundsMargin = 300;

    const updateThemeCache = () => {
      const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
      const resolvedPrimary = primary ? `hsl(${primary})` : "hsl(190 100% 50%)";
      primaryColorRef.current = resolvedPrimary;
      primaryShadowColorRef.current = resolvedPrimary;
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const spawnEntity = (x, y) => {
      entitiesRef.current.push({
        id: idCounterRef.current++,
        x,
        y,
        theta: Math.random() * Math.PI * 2,
        thetaDrift: (Math.random() - 0.5) * 0.02,
        speed: 1.2 + Math.random() * 1.8,
        life: 1,
        color: primaryColorRef.current,
        radius: 100 + Math.random() * 80,
        wavePhase: Math.random() * Math.PI * 2
      });
    };

    const drawConduit = (ctx, path, gradient, alpha) => {
      if (alpha < 0.01) return;

      ctx.lineWidth = 20;
      ctx.strokeStyle = gradient;
      ctx.globalAlpha = alpha * 0.12;
      ctx.lineCap = "butt";
      ctx.stroke(path);

      ctx.lineWidth = 2;
      ctx.globalAlpha = alpha * 0.85;
      ctx.stroke(path);

      ctx.shadowBlur = 4;
      ctx.shadowColor = primaryShadowColorRef.current;
      ctx.globalAlpha = alpha * 0.4;
      ctx.stroke(path);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    };

    const updateMouse = (event) => {
      const dx = event.clientX - mouseRef.current.x;
      const dy = event.clientY - mouseRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      mouseRef.current.x = event.clientX;
      mouseRef.current.y = event.clientY;
      const velocity = parseFloat(document.documentElement.style.getPropertyValue("--mouse-v") || "0");
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

    const animate = (time) => {
      if (!lastTimeRef.current) lastTimeRef.current = time;
      const elapsed = time - lastTimeRef.current;
      if (elapsed < TARGET_FRAME_INTERVAL_MS) {
        animationFrameId = requestAnimationFrame(animate);
        return;
      }

      const dt = elapsed / 16.66;
      lastTimeRef.current = time;

      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);
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
          entity.x < -entityBoundsMargin ||
          entity.x > width + entityBoundsMargin ||
          entity.y < -entityBoundsMargin ||
          entity.y > height + entityBoundsMargin
        ) {
          const lastIndex = entities.length - 1;
          if (index !== lastIndex) {
            entities[index] = entities[lastIndex];
          }
          entities.pop();
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
          const conduitPath = new Path2D();
          conduitPath.moveTo(gx, yStart);
          conduitPath.lineTo(gx, yEnd);

          gradient.addColorStop(Math.max(0, relativeCenter - gradientWidth), "transparent");
          gradient.addColorStop(Math.max(0, Math.min(1, relativeCenter)), entity.color);
          gradient.addColorStop(Math.min(1, relativeCenter + gradientWidth), "transparent");

          drawConduit(context, conduitPath, gradient, globalOpacity * horizontalIntensity);
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
          const conduitPath = new Path2D();
          conduitPath.moveTo(xStart, gy);
          conduitPath.lineTo(xEnd, gy);

          gradient.addColorStop(Math.max(0, relativeCenter - gradientWidth), "transparent");
          gradient.addColorStop(Math.max(0, Math.min(1, relativeCenter)), entity.color);
          gradient.addColorStop(Math.min(1, relativeCenter + gradientWidth), "transparent");

          drawConduit(context, conduitPath, gradient, globalOpacity * verticalIntensity);
        }
      }

      if (Math.random() < 0.015) {
        spawnEntity(Math.random() * width, Math.random() * height);
      }

      animationFrameId = requestAnimationFrame(animate);
    };

    const startAnimation = () => {
      if (isAnimating) return;
      if (document.visibilityState !== "visible") return;
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
      if (document.visibilityState !== "visible") return;
      scheduleInactivityPause();
      startAnimation();
    };

    const handleMouseMove = (event) => {
      updateMouse(event);
      registerActivity();
    };

    const handleGenericActivity = () => {
      registerActivity();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        updateThemeCache();
        registerActivity();
        return;
      }
      stopAnimation();
    };

    const themeObserver = new MutationObserver(() => {
      updateThemeCache();
    });

    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mousedown", handleGenericActivity);
    window.addEventListener("wheel", handleGenericActivity, { passive: true });
    window.addEventListener("touchstart", handleGenericActivity, { passive: true });
    window.addEventListener("keydown", handleGenericActivity);
    window.addEventListener("focus", handleGenericActivity);
    window.addEventListener("blur", stopAnimation);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"]
    });
    updateThemeCache();
    resize();
    registerActivity();

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mousedown", handleGenericActivity);
      window.removeEventListener("wheel", handleGenericActivity);
      window.removeEventListener("touchstart", handleGenericActivity);
      window.removeEventListener("keydown", handleGenericActivity);
      window.removeEventListener("focus", handleGenericActivity);
      window.removeEventListener("blur", stopAnimation);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      themeObserver.disconnect();
      if (inactivityTimeoutId) window.clearTimeout(inactivityTimeoutId);
      stopAnimation();
    };
  }, []);

  return React.createElement("canvas", {
    ref: canvasRef,
    className: "fixed inset-0 pointer-events-none z-[1] opacity-70 dark:opacity-90"
  });
}
