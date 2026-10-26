/**
 * As regras da trilha do cliente, puras e testáveis sem banco
 * (docs/agencia/SPEC-trilhas.md, R4–R6, R8).
 */
import { diaDe, instanteDoDia, somarDias } from "../calendario/regras";
import {
  HORA_DO_PRAZO,
  SITUACOES_FEITAS,
  type RegraDePrazo,
  type SituacaoDoPasso,
  type TipoDePasso,
} from "./vocabulario";

const DIA_MS = 86_400_000;

// ── Regra do dia 15 (R6) ───────────────────────────────────────────────────

export interface CalendarioDoContrato {
  /** Dia 1 em que o contrato começa. */
  inicio: string;
  /** Último dia do mês de preparação. */
  preparacaoFim: string;
  /** Dia 1 do mês da primeira postagem. */
  primeiraPostagem: string;
  /** Último dia do contrato mínimo de 3 meses. */
  fimMinimo: string;
}

function primeiroDoMes(ano: number, mes: number): string {
  // `mes` pode passar de 12: Date.UTC normaliza.
  return new Date(Date.UTC(ano, mes - 1, 1)).toISOString().slice(0, 10);
}

function ultimoDoMes(ano: number, mes: number): string {
  return new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
}

/**
 * Assinou e pagou (a última das duas) até o dia 15: contrato no dia 1 do mesmo
 * mês, preparação até o fim dele. Do dia 16 em diante: contrato no dia 1 do mês
 * seguinte e a preparação vai até o fim desse mês — os dias do mês corrente são
 * cortesia. Mapa › Calendário do contrato.
 */
export function calendarioDoContrato(assinouPagou: string): CalendarioDoContrato {
  const [ano, mes, dia] = assinouPagou.split("-").map(Number) as [number, number, number];
  const desloca = dia <= 15 ? 0 : 1;
  return {
    inicio: primeiroDoMes(ano, mes + desloca),
    preparacaoFim: ultimoDoMes(ano, mes + desloca),
    primeiraPostagem: primeiroDoMes(ano, mes + desloca + 1),
    fimMinimo: ultimoDoMes(ano, mes + desloca + 2),
  };
}

// ── Desbloqueio (R4) ───────────────────────────────────────────────────────

export interface PassoParaDesbloqueio {
  chave: string;
  situacao: SituacaoDoPasso;
  dependeDe: readonly string[];
}

/** As chaves dos passos BLOQUEADOS cujas dependências estão todas feitas (concluídas ou puladas). */
export function passosQueLiberam(passos: readonly PassoParaDesbloqueio[]): string[] {
  const feitas = new Set(passos.filter((p) => SITUACOES_FEITAS.includes(p.situacao)).map((p) => p.chave));
  return passos.filter((p) => p.situacao === "bloqueado" && p.dependeDe.every((d) => feitas.has(d))).map((p) => p.chave);
}

/** Todos os passos de que `chave` depende, direta ou indiretamente (R8: começar do meio pula estes). */
export function antecessores(passos: readonly PassoParaDesbloqueio[], chave: string): Set<string> {
  const porChave = new Map(passos.map((p) => [p.chave, p]));
  const vistos = new Set<string>();
  const fila = [...(porChave.get(chave)?.dependeDe ?? [])];
  while (fila.length) {
    const c = fila.pop()!;
    if (vistos.has(c)) continue;
    vistos.add(c);
    fila.push(...(porChave.get(c)?.dependeDe ?? []));
  }
  return vistos;
}

export function progresso(passos: ReadonlyArray<{ situacao: SituacaoDoPasso }>): { feitos: number; total: number; pct: number } {
  const contam = passos.filter((p) => p.situacao !== "pulado");
  const feitos = contam.filter((p) => p.situacao === "concluido").length;
  return { feitos, total: contam.length, pct: contam.length ? Math.round((feitos / contam.length) * 100) : 100 };
}

/** A menor etapa que ainda tem passo por fazer; `null` quando tudo está feito. */
export function etapaAtual(passos: ReadonlyArray<{ etapa: number; situacao: SituacaoDoPasso }>): number | null {
  const abertas = passos.filter((p) => !SITUACOES_FEITAS.includes(p.situacao)).map((p) => p.etapa);
  return abertas.length ? Math.min(...abertas) : null;
}

// ── Prazo do passo (R5) ────────────────────────────────────────────────────

export interface PassoParaPrazo {
  regra: RegraDePrazo;
  dias: number | null;
  ancora: string | null;
}

/**
 * O prazo do passo, ou `null` quando ainda não dá para saber (âncora sem data,
 * preparação sem contrato). `instanteDaAncora` é a data da reunião do passo
 * âncora, ou o momento em que o passo âncora foi concluído.
 */
export function prazoDoPasso(
  p: PassoParaPrazo,
  ctx: {
    liberadoEm: Date;
    instanteDaAncora: (chave: string) => Date | null;
    preparacaoFim: string | null;
  },
): Date | null {
  const dias = p.dias ?? 0;
  switch (p.regra) {
    case "manual":
      return null;
    case "apos_liberar":
      return instanteDoDia(somarDias(diaDe(ctx.liberadoEm.toISOString()), dias), HORA_DO_PRAZO);
    case "apos_ancora": {
      const base = p.ancora ? ctx.instanteDaAncora(p.ancora) : null;
      return base ? new Date(base.getTime() + dias * DIA_MS) : null;
    }
    case "fim_preparacao":
      return ctx.preparacaoFim ? instanteDoDia(ctx.preparacaoFim, HORA_DO_PRAZO) : null;
  }
}

// ── Quem faz (R7) ──────────────────────────────────────────────────────────

/**
 * Os responsáveis da tarefa do passo: quem está na equipe do cliente E tem a
 * função do passo. Lista vazia = a tarefa vai para a função inteira ("Pegar").
 */
export function responsaveisDoPasso(
  funcaoId: string | null,
  equipeDoCliente: ReadonlyArray<{ membroId: string; funcoes: readonly string[] }>,
): string[] {
  if (!funcaoId) return [];
  return equipeDoCliente.filter((m) => m.funcoes.includes(funcaoId)).map((m) => m.membroId);
}

// ── Validação do modelo ────────────────────────────────────────────────────

export interface PassoDoModelo {
  chave: string;
  titulo: string;
  tipo: TipoDePasso;
  reuniaoTipo: string | null;
  dependeDe: readonly string[];
  regra: RegraDePrazo;
  ancora: string | null;
}

/** A primeira coisa errada no modelo, em português; `null` quando está certo. */
export function problemaNoModelo(passos: readonly PassoDoModelo[]): string | null {
  if (passos.length === 0) return "O modelo precisa de pelo menos um passo.";
  const chaves = new Set<string>();
  for (const p of passos) {
    if (!/^[a-z0-9_]{2,40}$/.test(p.chave)) return `Chave inválida: "${p.chave}". Use letras minúsculas, números e _.`;
    if (chaves.has(p.chave)) return `A chave "${p.chave}" aparece duas vezes.`;
    chaves.add(p.chave);
  }
  for (const p of passos) {
    for (const d of p.dependeDe) {
      if (d === p.chave) return `"${p.titulo}" não pode depender de si mesmo.`;
      if (!chaves.has(d)) return `"${p.titulo}" depende de um passo que não existe (${d}).`;
    }
    if (p.tipo === "reuniao" && !p.reuniaoTipo) return `Escolha o tipo de reunião de "${p.titulo}".`;
    if (p.regra === "apos_ancora") {
      if (!p.ancora || !chaves.has(p.ancora)) return `Escolha de qual passo o prazo de "${p.titulo}" é contado.`;
      if (p.ancora === p.chave) return `O prazo de "${p.titulo}" não pode ser contado a partir dele mesmo.`;
    }
  }
  // Sem ciclo: algum passo sem dependência, e todos alcançáveis por desbloqueio.
  const simulados: PassoParaDesbloqueio[] = passos.map((p) => ({ chave: p.chave, situacao: "bloqueado", dependeDe: p.dependeDe }));
  for (;;) {
    const liberam = passosQueLiberam(simulados);
    if (liberam.length === 0) break;
    for (const s of simulados) if (liberam.includes(s.chave)) s.situacao = "concluido";
  }
  const presos = simulados.filter((s) => s.situacao === "bloqueado");
  if (presos.length) return `Há dependências em círculo: ${presos.map((p) => p.chave).join(", ")} nunca seriam liberados.`;
  return null;
}
