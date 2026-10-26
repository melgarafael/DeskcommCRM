/** O vocabulário das aprovações (docs/agencia/SPEC-aprovacoes.md). CHECK no banco (9009). */
export const TIPOS_DE_APROVACAO = ["video", "roteiro", "arte", "estrategia", "outro"] as const;
export type TipoDeAprovacao = (typeof TIPOS_DE_APROVACAO)[number];

export const ROTULO_DO_TIPO_DE_APROVACAO: Record<TipoDeAprovacao, string> = {
  video: "Vídeo",
  roteiro: "Roteiro",
  arte: "Arte",
  estrategia: "Estratégia do mês",
  outro: "Outro",
};

export const SITUACOES_DA_APROVACAO = ["pendente", "aprovado", "ajustes", "cancelado"] as const;
export type SituacaoDaAprovacao = (typeof SITUACOES_DA_APROVACAO)[number];

export const ROTULO_DA_SITUACAO_DA_APROVACAO: Record<SituacaoDaAprovacao, string> = {
  pendente: "Aguardando o cliente",
  aprovado: "Aprovado",
  ajustes: "Pediu ajustes",
  cancelado: "Cancelado",
};

/** O texto do WhatsApp ao cliente (P7): título e o caminho, nunca o conteúdo. */
export function textoDoPedidoDeAprovacao(p: { tipo: TipoDeAprovacao; titulo: string; url: string; agencia: string; versao: number }): string {
  const o = ROTULO_DO_TIPO_DE_APROVACAO[p.tipo].toLowerCase();
  return [
    `📌 ${p.versao > 1 ? `Nova versão para aprovar (v${p.versao})` : "Novo para aprovar"}: ${p.titulo} (${o}).`,
    `Veja e responda no seu CRM: ${p.url}`,
    p.agencia,
  ].join("\n\n");
}
