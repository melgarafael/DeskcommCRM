"use client";
import * as React from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { RadarDashboard } from "./_components/RadarDashboard";

/**
 * Navegação por seções do Radar — página única, todo o conteúdo renderizado.
 *
 * Por que botões que rolam em vez de abas que trocam: os e2e `recompra-radar`,
 * `risk-radar` e `retorno-anti-morte` leem a lista clássica, os testids do
 * risco e o cabeçalho "Radar de risco" SEM clique intermediário. Esconder uma
 * seção atrás de aba quebraria os três; rolar até ela, não.
 */
const SECOES = [
  { id: "radar-visao", rotulo: "Visão geral" },
  { id: "radar-oportunidades", rotulo: "Recompra" },
  { id: "radar-demandas", rotulo: "Risco de demandas" },
] as const;

export function RadarTabs() {
  const t = useT();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" role="navigation" aria-label={t("Seções do radar")}>
        {SECOES.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant="outline"
            onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            {t(s.rotulo)}
          </Button>
        ))}
      </div>
      <div id="radar-visao" className="scroll-mt-20">
        <RadarDashboard />
      </div>
    </div>
  );
}
