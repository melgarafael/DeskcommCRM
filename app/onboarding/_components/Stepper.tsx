"use client";

import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface StepDef {
  /** Trecho da rota que identifica o passo (ver app/onboarding/<segmento>). */
  segment: string;
  label: string;
}

const STEPS: StepDef[] = [
  { segment: "welcome", label: "Boas-vindas" },
  { segment: "connect-whatsapp", label: "WhatsApp" },
  { segment: "connect-nuvemshop", label: "Loja" },
  { segment: "setup-ai", label: "IA" },
  { segment: "invite-team", label: "Time" },
  { segment: "done", label: "Concluído" },
];

/**
 * O passo atual sai da própria rota. Antes vinha por prop, alimentada de um
 * header `x-pathname` que NADA no projeto escrevia (não há middleware): o valor
 * chegava sempre vazio, caía no fallback e o indicador ficava travado em
 * "Boas-vindas" durante o onboarding inteiro. Ler a rota aqui dispensa o header,
 * o prop e o mapeamento no layout.
 */
export function Stepper() {
  const pathname = usePathname() ?? "";
  const idx = STEPS.findIndex((s) => pathname.includes(`/${s.segment}`));
  const current = idx >= 0 ? idx : 0;
  return (
    <>
      {/* Mobile: 6 rótulos + círculos numa fila `justify-between` não cabem
          em ~360px sem virar sopa de letrinhas — vira um resumo de texto,
          como o doc de responsividade pede ("Passo X de N"). */}
      <p aria-label="onboarding steps" className="px-2 py-3 text-sm text-muted-foreground md:hidden">
        Passo {current + 1} de {STEPS.length} — <span className="font-medium text-foreground">{STEPS[current]?.label}</span>
      </p>
      <ol
        aria-label="onboarding steps"
        className="hidden w-full items-center justify-between gap-2 px-2 py-3 md:flex"
      >
      {STEPS.map((s, i) => {
        const isActive = i === idx;
        const isDone = i < idx;
        return (
          <li
            key={s.segment}
            aria-current={isActive ? "step" : undefined}
            className="flex flex-1 flex-col items-center text-xs"
          >
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-medium",
                isActive && "border-primary bg-primary text-primary-foreground",
                isDone && "border-primary/40 bg-primary/10 text-primary",
                !isActive && !isDone && "border-muted-foreground/20 text-muted-foreground",
              )}
            >
              {i + 1}
            </div>
            <span
              className={cn(
                "mt-1 truncate",
                isActive ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
          </li>
        );
      })}
      </ol>
    </>
  );
}
