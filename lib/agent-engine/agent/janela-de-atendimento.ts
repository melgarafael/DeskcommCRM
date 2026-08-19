/**
 * Horário de funcionamento do agente — a regra que a tela oferecia e ninguém lia.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * `TriggerEditor.tsx` mostra "Só atender em horário de funcionamento" com fuso,
 * início, fim e dias da semana, e grava tudo em
 * `ai_agent_versions.trigger_config.filters.business_hours`. O ÚNICO leitor
 * desse campo era `lib/ai/dispatcher/triggers.ts` — o dispatcher legado, que
 * hoje é NO-OP permanente (`app/api/v1/cron/agent-dispatcher/route.ts`). O
 * runtime vivo (`lib/agent-engine`) nunca soube que o campo existia.
 *
 * Resultado medido numa instalação real (2026-08-18): a versão publicada dizia
 * 08:00–18:00, seg–sex, e o agente respondia 21:55 de uma terça — porque nada
 * consultava a janela. Um controle que a tela oferece e o código ignora mente
 * para quem configurou; é o mesmo defeito que o `HANDOFF-followup-vivo.md`
 * cataloga como "o tempo adaptativo é decorativo".
 *
 * ## Por que ADIAR, e não descartar
 *
 * O dispatcher morto tratava "fora da janela" como `no_match`: a mensagem
 * simplesmente não era respondida, nunca. Aqui o turno é REAGENDADO para a
 * abertura da janela — quem escreveu às 22h é atendido às 8h, e não no
 * esquecimento. Silêncio permanente é o modo de falha que este repo já pagou
 * caro; a janela pode atrasar a resposta, não pode sumir com ela.
 *
 * ## Falha ABERTA, sempre
 *
 * `trigger_config` é jsonb livre: fuso inválido, horário torto, dias vazios,
 * shape estranho — tudo devolve `null` (sem janela), e sem janela o agente
 * responde. A direção segura aqui é o contrário da doutrina de tools: uma
 * config quebrada não pode virar mordaça.
 */

export interface JanelaDeAtendimento {
  /** IANA (`America/Sao_Paulo`). Inválido ⇒ a janela inteira é descartada. */
  timezone: string;
  /** `HH:MM` local. */
  start: string;
  /** `HH:MM` local, sempre MAIOR que `start` (ver `lerJanelaDeAtendimento`). */
  end: string;
  /** 0=domingo … 6=sábado, sem repetição, ao menos um. */
  weekdays: number[];
}

const HORA_RX = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function minutosDe(hhmm: string): number | null {
  const m = HORA_RX.exec(hhmm);
  if (m === null) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Extrai a janela de `trigger_config` (jsonb livre da versão publicada).
 * `null` = sem janela declarada OU declarada de forma que não dá para obedecer.
 */
export function lerJanelaDeAtendimento(triggerConfig: unknown): JanelaDeAtendimento | null {
  if (typeof triggerConfig !== 'object' || triggerConfig === null) return null;
  const filters = (triggerConfig as { filters?: unknown }).filters;
  if (typeof filters !== 'object' || filters === null) return null;
  const bh = (filters as { business_hours?: unknown }).business_hours;
  if (typeof bh !== 'object' || bh === null) return null;

  const { timezone, start, end, weekdays } = bh as {
    timezone?: unknown;
    start?: unknown;
    end?: unknown;
    weekdays?: unknown;
  };
  if (typeof timezone !== 'string' || timezone.trim() === '') return null;
  if (typeof start !== 'string' || typeof end !== 'string') return null;

  const inicio = minutosDe(start);
  const fim = minutosDe(end);
  if (inicio === null || fim === null) return null;
  // Janela que vira a meia-noite (22:00–02:00) não é suportada, e recusá-la é
  // melhor que interpretá-la ao contrário: `fim <= inicio` viraria "fechado
  // sempre", que é justamente a mordaça que este arquivo não pode criar.
  if (fim <= inicio) return null;

  if (!Array.isArray(weekdays) || weekdays.length === 0) return null;
  const dias = [
    ...new Set(
      weekdays.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6),
    ),
  ];
  if (dias.length === 0) return null;

  // Fuso que o ambiente não conhece ⇒ sem janela (falha aberta).
  try {
    relogioLocal(timezone, new Date());
  } catch {
    return null;
  }

  return { timezone, start, end, weekdays: dias };
}

/** Dia da semana (0–6) e minutos desde a meia-noite NO FUSO da janela. */
function relogioLocal(timezone: string, agora: Date): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(agora);

  const valor = (tipo: Intl.DateTimeFormatPartTypes): string =>
    partes.find((p) => p.type === tipo)?.value ?? '';

  const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dia = DIAS[valor('weekday')] ?? 0;
  // 24 é a meia-noite em algumas ICUs com hour12:false — normaliza para 0.
  const hora = Number(valor('hour')) % 24;
  return { dia, minutos: hora * 60 + Number(valor('minute')) };
}

/**
 * `null` = a janela está ABERTA agora (o turno segue). Caso contrário, quantos
 * milissegundos faltam para a próxima abertura — sempre > 0.
 *
 * ponytail: a conta é feita em minutos de relógio de parede, então uma virada de
 * horário de verão dentro do intervalo desloca o alvo em até 1h (o job acorda,
 * reavalia e reagenda — a janela nunca é pulada, só reconferida). Brasil não tem
 * DST hoje; se algum fuso de cliente tiver e a hora importar, o upgrade é somar
 * o offset do dia-alvo, não uma biblioteca inteira.
 */
export function msAteAJanelaAbrir(janela: JanelaDeAtendimento, agora: Date): number | null {
  let local: { dia: number; minutos: number };
  try {
    local = relogioLocal(janela.timezone, agora);
  } catch {
    return null; // falha aberta
  }

  const inicio = minutosDe(janela.start);
  const fim = minutosDe(janela.end);
  if (inicio === null || fim === null) return null;

  const aberta =
    janela.weekdays.includes(local.dia) && local.minutos >= inicio && local.minutos < fim;
  if (aberta) return null;

  for (let offset = 0; offset <= 7; offset += 1) {
    const dia = (local.dia + offset) % 7;
    if (!janela.weekdays.includes(dia)) continue;
    if (offset === 0 && local.minutos >= inicio) continue; // hoje a janela já passou
    const minutosAteAbrir = offset * 24 * 60 + inicio - local.minutos;
    if (minutosAteAbrir > 0) return minutosAteAbrir * 60_000;
  }

  return null; // inalcançável com weekdays não-vazio; falha aberta por precaução
}
