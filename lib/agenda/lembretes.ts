/**
 * LEMBRETES DO TIPO DE AGENDAMENTO — a lista que a tela edita.
 *
 * O banco guarda o degrau principal em `reminder_minutes_before`, os demais em
 * `reminder_extra_offsets_minutes` e o texto de cada extra em `reminder_bodies`
 * (mapa minuto → frase). A tela não fala essa língua: ela vê N cartões iguais,
 * cada um com antecedência e mensagem. Empacotar/desempacotar é a fronteira,
 * uma vez, em vez de cada leitor reinventar qual é o "principal".
 *
 * O teto de extras é guarda contra laço acidental (formulário que duplica
 * cartão), não o "no máximo 3 para não insistir" da 0254. Quem decide quantos
 * avisos o cliente recebe é quem opera o tipo.
 */

/** Piso/teto que a rota cobra. Abaixo de 15 o cron nunca dispara; acima de 7 dias não é lembrete. */
export const LEMBRETE_MIN_MINUTOS = 15;
export const LEMBRETE_MAX_MINUTOS = 10_080;

/** Teto de degraus ADICIONAIS. O principal não conta. Tem de bater com `fn_degraus_de_lembrete_validos`. */
export const TETO_DE_LEMBRETES_EXTRAS = 20;

export interface PassoDeLembrete {
  minutes: number;
  body: string;
  /**
   * A opção POR DEGRAU da issue #5154: este aviso leva a linha automática do
   * link da reunião? Padrão `true` — é o comportamento de sempre.
   */
  comLink: boolean;
}

export interface LembretesEmpacotados {
  principal: number;
  extras: number[];
  corpoPrincipal: string;
  corposExtras: Record<string, string>;
  /** Degraus (minutos) cujo aviso sai SEM a linha do link. Vazio = todos levam. */
  degrausSemLink: number[];
}

export function lerCorposDoLembrete(bruto: unknown): Record<string, string> {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || typeof v !== "string") continue;
    const t = v.trim();
    if (t) out[k] = t.slice(0, 1000);
  }
  return out;
}

/**
 * A lista da tela → o que o PATCH grava.
 *
 * Duplicata some (dois cartões no mesmo minuto seriam o mesmo aviso duas vezes).
 * Fora da faixa some também: a recusa COM NOME é da rota, e chegar lá com NaN
 * é pior do que omitir o cartão quebrado.
 */
export function empacotarLembretes(linhas: PassoDeLembrete[]): LembretesEmpacotados {
  const vistos = new Set<number>();
  const limpos: PassoDeLembrete[] = [];
  for (const l of linhas) {
    const m = Number(l.minutes);
    if (!Number.isInteger(m) || m < LEMBRETE_MIN_MINUTOS || m > LEMBRETE_MAX_MINUTOS) continue;
    if (vistos.has(m)) continue;
    vistos.add(m);
    limpos.push({ minutes: m, body: (l.body ?? "").trim().slice(0, 1000), comLink: l.comLink !== false });
  }
  limpos.sort((a, b) => b.minutes - a.minutes);
  const primeiro = limpos[0] ?? { minutes: 1440, body: "" };
  const extras = limpos.slice(1);
  const corposExtras: Record<string, string> = {};
  for (const e of extras) {
    if (e.body) corposExtras[String(e.minutes)] = e.body;
  }
  return {
    principal: primeiro.minutes,
    extras: extras.map((e) => e.minutes),
    corpoPrincipal: primeiro.body,
    corposExtras,
    degrausSemLink: limpos.filter((l) => !l.comLink).map((l) => l.minutes),
  };
}

/**
 * Os degraus que saem SEM o link, lidos do banco (#5154).
 *
 * A coluna é `integer[] not null default '{}'`; o que não for inteiro na faixa
 * de lembrete é descartado, e o resultado é "todos levam" em vez de derrubar o
 * envio. Lista torta numa coluna de configuração não pode calar o WhatsApp de
 * ninguém — o modo de falha aqui é mandar o link a mais, nunca a menos.
 */
export function lerDegrausSemLink(bruto: unknown): number[] {
  if (!Array.isArray(bruto)) return [];
  const out = new Set<number>();
  for (const v of bruto) {
    if (typeof v !== "number" || !Number.isInteger(v)) continue;
    if (v < LEMBRETE_MIN_MINUTOS || v > LEMBRETE_MAX_MINUTOS) continue;
    out.add(v);
  }
  return [...out];
}

/**
 * A mensagem que cobre estes degraus leva o link?
 *
 * Uma mensagem só pode cobrir mais de um degrau (marcação em cima da hora: o
 * principal e um extra vencem juntos, `degrausPendentes` devolve os dois e o
 * cron manda UMA mensagem). A regra é a UNIÃO: se qualquer um deles pede o
 * link, a mensagem leva — senão o degrau que o operador deixou ligado perderia
 * o link só porque o texto veio do degrau vizinho. Só com todos desligados a
 * mensagem sai sem link.
 */
export function levaOLinkNoLembrete(
  tipo: { reminder_sem_link_offsets_minutes?: unknown },
  degraus: number[],
): boolean {
  const semLink = new Set(lerDegrausSemLink(tipo.reminder_sem_link_offsets_minutes));
  return degraus.some((d) => !semLink.has(d));
}

/** O que o banco devolve → a lista da tela. Sempre tem pelo menos o principal. */
export function desempacotarLembretes(tipo: {
  reminder_minutes_before: number;
  reminder_extra_offsets_minutes: number[] | null;
  reminder_body: string | null;
  reminder_bodies: unknown;
  /** #5154: degraus que saem sem o link. Ausente/ilegível = todos levam. */
  reminder_sem_link_offsets_minutes?: unknown;
}): PassoDeLembrete[] {
  const corpos = lerCorposDoLembrete(tipo.reminder_bodies);
  const semLink = new Set(lerDegrausSemLink(tipo.reminder_sem_link_offsets_minutes));
  const extras = (tipo.reminder_extra_offsets_minutes ?? []).filter(
    (m) => m !== tipo.reminder_minutes_before,
  );
  return [
    {
      minutes: tipo.reminder_minutes_before,
      body: (tipo.reminder_body ?? "").trim(),
      comLink: !semLink.has(tipo.reminder_minutes_before),
    },
    ...extras.map((m) => ({
      minutes: m,
      body: corpos[String(m)] ?? "",
      comLink: !semLink.has(m),
    })),
  ].sort((a, b) => b.minutes - a.minutes);
}

/**
 * O molde DESTE degrau.
 *
 * Extra com texto próprio vence. Principal cai em `reminder_body`. Sem texto,
 * quem chama usa o template da org ou a frase de fábrica — extra NÃO herda a
 * frase do principal, senão "mensagem por lembrete" vira um campo só de novo.
 */
export function moldeDoDegrau(
  tipo: {
    reminder_minutes_before: number;
    reminder_body: string | null;
    reminder_bodies: unknown;
  },
  degrau: number,
): string | null {
  const corpos = lerCorposDoLembrete(tipo.reminder_bodies);
  const proprio = corpos[String(degrau)];
  if (proprio) return proprio;
  if (degrau === tipo.reminder_minutes_before) {
    const p = tipo.reminder_body?.trim();
    return p ? p : null;
  }
  return null;
}

export type UnidadeDeAntecedencia = "minutos" | "horas" | "dias";

export function paraMinutos(quantidade: number, unidade: UnidadeDeAntecedencia): number {
  if (unidade === "dias") return quantidade * 1440;
  if (unidade === "horas") return quantidade * 60;
  return quantidade;
}

export function deMinutos(minutos: number): { quantidade: number; unidade: UnidadeDeAntecedencia } {
  if (minutos >= 1440 && minutos % 1440 === 0) return { quantidade: minutos / 1440, unidade: "dias" };
  if (minutos >= 60 && minutos % 60 === 0) return { quantidade: minutos / 60, unidade: "horas" };
  return { quantidade: minutos, unidade: "minutos" };
}

/** Primeiro horário ainda livre, para o botão "adicionar" não nascer duplicado. */
export function minutosLivres(usados: Iterable<number>): number {
  const set = new Set(usados);
  for (const c of [180, 60, 30, 1440, 120, 90, 15]) {
    if (!set.has(c)) return c;
  }
  for (let m = LEMBRETE_MIN_MINUTOS; m <= LEMBRETE_MAX_MINUTOS; m += 15) {
    if (!set.has(m)) return m;
  }
  return LEMBRETE_MIN_MINUTOS;
}

/**
 * JSON do campo escondido do formulário. Lixo vira lista vazia: a rota recusa
 * faixa e quantidade; daqui só não pode sair NaN.
 */
export function lerPassosDoFormulario(bruto: string | null): PassoDeLembrete[] {
  if (!bruto) return [];
  try {
    const v = JSON.parse(bruto) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const minutes = Number((item as { minutes?: unknown }).minutes);
      const body = String((item as { body?: unknown }).body ?? "");
      if (!Number.isFinite(minutes)) return [];
      return [{ minutes, body, comLink: (item as { comLink?: unknown }).comLink !== false }];
    });
  } catch {
    return [];
  }
}
