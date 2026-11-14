import type { CampaignConfig } from "./schema";

/**
 * ARQUIVAR UMA CAMPANHA (#4359) — o marcador e a régua da lista.
 *
 * O pedido da comunidade: campanha que falhou ou veio zerada fica para sempre em
 * "Suas campanhas". A saída é ARQUIVAR, e arquivar NÃO é excluir — os negócios, as
 * conversas, os candidatos e o custo daquela campanha continuam exatamente onde
 * estão. Por isso o gesto não é um `delete`: é uma chave no jsonb `config`, que a
 * lista lê para esconder o cartão e o filtro "Ver arquivadas" lê para mostrá-lo.
 *
 * Mora em módulo próprio (e não em `_client.tsx`) porque a régua da lista é
 * testável sem DOM, e porque o servidor também precisa dela: a rota ordena as não
 * arquivadas primeiro para as arquivadas não roubarem as 50 vagas da lista.
 */
export const CHAVE_ARQUIVADA = "arquivada_em";

/** Quando esta campanha foi arquivada, ou `null` se ela está na lista. */
export function arquivadaEm(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const valor = (config as Record<string, unknown>)[CHAVE_ARQUIVADA];
  return typeof valor === "string" && valor !== "" ? valor : null;
}

/** A campanha está arquivada? (config nula — busca que nunca iniciou — não está.) */
export function estaArquivada(campanha: { config: unknown }): boolean {
  return arquivadaEm(campanha.config) !== null;
}

/**
 * O que a lista mostra: as campanhas na lista principal, ou as arquivadas quando o
 * filtro está ligado. Uma campanha nunca aparece nos dois lugares — e nunca some
 * dos dois: é o que impede o arquivamento de virar perda de dado.
 */
export function campanhasVisiveis<T extends { config: unknown }>(
  campanhas: readonly T[],
  verArquivadas: boolean,
): T[] {
  return campanhas.filter((c) => estaArquivada(c) === verArquivadas);
}

/** A configuração sem o marcador, para comparar o que a pessoa escolheu. */
export function semMarcadorDeArquivamento(config: CampaignConfig): string {
  return JSON.stringify({ ...config, [CHAVE_ARQUIVADA]: undefined });
}
