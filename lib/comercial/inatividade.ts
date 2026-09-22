/**
 * A INATIVIDADE — quem esfriou e vale reativar (ATT.txt Fase 4).
 *
 * Funções puras: recebem dias/total/qtd e devolvem faixa + score. O score é
 * HEURÍSTICA DOCUMENTADA, não ML — "probabilidade de recompra" sem modelo
 * seria número inventado com cara de ciência. O que ele diz de verdade:
 * "cliente que comprava muito e parou há pouco vale mais esforço que cliente
 * que comprava pouco e parou há muito". A fórmula está aberta abaixo para a
 * equipe ajustar com o que aprender na prática.
 *
 * Só quem JÁ comprou entra: quem nunca comprou é prospecção, não recuperação.
 */

export type FaixaDeInatividade = "atencao" | "morno" | "frio";

export const ROTULO_DA_FAIXA: Record<FaixaDeInatividade, string> = {
  atencao: "Atenção",
  morno: "Morno",
  frio: "Frio",
};

export function faixaDeInatividade(diasSemCompra: number): FaixaDeInatividade {
  if (diasSemCompra >= 90) return "frio";
  if (diasSemCompra >= 60) return "morno";
  return "atencao";
}

/**
 * Score 0–100 de prioridade de recuperação.
 * - Recência (60%): parou há pouco = mais recuperável. Zera em 365 dias.
 * - Valor histórico (25%): teto em R$ 5.000 de total acumulado.
 * - Frequência (15%): teto em 10 pedidos.
 */
export function scoreDeRecuperacao(
  diasSemCompra: number,
  totalHistoricoCents: number,
  qtdPedidos: number,
): number {
  const recencia = Math.max(0, 1 - diasSemCompra / 365) * 60;
  const valor = Math.min(1, totalHistoricoCents / 500000) * 25;
  const frequencia = Math.min(1, qtdPedidos / 10) * 15;
  return Math.round(recencia + valor + frequencia);
}

export interface ClienteInativo {
  contact_id: string;
  nome: string;
  telefone: string | null;
  dias_sem_compra: number;
  total_historico_cents: number;
  qtd_pedidos: number;
  faixa: FaixaDeInatividade;
  score: number;
}

export function classificarInativo(
  contato: { contact_id: string; nome: string; telefone: string | null },
  diasSemCompra: number,
  totalHistoricoCents: number,
  qtdPedidos: number,
): ClienteInativo {
  return {
    ...contato,
    dias_sem_compra: diasSemCompra,
    total_historico_cents: totalHistoricoCents,
    qtd_pedidos: qtdPedidos,
    faixa: faixaDeInatividade(diasSemCompra),
    score: scoreDeRecuperacao(diasSemCompra, totalHistoricoCents, qtdPedidos),
  };
}

/**
 * Link wa.me com mensagem pronta — a ação de reativação mais rápida.
 * Telefone em dígitos (E.164 sem "+"); mensagem encodada. Sem telefone,
 * null: sem destino não há link.
 */
export function linkWhatsAppRecuperacao(
  telefone: string | null,
  nome: string,
  diasSemCompra: number,
): string | null {
  if (!telefone) return null;
  const digitos = telefone.replace(/\D/g, "");
  if (digitos.length < 10) return null;
  const msg =
    `Olá ${nome}! Sentimos sua falta — já faz ${diasSemCompra} dias desde seu último pedido. ` +
    `Temos novidades e uma condição especial para você voltar. Posso mandar?`;
  return `https://wa.me/${digitos}?text=${encodeURIComponent(msg)}`;
}
