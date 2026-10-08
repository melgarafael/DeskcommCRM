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
