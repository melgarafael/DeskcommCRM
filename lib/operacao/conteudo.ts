/**
 * O CONTEÚDO CONGELADO, na volta: ler o jsonb guardado e respeitar a LGPD.
 *
 * O relatório guarda nome e telefone dos contatos do dia. Se um deles foi
 * anonimizado DEPOIS, a tela do relatório não pode continuar mostrando quem
 * ele era: `sobreporAnonimizados` troca, linha a linha, o contato congelado
 * pelo contato ATUAL de quem está anonimizado. O jsonb guardado não muda —
 * a dívida está declarada na migration 9395.
 */
import type { ContatoDaLinha, OperacaoDoDia } from "./tipos";

/** O jsonb é desta versão? Outro formato não é desenhado (a tela diz que não sabe ler). */
export function lerConteudo(bruto: unknown): OperacaoDoDia | null {
  if (!bruto || typeof bruto !== "object") return null;
  const c = bruto as Partial<OperacaoDoDia>;
  if (c.versao !== 1 || typeof c.dia !== "string" || !c.contadores || !c.falhas || !c.funil) return null;
  return c as OperacaoDoDia;
}

/** Todos os ids de contato citados no conteúdo. */
export function idsDeContatoDoConteudo(c: OperacaoDoDia): string[] {
  const ids = new Set<string>();
  const add = (x: ContatoDaLinha) => {
    if (x.contact_id) ids.add(x.contact_id);
  };
  for (const l of [...c.aguardando, ...c.projetos, ...c.reclamacoes, ...c.produtos]) add(l.contato);
  for (const n of [...c.funil.ganhos, ...c.funil.perdidos, ...c.funil.em_proposta]) add(n.contato);
  for (const m of c.falhas.mensagens) add(m.contato);
  for (const r of c.falhas.execucoes_da_ia) add(r.contato);
  return [...ids];
}

export interface ContatoAnonimizado {
  id: string;
  nome: string | null;
}

/** Troca o contato congelado pelo atual de quem foi anonimizado. Pura: devolve uma cópia. */
export function sobreporAnonimizados(c: OperacaoDoDia, anonimizados: readonly ContatoAnonimizado[]): OperacaoDoDia {
  if (anonimizados.length === 0) return c;
  const porId = new Map(anonimizados.map((a) => [a.id, a]));
  const trocar = (x: ContatoDaLinha): ContatoDaLinha => {
    const a = x.contact_id ? porId.get(x.contact_id) : undefined;
    return a ? { contact_id: x.contact_id, nome: a.nome, telefone: null, identidade: null } : x;
  };
  const linhas = <T extends { contato: ContatoDaLinha }>(xs: T[]): T[] => xs.map((x) => ({ ...x, contato: trocar(x.contato) }));
  return {
    ...c,
    aguardando: linhas(c.aguardando),
    projetos: linhas(c.projetos),
    reclamacoes: linhas(c.reclamacoes),
    produtos: linhas(c.produtos),
    funil: {
      ...c.funil,
      ganhos: linhas(c.funil.ganhos),
      perdidos: linhas(c.funil.perdidos),
      em_proposta: linhas(c.funil.em_proposta),
    },
    falhas: {
      ...c.falhas,
      mensagens: linhas(c.falhas.mensagens),
      execucoes_da_ia: linhas(c.falhas.execucoes_da_ia),
    },
  };
}
