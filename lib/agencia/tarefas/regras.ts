/**
 * As regras das tarefas da agência, puras e testáveis sem banco
 * (docs/agencia/SPEC-tarefas.md, T3, T4, T8, T9, T11).
 */
import type { AlcanceDeClientes } from "../clientes/visibilidade";
import type { Coluna, Padrao } from "./vocabulario";

// ── Quem vê (T11) ───────────────────────────────────────────────────────────

export interface QuemOlha {
  verTodas: boolean;
  membroId: string | null;
  funcoesIds: readonly string[];
  alcance: AlcanceDeClientes;
}

export interface TarefaParaVisibilidade {
  clienteId: string | null;
  funcaoId: string | null;
  responsaveis: readonly string[];
}

export function podeVerTarefa(quem: QuemOlha, t: TarefaParaVisibilidade): boolean {
  if (t.clienteId !== null && !quem.alcance.todos && !quem.alcance.ids.has(t.clienteId)) return false;
  if (quem.verTodas) return true;
  if (quem.membroId && t.responsaveis.includes(quem.membroId)) return true;
  // Tarefa da função, ainda sem dono: aparece para todos daquela função (T3).
  if (t.funcaoId && t.responsaveis.length === 0 && quem.funcoesIds.includes(t.funcaoId)) return true;
  return false;
}

/** "Pegar" só vale para tarefa de função que ainda não tem responsável, e para quem é da função. */
export function podePegar(quem: QuemOlha, t: TarefaParaVisibilidade): boolean {
  return !!quem.membroId && !!t.funcaoId && t.responsaveis.length === 0 && quem.funcoesIds.includes(t.funcaoId);
}

// ── Prazo ──────────────────────────────────────────────────────────────────

export function estaAtrasada(t: { prazo: string | null; coluna: Coluna }, agora: Date): boolean {
  return t.coluna !== "concluido" && t.prazo !== null && new Date(t.prazo).getTime() < agora.getTime();
}

const FUSO = "America/Sao_Paulo";

/** "AAAA-MM-DD" do instante no fuso da agência. */
export function diaLocal(instante: Date, fuso = FUSO): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).format(instante);
}

function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Data e hora como a equipe lê, SEMPRE no fuso da agência. Sem o fuso, o que a
 * tela mostra depende de onde ela foi montada: no servidor (UTC) um prazo das
 * 18h aparecia como 21h — medido no teste em 24/10/2026.
 */
export function formatarDataHora(iso: string, opcoes: { comAno?: boolean } = {}, fuso = FUSO): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: fuso,
    day: "2-digit",
    month: "2-digit",
    ...(opcoes.comAno ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type MarcoDePrazo = `antes_${number}d` | "no_dia" | "atrasou";

/**
 * O marco que vale AGORA para uma tarefa aberta (T8), ou `null`. Quem chama
 * confere em `agencia_avisos_de_prazo` se ele já foi avisado — cada marco uma vez.
 *
 *  - atrasou: o prazo passou;
 *  - no_dia: hoje é o dia do prazo (no fuso da agência);
 *  - antes_Nd: faltam exatamente N dias e N está na antecedência configurada.
 */
export function marcoDePrazo(prazo: Date, antecedencia: readonly number[], agora: Date, fuso = FUSO): MarcoDePrazo | null {
  if (prazo.getTime() < agora.getTime()) return "atrasou";
  const faltam = diasEntre(diaLocal(agora, fuso), diaLocal(prazo, fuso));
  if (faltam === 0) return "no_dia";
  if (faltam > 0 && antecedencia.includes(faltam)) return `antes_${faltam}d`;
  return null;
}

// ── Cronômetro (T4) ────────────────────────────────────────────────────────

export interface SessaoDeTempo {
  inicio: string;
  fim: string | null;
}

/** Total em segundos; a sessão aberta conta até `agora`. */
export function tempoTotalSegundos(sessoes: readonly SessaoDeTempo[], agora: Date): number {
  let total = 0;
  for (const s of sessoes) {
    const fim = s.fim ? new Date(s.fim).getTime() : agora.getTime();
    total += Math.max(0, fim - new Date(s.inicio).getTime());
  }
  return Math.floor(total / 1000);
}

export function formatarDuracao(segundos: number): string {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

// ── Recorrência (T9) ───────────────────────────────────────────────────────

export interface Recorrencia {
  padrao: Padrao;
  diasSemana: readonly number[]; // 0 = domingo
  diaDoMes: number | null;
  hora: string; // "HH:MM" ou "HH:MM:SS"
  inicio: string; // "AAAA-MM-DD"
  fim: string | null;
}

function partesLocais(instante: Date, fuso: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(instante);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(v("weekday"));
  return { ano: Number(v("year")), mes: Number(v("month")), dia: Number(v("day")), dow };
}

/** O instante UTC de "AAAA-MM-DD HH:MM" no fuso informado (o Brasil não tem horário de verão desde 2019). */
export function instanteLocal(ano: number, mes: number, dia: number, hora: string, fuso: string): Date {
  const [h, m] = hora.split(":").map((x) => Number(x));
  const palpite = new Date(Date.UTC(ano, mes - 1, dia, h ?? 0, m ?? 0));
  // Ajusta pelo deslocamento do fuso naquele instante.
  const local = new Date(palpite.toLocaleString("en-US", { timeZone: fuso }));
  const utc = new Date(palpite.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(palpite.getTime() + (utc.getTime() - local.getTime()));
}

function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * A próxima execução DEPOIS de `depoisDe` (exclusivo), ou `null` quando a
 * recorrência já acabou. Mensal no dia 31 cai no último dia dos meses curtos.
 */
export function proximaExecucao(r: Recorrencia, depoisDe: Date, fuso = FUSO): Date | null {
  const inicio = new Date(`${r.inicio}T00:00:00Z`);
  let cursor = depoisDe.getTime() < inicio.getTime() ? new Date(inicio.getTime() - 86_400_000) : depoisDe;
  // No máximo ~400 dias à frente: cobre o mensal com folga.
  for (let i = 0; i < 400; i++) {
    const { ano, mes, dia, dow } = partesLocais(cursor, fuso);
    const candidatoDia =
      r.padrao === "diaria"
        ? true
        : r.padrao === "semanal"
          ? r.diasSemana.includes(dow)
          : dia === Math.min(r.diaDoMes ?? 1, ultimoDiaDoMes(ano, mes));
    if (candidatoDia) {
      const quando = instanteLocal(ano, mes, dia, r.hora, fuso);
      const dataLocal = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
      if (quando.getTime() > depoisDe.getTime() && dataLocal >= r.inicio) {
        if (r.fim && dataLocal > r.fim) return null;
        return quando;
      }
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
    const prox = partesLocais(cursor, fuso);
    if (r.fim && `${prox.ano}-${String(prox.mes).padStart(2, "0")}-${String(prox.dia).padStart(2, "0")}` > r.fim) return null;
  }
  return null;
}
