/**
 * Arrastar e esticar no calendário (plano de 27/10, item 3). Puro: a tela mede
 * os pixels, aqui viram minutos e o horário novo. Encaixe de 15 em 15 minutos,
 * sempre dentro da faixa do dia (7h–22h) e com no mínimo 15 minutos de duração.
 */
import { diaDe, FAIXA_FIM_H, FAIXA_INICIO_H, horaLocal, instanteDoDia } from "./regras";

export const ENCAIXE_MIN = 15;

/** Pixels arrastados → minutos, encaixados em 15. */
export function minutosDoArrasto(dyPx: number, alturaDaHoraPx: number): number {
  return Math.round((dyPx / alturaDaHoraPx) * (60 / ENCAIXE_MIN)) * ENCAIXE_MIN;
}

function minutosDoDia(iso: string): number {
  const [h, m] = horaLocal(iso).split(":").map(Number) as [number, number];
  return h * 60 + m;
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * O horário depois do gesto.
 * - `mover`: muda o dia (se veio outro) e desloca início e fim juntos, mantendo a duração.
 * - `esticar`: só o fim anda, com no mínimo 15 minutos de reunião.
 * Devolve `null` quando nada mudou.
 */
export function horarioDepoisDoGesto(p: {
  inicio: string;
  fim: string;
  modo: "mover" | "esticar";
  deltaMin: number;
  diaNovo?: string;
}): { inicio: string; fim: string } | null {
  const diaAntigo = diaDe(p.inicio);
  const dia = p.diaNovo ?? diaAntigo;
  const ini = minutosDoDia(p.inicio);
  const duracao = Math.max(ENCAIXE_MIN, Math.round((new Date(p.fim).getTime() - new Date(p.inicio).getTime()) / 60_000));
  const piso = FAIXA_INICIO_H * 60;
  const teto = FAIXA_FIM_H * 60;
  let novoIni = ini;
  let novaDur = duracao;
  if (p.modo === "mover") {
    novoIni = Math.min(Math.max(ini + p.deltaMin, piso), teto - Math.min(duracao, teto - piso));
  } else {
    novaDur = Math.max(ENCAIXE_MIN, Math.min(duracao + p.deltaMin, teto - ini));
  }
  if (dia === diaAntigo && novoIni === ini && novaDur === duracao) return null;
  const inicio = instanteDoDia(dia, hhmm(novoIni));
  return { inicio: inicio.toISOString(), fim: new Date(inicio.getTime() + novaDur * 60_000).toISOString() };
}
