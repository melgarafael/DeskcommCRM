"use client";
import { Brain, Lightbulb, PuzzlePiece } from "@/lib/ui/icons";
import type { TimelineItem } from "@/lib/ai/evolution/aggregate";

/**
 * A linha do tempo do aprendizado. Cada linha responde "o que entrou na cabeça do
 * agente, e quando" — por isso o rótulo do TIPO vem antes do título: sem ele, uma
 * lista de frases soltas não diz se aquilo foi uma regra que o dono escreveu, uma
 * melhoria que ele aprovou ou uma habilidade que instalou. Três origens diferentes,
 * três coisas diferentes a fazer se ele quiser mais.
 */
const TIPOS: Record<TimelineItem["kind"], { rotulo: string; Icone: typeof Brain; cor: string }> = {
  memory: { rotulo: "Regra que você ensinou", Icone: Brain, cor: "text-accent" },
  proposal: { rotulo: "Melhoria que você aprovou", Icone: Lightbulb, cor: "text-warning-fg" },
  skill: { rotulo: "Habilidade instalada", Icone: PuzzlePiece, cor: "text-info-fg" },
};

/**
 * O agregador corta o texto da proposta em 120 caracteres (`content.slice(0, 120)`),
 * e sem reticências a frase termina no meio de uma palavra — o dono do negócio lê
 * isso como texto corrompido, não como resumo. O acoplamento ao número 120 é
 * deliberado e está declarado aqui: é o único lugar onde dá para saber que houve
 * corte, porque o payload não carrega o comprimento original.
 */
const CORTE_DO_AGREGADOR = 120;

function titulo(t: string): string {
  return t.length >= CORTE_DO_AGREGADOR ? `${t.trimEnd()}…` : t;
}

function dia(s: string): string {
  // `s` já vem truncado em YYYY-MM-DD pelo agregador; o `T00:00:00Z` evita que o
  // browser leia a data como local e mostre o dia anterior a oeste de Greenwich.
  return new Date(`${s}T00:00:00Z`).toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
}

export function EvolutionTimeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="max-h-80 divide-y divide-border overflow-y-auto">
      {items.map((it, i) => {
        const t = TIPOS[it.kind];
        return (
          <li key={`${it.day}-${it.kind}-${i}`} className="flex items-start gap-3 py-3">
            <t.Icone size={18} className={`mt-0.5 shrink-0 ${t.cor}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-text-muted">
                {dia(it.day)} · {t.rotulo}
              </p>
              <p className="mt-0.5 break-words text-sm">{titulo(it.title)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
