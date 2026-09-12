/**
 * Elegibilidade de atendente para roteamento (spec 13 §5).
 *
 * Elegível = disponível ∧ dentro do horário (schedule tz-aware) ∧ abaixo da
 * capacidade. Lógica PURA e testável — o worker de G5-02 (cron TS) importa daqui
 * e passa o `now` + a carga atual (conversas abertas atribuídas). Sem acesso a
 * DB, sem relógio implícito: o `now` é sempre injetado (teste usa clock mockado).
 *
 * ⚠️ NÃO HÁ MAIS AUTO-OFFLINE POR PRESENÇA, e a remoção é o conserto.
 *
 * Havia aqui um `HEARTBEAT_TIMEOUT_MINUTES = 15` e um `isHeartbeatStale`, que
 * o cron `/api/v1/cron/attendant-heartbeat` usava para gravar
 * `is_available = false` em quem não desse sinal de vida. **O sinal nunca
 * existiu**: varredura do repositório inteiro em 2026-09-11 não achou emissor
 * nenhum — nem hook, nem `setInterval`, nem `beforeunload`. O único escritor de
 * `last_heartbeat_at` era o próprio botão, no clique.
 *
 * Então a varredura derrubava TODO atendente ~15 min depois de ele se declarar
 * de plantão, em toda instalação, sempre. E nada o religava: a jornada
 * publicada só sabe RESTRINGIR (`isWithinSchedule`), nunca ACENDER.
 *
 * A causa raiz era de modelagem: `is_available` carregava duas coisas na mesma
 * coluna — "eu me declarei de plantão" (decisão, que dura) e "meu navegador
 * está vivo agora" (presença, que expira). A varredura de presença escrevia por
 * cima da decisão.
 *
 * Agora `is_available` é só a decisão, e quem manda no dia a dia é a jornada,
 * CALCULADA a cada leitura (`estaDePlantao`). Calcular em vez de gravar é o que
 * faz o "religa sozinho" existir: não há o que religar, porque nada foi
 * desligado — e é o anti-pattern 5 da doutrina ao contrário (campo sincronizado
 * por cron que devia ser derivado).
 */
import type { AvailabilitySchedule } from "@/lib/schemas/routing";

/**
 * Status de conversa que contam como "carga" do atendente (aberta atribuída);
 * resolved/closed/archived não. Fonte única: o worker de roteamento (elegibilidade
 * por capacidade) e o painel de atendimento (carga exibida) leem daqui — o número
 * que o manager vê é o mesmo que o router usa.
 */
export const OPEN_LOAD_STATUSES = ["open", "pending", "claimed", "ai_handling"] as const;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Momento local (dow 0-6 + "HH:MM") de `now` no timezone dado. tz-aware via
 * Intl (stdlib, sem dependência) — respeita DST do fuso.
 *
 * EXPORTADA porque a agenda (`lib/agenda/fuso.ts`) faz a MESMA pergunta — em que
 * dia da semana cai este instante, no fuso da jornada — e escrever uma segunda
 * versão dela seria a duplicação que já custou um bug de fuso a esta base. O
 * corpo não mudou; só deixou de ser privado ao módulo.
 */
export function localMoment(now: Date, timezone: string): { dow: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dow = WEEKDAY_INDEX[get("weekday")] ?? 0;
  const hhmm = `${get("hour")}:${get("minute")}`;
  return { dow, hhmm };
}

/**
 * `now` cai dentro de alguma janela do schedule?
 * `windows` vazio (default do DB `{}`) = sem restrição de horário ⇒ true (24/7);
 * janelas existem para RESTRINGIR, não para habilitar.
 */
export function isWithinSchedule(
  schedule: Pick<AvailabilitySchedule, "timezone" | "windows"> | null | undefined,
  now: Date,
): boolean {
  const windows = schedule?.windows ?? [];
  if (windows.length === 0) return true;
  const timezone = schedule?.timezone || "America/Sao_Paulo";
  const { dow, hhmm } = localMoment(now, timezone);
  return windows.some((w) => w.dow === dow && hhmm >= w.start && hhmm < w.end);
}

/**
 * O atendente está de plantão NESTE instante?
 *
 * A regra inteira, e ela é a que o dono do produto enuncia:
 *
 * | chave | jornada publicada | agora |
 * |-------|-------------------|-------|
 * | desligada | qualquer | **off** — decisão de gente vence tudo |
 * | ligada | nenhuma | **on 24/7** |
 * | ligada | tem | **on dentro dela, off fora** — e volta sozinho |
 *
 * DERIVADA, nunca gravada. É o que torna "religa sozinho" verdade sem cron
 * nenhum: às 18h01 a conta dá `false`, às 08h00 do dia seguinte dá `true`, e
 * ninguém escreveu nada no banco no meio. Gravar exigiria uma rodada periódica
 * para reacender — que é o anti-pattern 5 da doutrina, e foi o que estava aqui.
 *
 * Esta é a MESMA conta que `isAttendantEligible` faz (sem a capacidade): a tela
 * e o roteador têm de dizer a mesma coisa sobre a mesma pessoa. Antes não
 * diziam — a tela lia presença e o roteador lia a jornada.
 */
export function estaDePlantao(
  input: { isAvailable: boolean; schedule?: Pick<AvailabilitySchedule, "timezone" | "windows"> | null },
  now: Date,
): boolean {
  return input.isAvailable && isWithinSchedule(input.schedule ?? null, now);
}

export interface AttendantEligibilityInput {
  isAvailable: boolean;
  capacity: number;
  /** Conversas abertas atribuídas ao atendente (carga atual). */
  currentLoad: number;
  schedule?: Pick<AvailabilitySchedule, "timezone" | "windows"> | null;
}

/** disponível ∧ com folga (carga < capacidade) ∧ dentro do horário (§5). */
export function isAttendantEligible(input: AttendantEligibilityInput, now: Date): boolean {
  return (
    input.isAvailable &&
    input.currentLoad < input.capacity &&
    isWithinSchedule(input.schedule ?? null, now)
  );
}
