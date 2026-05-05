// In-house simplified take on reactbits's DotGrid. The upstream version
// pulls gsap + InertiaPlugin (the latter is a paid GSAP Club plugin)
// for cursor-driven inertia / click shocks. The Mesh Mono theme only
// needs static dots + an optional cursor-proximity highlight, which is
// ~80 lines of Canvas2D + RAF and ships with no new dependencies.
//
// Props mirror the upstream API for the subset of features we keep
// (dotSize, gap, baseColor, activeColor, proximity, className, style)
// so a future swap to the full reactbits component is straightforward.
import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface DotGridProps {
  dotSize?: number;
  gap?: number;
  baseColor?: string;
  activeColor?: string;
  /**
   * Cursor-proximity highlight radius in CSS pixels. Set to 0 to keep
   * the grid completely static (Mesh Mono uses this — paper aesthetic
   * doesn't benefit from cursor-following highlights).
   */
  proximity?: number;
  className?: string;
  style?: React.CSSProperties;
}

interface Dot {
  cx: number;
  cy: number;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

const DotGrid: React.FC<DotGridProps> = ({
  dotSize = 2,
  gap = 24,
  baseColor = '#9ca3af',
  activeColor,
  proximity = 0,
  className = '',
  style,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dotsRef = useRef<Dot[]>([]);
  const pointerRef = useRef({ x: -9999, y: -9999, active: false });

  const baseRgb = useMemo(() => hexToRgb(baseColor), [baseColor]);
  const activeRgb = useMemo(
    () => hexToRgb(activeColor ?? baseColor),
    [activeColor, baseColor],
  );

  const buildGrid = useCallback(() => {
    const wrap = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const { width, height } = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cell = dotSize + gap;
    const cols = Math.max(1, Math.floor((width + gap) / cell));
    const rows = Math.max(1, Math.floor((height + gap) / cell));
    const gridW = cell * cols - gap;
    const gridH = cell * rows - gap;
    const startX = (width - gridW) / 2 + dotSize / 2;
    const startY = (height - gridH) / 2 + dotSize / 2;

    const dots: Dot[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        dots.push({
          cx: startX + x * cell,
          cy: startY + y * cell,
        });
      }
    }
    dotsRef.current = dots;
  }, [dotSize, gap]);

  // Static draw — runs once after buildGrid (and on each RAF only when
  // proximity > 0). For Mesh Mono (proximity = 0) we never re-enter
  // the RAF loop after the initial paint, keeping CPU at ~0%.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, width, height);

    const radius = dotSize / 2;
    const proxSq = proximity * proximity;
    const { x: px, y: py, active } = pointerRef.current;

    for (const dot of dotsRef.current) {
      let style = `rgb(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b})`;
      if (active && proximity > 0) {
        const dx = dot.cx - px;
        const dy = dot.cy - py;
        const dsq = dx * dx + dy * dy;
        if (dsq <= proxSq) {
          const t = 1 - Math.sqrt(dsq) / proximity;
          const r = Math.round(baseRgb.r + (activeRgb.r - baseRgb.r) * t);
          const g = Math.round(baseRgb.g + (activeRgb.g - baseRgb.g) * t);
          const b = Math.round(baseRgb.b + (activeRgb.b - baseRgb.b) * t);
          style = `rgb(${r}, ${g}, ${b})`;
        }
      }
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.arc(dot.cx, dot.cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [dotSize, proximity, baseRgb, activeRgb]);

  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    buildGrid();
    draw();
    const ro = new ResizeObserver(() => {
      buildGrid();
      draw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [buildGrid, draw]);

  useEffect(() => {
    if (proximity <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current.x = e.clientX - rect.left;
      pointerRef.current.y = e.clientY - rect.top;
      pointerRef.current.active = true;
    };
    const onLeave = () => {
      pointerRef.current.active = false;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, [proximity, draw]);

  return (
    <div
      ref={wrapperRef}
      className={`relative w-full h-full ${className}`}
      style={style}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
    </div>
  );
};

export default DotGrid;
