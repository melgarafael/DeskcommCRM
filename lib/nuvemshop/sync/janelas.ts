/**
 * Janelas de `updated_at` da sincronização (spec §4.2). Puro.
 *
 * Toda janela tem no máximo 1 mês: backfill começa em `alvo − 12 meses`,
 * reconciliação em `cursor`. A janela fica FIXA durante a paginação; pedido
 * alterado no meio sai dela e volta na próxima reconciliação.
 */
import { MESES_DE_BACKFILL, PAGINA_MAXIMA, PAGINA_TAMANHO, type PassoDoSync } from "./constantes";

const DOIS_MINUTOS = 2 * 60_000;

function somarMeses(iso: string, meses: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + meses);
  return d.toISOString();
}

function menor(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function janelaDesde(ini: string, alvo: string): { janela_ini: string; janela_fim: string } {
  return { janela_ini: ini, janela_fim: menor(somarMeses(ini, 1), alvo) };
}

export function primeiroPasso(args: { runId: string; cursor: string | null; agora: Date }): PassoDoSync {
  const alvo = args.agora.toISOString();
  const ini = args.cursor ? new Date(args.cursor).toISOString() : somarMeses(alvo, -MESES_DE_BACKFILL);
  return { run_id: args.runId, ...janelaDesde(menor(ini, alvo), alvo), alvo_fim: alvo, pagina: 1 };
}

export type ProximoPasso = { tipo: "pagina"; passo: PassoDoSync; perda: boolean } | { tipo: "fim"; perda: boolean };

function proximaJanela(passo: PassoDoSync, perda: boolean): ProximoPasso {
  if (Date.parse(passo.janela_fim) >= Date.parse(passo.alvo_fim)) return { tipo: "fim", perda };
  return { tipo: "pagina", passo: { ...passo, ...janelaDesde(passo.janela_fim, passo.alvo_fim), pagina: 1 }, perda };
}

export function proximoPasso(passo: PassoDoSync, itensNaPagina: number): ProximoPasso {
  const cheia = itensNaPagina >= PAGINA_TAMANHO;
  if (cheia && passo.pagina >= PAGINA_MAXIMA) {
    const ini = Date.parse(passo.janela_ini);
    const fim = Date.parse(passo.janela_fim);
    if (fim - ini <= DOIS_MINUTOS) return proximaJanela(passo, true);
    const meio = new Date(ini + Math.floor((fim - ini) / 2)).toISOString();
    return { tipo: "pagina", passo: { ...passo, janela_fim: meio, pagina: 1 }, perda: false };
  }
  if (cheia) return { tipo: "pagina", passo: { ...passo, pagina: passo.pagina + 1 }, perda: false };
  return proximaJanela(passo, false);
}

/** "Importando: mês N de 12" — N a partir de onde a janela atual começa. */
export function mesDoBackfill(janelaIni: string, alvoFim: string): number {
  const ini = new Date(janelaIni);
  const inicio = new Date(somarMeses(alvoFim, -MESES_DE_BACKFILL));
  const meses = (ini.getUTCFullYear() - inicio.getUTCFullYear()) * 12 + (ini.getUTCMonth() - inicio.getUTCMonth());
  return Math.min(MESES_DE_BACKFILL, Math.max(1, meses + 1));
}
