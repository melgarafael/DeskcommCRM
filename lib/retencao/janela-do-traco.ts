/** Datas de consulta são dias civis UTC; a retenção começa no instante do corte. */
export const JANELA_PADRAO_DIAS = 7;
const DIA = 86_400_000;

export interface JanelaDaLeitura {
  de: Date;
  ate: Date;
  fimExclusivo: Date;
  corte: Date;
  dias: number;
  truncada: boolean;
  foraDaRetencao: boolean;
}

function inicioDoDiaUtc(data: Date): Date {
  return new Date(`${diaIso(data)}T00:00:00.000Z`);
}

export function diaIso(data: Date): string {
  return data.toISOString().slice(0, 10);
}

/** Recebe datas já validadas e ordenadas; não depende de relógio implícito. */
export function janelaDaLeitura(
  query: { desde?: string; ate?: string },
  retencaoDias: number,
  agora: Date,
): JanelaDaLeitura {
  const ate = inicioDoDiaUtc(query.ate ? new Date(`${query.ate}T00:00:00.000Z`) : agora);
  const pedido = query.desde
    ? new Date(`${query.desde}T00:00:00.000Z`)
    : new Date(ate.getTime() - (JANELA_PADRAO_DIAS - 1) * DIA);
  // O SQL apaga created_at < now() - make_interval(days => dias), não a
  // meia-noite desse dia. Em UTC, um dia tem os mesmos 86.400 segundos.
  const corte = new Date(agora.getTime() - retencaoDias * DIA);
  const de = new Date(Math.max(pedido.getTime(), corte.getTime()));
  const fimPedido = new Date(ate.getTime() + DIA);
  const foraDaRetencao = fimPedido.getTime() <= corte.getTime();
  return {
    de,
    ate,
    fimExclusivo: foraDaRetencao ? de : fimPedido,
    corte,
    dias: foraDaRetencao
      ? 0
      : Math.round((fimPedido.getTime() - inicioDoDiaUtc(de).getTime()) / DIA),
    truncada: pedido.getTime() < corte.getTime(),
    foraDaRetencao,
  };
}
