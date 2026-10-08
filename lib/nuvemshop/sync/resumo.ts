import type { EstadoDoSync } from "./estado";
import { mesDoBackfill } from "./janelas";

export type ResumoDoSync = {
  situacao: "nunca" | "importando" | "sincronizando" | "em_dia" | "erro";
  totalPedidos: number;
  mes?: number;
  ultimaSync: string | null;
  erro?: string;
  pedidosComErro: number;
};

export const FRASE_DO_ERRO: Record<string, string> = {
  auth: "A loja revogou o acesso. Desconecte e conecte de novo.",
};
const FRASE_PADRAO = "A sincronização falhou. Tente sincronizar de novo.";

export function resumirSync(estado: EstadoDoSync | null, totalPedidos: number): ResumoDoSync {
  const base = { totalPedidos, ultimaSync: estado?.ultimo_run_fim ?? null, pedidosComErro: estado?.pedidos_com_erro ?? 0 };
  if (!estado) return { ...base, situacao: "nunca" };
  if (estado.status === "error") {
    return { ...base, situacao: "erro", erro: FRASE_DO_ERRO[estado.ultimo_erro ?? ""] ?? FRASE_PADRAO };
  }
  if (estado.status === "running") {
    if (!estado.cursor_updated_at && estado.janela_atual_ini && estado.alvo_fim) {
      return { ...base, situacao: "importando", mes: mesDoBackfill(estado.janela_atual_ini, estado.alvo_fim) };
    }
    return { ...base, situacao: "sincronizando" };
  }
  return { ...base, situacao: estado.cursor_updated_at ? "em_dia" : "nunca" };
}
