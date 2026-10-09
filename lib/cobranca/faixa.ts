const DIA_MS = 86_400_000;
const DIAS_DA_FAIXA = 7;

/**
 * Quantos dias faltam para o teste grátis acabar, quando a faixa deve aparecer
 * (últimos 7 dias; spec da cobrança §9). `null` = sem faixa: sem assinatura
 * (isenta), fora do teste, sem data, mais de 7 dias, ou teste já acabado — quem
 * trata o vencido é a régua da PR 3a.
 */
export function diasDeTesteRestantes(
  assinatura: { estado: string; trial_ate: string | null } | null,
  agora: Date,
): number | null {
  if (!assinatura || assinatura.estado !== "trial" || !assinatura.trial_ate) return null;
  const restante = Date.parse(assinatura.trial_ate) - agora.getTime();
  if (restante <= 0) return null;
  const dias = Math.ceil(restante / DIA_MS);
  return dias <= DIAS_DA_FAIXA ? dias : null;
}

/**
 * A chave do dicionário da faixa (`{n}` = dias). Com 1, "amanhã" mentiria: o
 * `ceil` dá 1 também para quem tem 2 horas de teste.
 */
export function fraseDaFaixa(dias: number): string {
  return dias === 1 ? "Seu teste grátis termina nas próximas 24 horas." : "Seu teste grátis termina em {n} dias.";
}

export type FaixaDaCobranca =
  | { tipo: "teste"; dias: number }
  | { tipo: "teste_acabou"; desde: string | null }
  | { tipo: "atraso"; desde: string | null; link: string | null }
  | { tipo: "avise_o_admin" }
  | { tipo: "cancelamento"; ate: string }
  | { tipo: "cancelada" }
  | null;

/**
 * A faixa de `/app` (spec da cobrança §9): atraso (com o link que paga em um
 * clique), teste grátis que acabou sem assinatura (sem provedor: a empresa
 * nunca pagou, "não identificamos o pagamento" seria mentira), cancelamento
 * agendado, cancelada sem período pago, ou os últimos 7 dias do teste. Em dia,
 * isenta ou teste longe: nenhuma. Quem não administra vê só o atraso, sem link.
 */
export function faixaDaCobranca(
  a: {
    estado: string;
    trial_ate: string | null;
    vencida_desde: string | null;
    cancela_no_fim: boolean;
    proximo_vencimento: string | null;
    link_de_pagamento: string | null;
    provedor: string | null;
  } | null,
  agora: Date,
  administra = true,
): FaixaDaCobranca {
  if (!a) return null;
  if (!administra) return a.estado === "em_atraso" ? { tipo: "avise_o_admin" } : null;
  if (a.estado === "em_atraso") {
    return a.provedor === null
      ? { tipo: "teste_acabou", desde: a.vencida_desde }
      : { tipo: "atraso", desde: a.vencida_desde, link: a.link_de_pagamento };
  }
  const periodoEmCurso = a.proximo_vencimento !== null && Date.parse(a.proximo_vencimento) > agora.getTime();
  if (a.estado === "cancelada") return periodoEmCurso && a.proximo_vencimento ? { tipo: "cancelamento", ate: a.proximo_vencimento } : { tipo: "cancelada" };
  if (a.cancela_no_fim && periodoEmCurso && a.proximo_vencimento) return { tipo: "cancelamento", ate: a.proximo_vencimento };
  const dias = diasDeTesteRestantes(a, agora);
  return dias === null ? null : { tipo: "teste", dias };
}
