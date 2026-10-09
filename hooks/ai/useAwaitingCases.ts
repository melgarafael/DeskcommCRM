"use client";

import { useMemo } from "react";

import { useCases } from "@/hooks/ai/useCases";

/** Casos visíveis para a pessoa, com o mesmo recorte RLS da tela de Casos. */
export function useAwaitingCases() {
  const consulta = useCases("awaiting_human");
  const casosPendentes = useMemo(
    () =>
      (consulta.data?.cases ?? [])
        .filter((caso) => caso.status === "awaiting_human")
        .sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at)),
    [consulta.data],
  );

  return { ...consulta, casosPendentes };
}
