/** O vocabulário das aprovações e dos envios (SPEC-aprovacoes, SPEC-envios). CHECK no banco (9009, 9013). */
export const TIPOS_DE_APROVACAO = ["video", "roteiro", "arte", "estrategia", "outro", "aviso"] as const;
export type TipoDeAprovacao = (typeof TIPOS_DE_APROVACAO)[number];

export const ROTULO_DO_TIPO_DE_APROVACAO: Record<TipoDeAprovacao, string> = {
  video: "Vídeo",
  roteiro: "Roteiro",
  arte: "Arte",
  estrategia: "Estratégia do mês",
  outro: "Outro",
  aviso: "Aviso",
};

export const SITUACOES_DA_APROVACAO = ["pendente", "aprovado", "ajustes", "cancelado", "ciente"] as const;
export type SituacaoDaAprovacao = (typeof SITUACOES_DA_APROVACAO)[number];

export const ROTULO_DA_SITUACAO_DA_APROVACAO: Record<SituacaoDaAprovacao, string> = {
  pendente: "Aguardando o cliente",
  aprovado: "Aprovado",
  ajustes: "Pediu ajustes",
  cancelado: "Cancelado",
  ciente: "Cliente ciente",
};

/** O aviso só pede ciência; o resto pede aprovação (SPEC-envios, E5). */
export function ehAviso(tipo: TipoDeAprovacao): boolean {
  return tipo === "aviso";
}

/** O texto do WhatsApp ao cliente (P7, E10): título e o caminho, nunca o conteúdo. */
export function textoDoPedidoDeAprovacao(p: { tipo: TipoDeAprovacao; titulo: string; url: string; agencia: string; versao: number }): string {
  if (ehAviso(p.tipo)) {
    return [`📣 Aviso da agência: ${p.titulo}.`, `Leia no seu CRM e marque que está ciente: ${p.url}`, p.agencia].join("\n\n");
  }
  const o = ROTULO_DO_TIPO_DE_APROVACAO[p.tipo].toLowerCase();
  return [
    `📌 ${p.versao > 1 ? `Nova versão para aprovar (v${p.versao})` : "Novo para aprovar"}: ${p.titulo} (${o}).`,
    `Veja e responda no seu CRM: ${p.url}`,
    p.agencia,
  ].join("\n\n");
}
