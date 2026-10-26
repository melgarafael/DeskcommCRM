/**
 * As regras do mapa mental, puras e testáveis sem banco (docs/agencia/SPEC-mapa-mental.md).
 */
import { passosQueLiberam } from "../trilhas/regras";

export interface LigacaoDoMapa {
  de_id: string;
  para_id: string;
}

/** O que impede publicar, em português; `null` quando pode (M3). */
export function problemaNoMapa(blocos: ReadonlyArray<{ id: string; titulo: string }>, ligacoes: readonly LigacaoDoMapa[]): string | null {
  if (blocos.length === 0) return "O mapa não tem nenhum bloco.";
  if (blocos.some((b) => b.titulo.trim().length < 2)) return "Todo bloco precisa de um título.";
  const simulados = blocos.map((b) => ({
    chave: b.id,
    situacao: "bloqueado" as "bloqueado" | "concluido",
    dependeDe: ligacoes.filter((l) => l.para_id === b.id).map((l) => l.de_id),
  }));
  for (;;) {
    const liberam = passosQueLiberam(simulados);
    if (liberam.length === 0) break;
    for (const s of simulados) if (liberam.includes(s.chave)) s.situacao = "concluido";
  }
  const presos = simulados.filter((s) => s.situacao === "bloqueado").map((s) => blocos.find((b) => b.id === s.chave)?.titulo);
  return presos.length ? `Há setas em círculo: ${presos.join(", ")} nunca seriam liberados.` : null;
}


/** Cores que a tela oferece para os blocos. */
export const CORES_DO_BLOCO = ["#2563eb", "#16a34a", "#ea580c", "#7c3aed", "#dc2626", "#0d9488", "#ca8a04", "#64748b"] as const;
