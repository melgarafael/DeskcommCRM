/**
 * As regras do calendário da agência, puras e testáveis sem banco
 * (docs/agencia/SPEC-calendario.md, K2, K5, K7, K9).
 *
 * Todo "dia" aqui é `AAAA-MM-DD` no fuso da agência. A semana começa na
 * segunda-feira, como a equipe lê.
 */
import type { AlcanceDeClientes } from "../clientes/visibilidade";
import { diaLocal, instanteLocal } from "../tarefas/regras";
import { ROTULO_DO_TIPO, type Formato, type TipoDeReuniao } from "./vocabulario";

export const FUSO_DA_AGENCIA = "America/Sao_Paulo";
const DIA_MS = 86_400_000;

// ── Dias, semana e mês ─────────────────────────────────────────────────────

function partes(dia: string): [number, number, number] {
  const [a, m, d] = dia.split("-").map(Number);
  return [a ?? 1970, m ?? 1, d ?? 1];
}

function paraDia(utc: number): string {
  return new Date(utc).toISOString().slice(0, 10);
}

export function ehDia(valor: string | null | undefined): valor is string {
  return !!valor && /^\d{4}-\d{2}-\d{2}$/.test(valor) && !Number.isNaN(Date.parse(`${valor}T00:00:00Z`));
}

export function somarDias(dia: string, n: number): string {
  const [a, m, d] = partes(dia);
  return paraDia(Date.UTC(a, m - 1, d) + n * DIA_MS);
}

/** 0 = segunda … 6 = domingo. */
export function posicaoNaSemana(dia: string): number {
  const [a, m, d] = partes(dia);
  return (new Date(Date.UTC(a, m - 1, d)).getUTCDay() + 6) % 7;
}

export function inicioDaSemana(dia: string): string {
  return somarDias(dia, -posicaoNaSemana(dia));
}

export function diasDaSemana(dia: string): string[] {
  const seg = inicioDaSemana(dia);
  return Array.from({ length: 7 }, (_, i) => somarDias(seg, i));
}

/** As semanas (segunda a domingo) que cobrem o mês de `dia`. */
export function gradeDoMes(dia: string): string[][] {
  const [a, m] = partes(dia);
  const primeiro = `${a}-${String(m).padStart(2, "0")}-01`;
  const ultimo = paraDia(Date.UTC(a, m, 0));
  const semanas: string[][] = [];
  for (let seg = inicioDaSemana(primeiro); seg <= ultimo; seg = somarDias(seg, 7)) {
    semanas.push(Array.from({ length: 7 }, (_, i) => somarDias(seg, i)));
  }
  return semanas;
}

/** O instante UTC da meia-noite de `dia` no fuso da agência. */
export function meiaNoite(dia: string, fuso = FUSO_DA_AGENCIA): Date {
  const [a, m, d] = partes(dia);
  return instanteLocal(a, m, d, "00:00", fuso);
}

/** O instante UTC de `dia` às `hora` ("HH:MM") no fuso da agência. */
export function instanteDoDia(dia: string, hora: string, fuso = FUSO_DA_AGENCIA): Date {
  const [a, m, d] = partes(dia);
  return instanteLocal(a, m, d, hora, fuso);
}

export function horaLocal(iso: string, fuso = FUSO_DA_AGENCIA): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function diaDe(iso: string, fuso = FUSO_DA_AGENCIA): string {
  return diaLocal(new Date(iso), fuso);
}

const NOMES_DOS_DIAS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"] as const;

/** "seg 26/10" */
export function rotuloCurtoDoDia(dia: string): string {
  const [, m, d] = partes(dia);
  return `${NOMES_DOS_DIAS[posicaoNaSemana(dia)]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

/** "segunda-feira, 26 de outubro" */
export function rotuloLongoDoDia(dia: string): string {
  return meiaNoite(dia).toLocaleDateString("pt-BR", {
    timeZone: FUSO_DA_AGENCIA,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * Onde a reunião cai na faixa do dia (das 7h às 22h), em fração de 0 a 1.
 * O que passa das bordas é cortado nelas; `null` quando nada dela cabe no dia.
 */
export const FAIXA_INICIO_H = 7;
export const FAIXA_FIM_H = 22;

export function posicaoNaFaixa(inicioIso: string, fimIso: string, dia: string): { topo: number; altura: number } | null {
  const a = instanteDoDia(dia, `${String(FAIXA_INICIO_H).padStart(2, "0")}:00`).getTime();
  const b = instanteDoDia(dia, `${FAIXA_FIM_H}:00`).getTime();
  const i = Math.max(new Date(inicioIso).getTime(), a);
  const f = Math.min(new Date(fimIso).getTime(), b);
  if (f <= i) return null;
  const total = b - a;
  return { topo: (i - a) / total, altura: Math.max((f - i) / total, 0.02) };
}

// ── Fechamento uma semana depois (K5) ──────────────────────────────────────

/** O Brasil não tem horário de verão desde 2019: D+7 é somar 7 dias exatos. */
export function fechamentoUmaSemanaDepois(inicio: string, fim: string): { inicio: string; fim: string } {
  return {
    inicio: new Date(new Date(inicio).getTime() + 7 * DIA_MS).toISOString(),
    fim: new Date(new Date(fim).getTime() + 7 * DIA_MS).toISOString(),
  };
}

// ── Lembretes (K7) ─────────────────────────────────────────────────────────

/**
 * Quais marcos (minutos antes) de uma reunião MARCADA vencem agora.
 *
 * - um marco vence quando `inicio − marco ≤ agora < inicio`;
 * - marco cujo instante é anterior a `horarioEm` não conta: a pessoa acabou de
 *   ser avisada de que a reunião foi marcada, e um "falta 1 dia" logo em
 *   seguida é ruído;
 * - se o relógio atrasou e vários venceram juntos, só o mais PRÓXIMO da
 *   reunião é enviado; os outros são registrados como feitos, para não
 *   chegarem "falta 1 dia" e "falta 1 hora" no mesmo minuto.
 */
export function lembretesQueVencem(
  r: { inicio: string; horarioEm: string },
  marcos: readonly number[],
  jaFeitos: readonly string[],
  agora: Date,
): { enviar: number | null; registrar: number[] } {
  const inicio = new Date(r.inicio).getTime();
  const definido = new Date(r.horarioEm).getTime();
  const t = agora.getTime();
  if (t >= inicio) return { enviar: null, registrar: [] };
  const vencidos = marcos.filter((m) => {
    const instante = inicio - m * 60_000;
    return instante <= t && instante >= definido && !jaFeitos.includes(String(m));
  });
  if (vencidos.length === 0) return { enviar: null, registrar: [] };
  return { enviar: Math.min(...vencidos), registrar: vencidos };
}

export function rotuloDoLembrete(marco: number): string {
  if (marco % 1440 === 0) {
    const d = marco / 1440;
    return d === 1 ? "amanhã" : `em ${d} dias`;
  }
  if (marco % 60 === 0) {
    const h = marco / 60;
    return h === 1 ? "em 1 hora" : `em ${h} horas`;
  }
  return `em ${marco} minutos`;
}

// ── Quem vê (K9) ───────────────────────────────────────────────────────────

export interface QuemOlhaAgenda {
  /** Dono ou quem tem `calendario.gerenciar`. */
  gerencia: boolean;
  membroId: string | null;
  alcance: AlcanceDeClientes;
}

/**
 * Reunião de cliente: quem alcança o cliente (C5). Reunião interna (sem
 * cliente): quem está nela, e quem gerencia o calendário.
 */
export function podeVerReuniao(quem: QuemOlhaAgenda, r: { clienteId: string | null; membros: readonly string[] }): boolean {
  if (r.clienteId !== null) return quem.alcance.todos || quem.alcance.ids.has(r.clienteId);
  if (quem.gerencia) return true;
  return !!quem.membroId && r.membros.includes(quem.membroId);
}

// ── O que sai para fora ────────────────────────────────────────────────────

export function tituloSugerido(tipo: TipoDeReuniao, cliente: string | null): string {
  return cliente ? `${ROTULO_DO_TIPO[tipo]} — ${cliente}` : ROTULO_DO_TIPO[tipo];
}

function dataPorExtenso(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    timeZone: FUSO_DA_AGENCIA,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  });
}

/**
 * A mensagem do WhatsApp ao cliente (K4). Leva dia, hora e o caminho para
 * entrar — nunca a pauta, a ata ou o que a equipe escreveu para si.
 */
export function textoAoCliente(p: {
  nome: string;
  agencia: string;
  situacao: "marcada" | "remarcada" | "cancelada";
  tipo: TipoDeReuniao;
  inicio: string;
  formato: Formato;
  meetUrl: string | null;
  local: string | null;
  /** A reunião que já ficou marcada em seguida (o Fechamento da Apresentação, K5): vai na mesma mensagem. */
  seguinte?: { tipo: TipoDeReuniao; inicio: string } | null;
}): string {
  const primeiro = p.nome.trim().split(/\s+/)[0] || p.nome;
  const quando = `${dataPorExtenso(p.inicio)}, às ${horaLocal(p.inicio)}`;
  const reuniao = p.tipo === "interna" || p.tipo === "outra" ? "nossa reunião" : `nossa reunião de ${ROTULO_DO_TIPO[p.tipo]}`;
  if (p.situacao === "cancelada") {
    return `Olá, ${primeiro}! A ${reuniao} de ${quando} foi cancelada. Em breve combinamos um novo horário.\n\n${p.agencia}`;
  }
  const verbo = p.situacao === "remarcada" ? "foi remarcada para" : "está marcada para";
  const linhas = [`Olá, ${primeiro}! A ${reuniao} ${verbo} ${quando}.`];
  if (p.formato === "online" && p.meetUrl) linhas.push(`Para entrar: ${p.meetUrl}`);
  if (p.formato === "presencial" && p.local) linhas.push(`Local: ${p.local}`);
  if (p.formato === "ligacao") linhas.push("Vamos te ligar neste número.");
  if (p.seguinte) {
    linhas.push(`E o ${ROTULO_DO_TIPO[p.seguinte.tipo]} já fica marcado para ${dataPorExtenso(p.seguinte.inicio)}, às ${horaLocal(p.seguinte.inicio)}.`);
  }
  linhas.push(p.agencia);
  return linhas.join("\n\n");
}

/** O corpo do evento na Agenda Google (K2). O Meet só é pedido para reunião online. */
export function corpoDoEvento(p: {
  reuniaoId: string;
  titulo: string;
  inicio: string;
  fim: string;
  formato: Formato;
  local: string | null;
  emails: readonly string[];
  /** Muda a cada pedido de Meet; o Google recusa reusar o mesmo. */
  pedidoDeMeet: string | null;
}): Record<string, unknown> {
  // O Google recusa o evento inteiro se `attendees` tiver e-mail repetido.
  const unicos = new Set(p.emails.map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)));
  const attendees = [...unicos].map((email) => ({ email }));
  const corpo: Record<string, unknown> = {
    summary: p.titulo,
    start: { dateTime: p.inicio, timeZone: FUSO_DA_AGENCIA },
    end: { dateTime: p.fim, timeZone: FUSO_DA_AGENCIA },
    attendees,
    extendedProperties: { private: { agencia_reuniao_id: p.reuniaoId } },
  };
  if (p.formato === "presencial" && p.local) corpo.location = p.local;
  if (p.formato === "online" && p.pedidoDeMeet) {
    corpo.conferenceData = { createRequest: { requestId: p.pedidoDeMeet, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  return corpo;
}
