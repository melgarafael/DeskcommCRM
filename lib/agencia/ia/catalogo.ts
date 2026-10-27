/**
 * O catálogo do executor IA da agência (docs/agencia/SPEC-ia-da-agencia.md, I4).
 * Puro: a tela, as ações e o banco (CHECK da migration 9012) usam a mesma lista.
 */
export const ACOES_DA_IA = ["roteiro", "legenda", "ideias", "plano_de_campanha", "publicacao"] as const;
export type AcaoDaIa = (typeof ACOES_DA_IA)[number];

export const ROTULO_DA_ACAO_DA_IA: Record<AcaoDaIa, string> = {
  roteiro: "Escrever roteiro de vídeo",
  legenda: "Escrever legenda",
  ideias: "Listar pautas do mês",
  plano_de_campanha: "Rascunhar campanha de anúncio (só texto)",
  publicacao: "Criar publicação em rascunho no calendário",
};

/** O pedido de cada ação, sem dados do cliente (estes entram no contexto, I7). */
export const INSTRUCAO_DA_ACAO: Record<AcaoDaIa, string> = {
  roteiro:
    "Escreva o roteiro de um vídeo curto (Reels/TikTok, até 60 s) para a tarefa abaixo: gancho nos primeiros 3 segundos, desenvolvimento em cenas numeradas com fala e o que aparece na tela, e chamada para ação no fim.",
  legenda:
    "Escreva a legenda de uma publicação para a tarefa abaixo: primeira linha que prende, corpo curto, chamada para ação clara e até 5 hashtags relevantes.",
  ideias: "Liste 10 pautas de conteúdo para o mês, cada uma com título, formato sugerido (Reels, carrossel, story) e o porquê em uma frase.",
  plano_de_campanha:
    "Rascunhe uma campanha de anúncio na Meta para a tarefa abaixo: objetivo, público (idade, local, interesses), orçamento diário sugerido em reais, duração, e dois textos de anúncio com título. É um RASCUNHO para uma pessoa conferir; não invente números do cliente.",
  publicacao:
    "Escreva a legenda da publicação descrita na tarefa abaixo, pronta para ir ao calendário: primeira linha que prende, corpo curto e chamada para ação.",
};

export function ehAcaoDaIa(v: unknown): v is AcaoDaIa {
  return typeof v === "string" && (ACOES_DA_IA as readonly string[]).includes(v);
}

/** I8: execuções por pessoa por hora. */
export const LIMITE_POR_HORA = 30;

/** Quanto falta para a pessoa poder executar de novo, em minutos (null = pode já). */
export function minutosParaLiberar(execucoesNaUltimaHora: readonly string[], agora: Date, limite = LIMITE_POR_HORA): number | null {
  if (execucoesNaUltimaHora.length < limite) return null;
  const ordenadas = [...execucoesNaUltimaHora].sort();
  const libera = new Date(ordenadas[ordenadas.length - limite]!).getTime() + 60 * 60_000;
  return Math.max(1, Math.ceil((libera - agora.getTime()) / 60_000));
}
