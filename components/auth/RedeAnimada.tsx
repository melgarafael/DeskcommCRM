"use client";

import { useEffect, useRef } from "react";

/**
 * A malha de pontos ligados que anima o painel da esquerda do `/login`.
 *
 * ── Por que canvas, e não SVG animado ou CSS ──────────────────────────────────
 *
 * São ~46 nós que se ligam DOIS A DOIS quando ficam perto: o número de linhas
 * varia a cada quadro, e cada linha tem opacidade própria (some conforme a
 * distância). Em SVG isso seria criar e destruir centenas de nós de DOM por
 * segundo na única tela que precisa abrir rápido — a primeira que qualquer
 * pessoa vê no produto.
 *
 * ── `prefers-reduced-motion` desenha UM quadro, não zero ──────────────────────
 *
 * Quem pediu menos movimento não pediu um retângulo vazio: o painel perderia a
 * textura que sustenta o texto por cima. Então o mesmo desenho acontece uma vez
 * e para ali — sem `requestAnimationFrame`, sem custo contínuo de bateria.
 *
 * `aria-hidden` porque não há nada a narrar: é textura, e um leitor de tela
 * anunciando "canvas" no meio do formulário de entrar só atrapalha.
 */
export function RedeAnimada({ densidade = 46 }: { densidade?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let nos: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
    let raf = 0;

    const montar = () => {
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      if (w === 0 || h === 0) return;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.max(18, Math.round((densidade * (w * h)) / 700_000));
      nos = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: Math.random() * 1.4 + 0.7,
      }));
    };

    const desenhar = () => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < nos.length; i++) {
        for (let j = i + 1; j < nos.length; j++) {
          const a = nos[i]!;
          const b = nos[j]!;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 150) {
            ctx.strokeStyle = `rgba(59,111,212,${(1 - d / 150) * 0.28})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      for (const p of nos) {
        ctx.fillStyle = "rgba(155,184,238,0.55)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const passo = () => {
      for (const p of nos) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }
      desenhar();
      raf = requestAnimationFrame(passo);
    };

    montar();
    const ro = new ResizeObserver(() => {
      montar();
      if (semMovimento) desenhar();
    });
    ro.observe(cv);

    if (semMovimento) desenhar();
    else passo();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [densidade]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 block h-full w-full"
    />
  );
}
