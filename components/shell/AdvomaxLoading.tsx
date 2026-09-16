"use client";

import { SimboloAdvomax } from "@/components/branding/MarcaDoProduto";

export function AdvomaxLoading() {
  return (
    <div className="flex min-h-[calc(100dvh-64px)] flex-col items-center justify-center gap-4 bg-[#f7f9fc] text-[#526173]" role="status" aria-live="polite">
      <SimboloAdvomax className="advomax-loading-mark h-[72px] w-[72px]" />
      <span className="text-xs font-medium uppercase tracking-[0.12em]">Carregando...</span>
      <style jsx>{`@keyframes advomax-draw { 0% { stroke-dashoffset:620; opacity:.25; } 45%,70% { stroke-dashoffset:0; opacity:1; } 100% { stroke-dashoffset:-620; opacity:.25; } } .advomax-loading-mark :global(path) { stroke-dasharray:620; animation:advomax-draw 2.4s ease-in-out infinite; } .advomax-loading-mark :global(path:nth-child(2)) { animation-delay:.18s; } @media (prefers-reduced-motion: reduce) { .advomax-loading-mark :global(path) { animation:none; stroke-dashoffset:0; } }`}</style>
    </div>
  );
}
