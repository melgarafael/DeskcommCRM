"use client";

import { useEffect, useState } from "react";

import { tempoQueFalta } from "@/lib/agencia/trilhas/tempo-que-falta";
import { Clock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Contagem regressiva ao vivo até o prazo de um passo (plano de 27/10, item 2).
 * Verde/cinza com folga, amarelo a menos de 24 h, vermelho depois do prazo.
 * Começa sem texto e preenche depois de montar: o relógio do servidor e o do
 * navegador nunca batem no segundo, e isso evitaria aviso de hidratação.
 */
export function Reloginho({ prazo }: { prazo: string }) {
  const [agora, setAgora] = useState<Date | null>(null);
  useEffect(() => {
    const marcar = () => setAgora(new Date());
    const primeiro = setTimeout(marcar, 0);
    const t = setInterval(marcar, 1000);
    return () => {
      clearTimeout(primeiro);
      clearInterval(t);
    };
  }, []);
  if (!agora) return <span className="inline-block h-6 w-28" aria-hidden />;
  const { texto, nivel } = tempoQueFalta(prazo, agora);
  return (
    <span
      data-testid="reloginho"
      data-nivel={nivel}
      title={`Prazo: ${new Date(prazo).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums",
        nivel === "folga" && "text-muted-foreground",
        nivel === "perto" && "border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
        nivel === "atrasado" && "border-destructive bg-destructive/10 font-medium text-destructive",
      )}
    >
      <Clock size={13} aria-hidden />
      {texto}
    </span>
  );
}
