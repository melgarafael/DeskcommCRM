/**
 * OS ATALHOS DE PERÍODO — "Hoje", "7 dias", "30 dias", "Este mês", "Mês passado".
 *
 * Cada atalho devolve `{ de, ate }` em DATAS (AAAA-MM-DD) na parede da
 * organização, no formato que `/api/v1/reports/*` recebe. "Hoje" é o dia da
 * EMPRESA, não do navegador: duas pessoas da mesma empresa em fusos diferentes
 * veem o mesmo período. "7 dias" e "30 dias" incluem hoje (de hoje-6 a hoje).
 *
 * Função PURA: recebe o instante e o fuso, não lê relógio nem rede.
 */
import { dataNoFuso, fusoDoRelatorio } from "./janela";

export const ATALHOS_DE_PERIODO = ["hoje", "7d", "30d", "mes", "mes_passado"] as const;
export type AtalhoDePeriodo = (typeof ATALHOS_DE_PERIODO)[number];

export interface Periodo {
  de: string;
  ate: string;
}

/** Soma `dias` (pode ser negativo) a uma data de calendário. */
function somarDias(data: string, dias: number): string {
  const base = Date.parse(`${data}T00:00:00Z`);
  return new Date(base + dias * 86_400_000).toISOString().slice(0, 10);
}

export function periodoDoAtalho(atalho: AtalhoDePeriodo, agora: Date, tz: string): Periodo {
  const hoje = dataNoFuso(agora, fusoDoRelatorio(tz));
  switch (atalho) {
    case "hoje":
      return { de: hoje, ate: hoje };
    case "7d":
      return { de: somarDias(hoje, -6), ate: hoje };
    case "30d":
      return { de: somarDias(hoje, -29), ate: hoje };
    case "mes":
      return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
    case "mes_passado": {
      const primeiroDesteMes = `${hoje.slice(0, 7)}-01`;
      const ultimoDoPassado = somarDias(primeiroDesteMes, -1);
      return { de: `${ultimoDoPassado.slice(0, 7)}-01`, ate: ultimoDoPassado };
    }
  }
}

/** Qual atalho produz exatamente este período hoje — `null` se for personalizado. */
export function atalhoDoPeriodo(periodo: Periodo, agora: Date, tz: string): AtalhoDePeriodo | null {
  for (const atalho of ATALHOS_DE_PERIODO) {
    const p = periodoDoAtalho(atalho, agora, tz);
    if (p.de === periodo.de && p.ate === periodo.ate) return atalho;
  }
  return null;
}
