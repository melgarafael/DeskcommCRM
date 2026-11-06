/**
 * O TEXTO do aviso de agendamento no WhatsApp — puro, testável sem banco.
 *
 * ## Quem lê esta mensagem
 *
 * O dono da empresa, no celular, entre um atendimento e outro. Ele quer saber
 * em dois segundos se o horário que alguém marcou fora do CRM bate com um que
 * já está tomado. Por isso a mensagem é curta e sempre na mesma ordem: quem,
 * o quê, quando, com quem e de onde veio.
 *
 * ## O que NÃO entra
 *
 * - **O sobrenome do cliente.** Só o primeiro nome (`primeiroNome`, a mesma
 *   régua do aviso de caso): o celular do dono é lido por quem estiver perto, e
 *   o nome inteiro mais o horário já identificam a pessoa.
 * - **O endereço e o link da reunião.** O redact de LGPD apaga os dois do
 *   compromisso (0184); uma cópia numa conversa de WhatsApp ninguém apaga.
 * - **Nenhuma marca fixa.** O nome vem de `marcaDaSaida(orgId)`, já resolvido
 *   pelo chamador — `tests/unit/branding.test.ts` varre este arquivo.
 *
 * ## O horário é o da ORGANIZAÇÃO
 *
 * Não o do servidor (UTC numa VPS) nem o do compromisso: o dono pensa no
 * relógio da empresa, e é nele que ele compara com a agenda de papel.
 */
import { primeiroNome } from "@/lib/escalacao/texto-do-aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import type { EventoDoAvisoDeAgendamento } from "./vocabulario-do-aviso-de-agendamento";

/**
 * De onde veio o agendamento. É `created_by_kind` para quem nasce e o autor da
 * mudança para quem é remarcado ou cancelado; `google` é a mudança que chegou
 * pela sincronização do Google Agenda.
 */
export type OrigemDoAgendamento = "ai" | "user" | "google" | "contact" | "system";

const ROTULO_DA_ORIGEM: Record<OrigemDoAgendamento, string> = {
  ai: "IA",
  user: "Equipe",
  google: "Google Agenda",
  contact: "Cliente",
  system: "Sistema",
};

/** Lê o autor que vier no payload; valor desconhecido vira `system`, nunca some. */
export function origemDoAutor(autor: unknown): OrigemDoAgendamento {
  return typeof autor === "string" && autor in ROTULO_DA_ORIGEM
    ? (autor as OrigemDoAgendamento)
    : "system";
}

const TITULO_DO_EVENTO: Record<EventoDoAvisoDeAgendamento, string> = {
  "appointment.created": "novo agendamento",
  "appointment.rescheduled": "agendamento remarcado",
  "appointment.cancelled": "agendamento cancelado",
};

const ICONE_DO_EVENTO: Record<EventoDoAvisoDeAgendamento, string> = {
  "appointment.created": "📅",
  "appointment.rescheduled": "🔁",
  "appointment.cancelled": "❌",
};

function localeDoIdioma(idioma: Idioma): string {
  return idioma === "pt-BR" ? "pt-BR" : idioma;
}

/**
 * "ter., 21/10, 14:30" no fuso pedido. Fuso inválido cai para UTC em vez de
 * lançar: um aviso com o horário em UTC é ruim, um aviso que não sai é pior.
 */
export function diaEHora(instante: Date, fuso: string, idioma: Idioma): string {
  const opcoes: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  try {
    return new Intl.DateTimeFormat(localeDoIdioma(idioma), { ...opcoes, timeZone: fuso }).format(instante);
  } catch {
    return new Intl.DateTimeFormat(localeDoIdioma(idioma), { ...opcoes, timeZone: "UTC" }).format(instante);
  }
}

/** "14:30" no fuso pedido — a linha do resumo já está dentro do dia. */
export function soAHora(instante: Date, fuso: string, idioma: Idioma): string {
  const opcoes: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
  try {
    return new Intl.DateTimeFormat(localeDoIdioma(idioma), { ...opcoes, timeZone: fuso }).format(instante);
  } catch {
    return new Intl.DateTimeFormat(localeDoIdioma(idioma), { ...opcoes, timeZone: "UTC" }).format(instante);
  }
}

/** "ter., 21/10" — o cabeçalho do resumo. */
export function soODia(instante: Date, fuso: string, idioma: Idioma): string {
  const opcoes: Intl.DateTimeFormatOptions = { weekday: "short", day: "2-digit", month: "2-digit" };
  try {
    return new Intl.DateTimeFormat(localeDoIdioma(idioma), { ...opcoes, timeZone: fuso }).format(instante);
  } catch {
    return new Intl.DateTimeFormat(localeDoIdioma(idioma), { ...opcoes, timeZone: "UTC" }).format(instante);
  }
}

/** Texto curto vindo do banco: sem quebra de linha e com teto, para não virar parágrafo. */
function curto(v: string | null | undefined, teto = 60): string | null {
  if (typeof v !== "string") return null;
  const limpo = v.replace(/\s+/g, " ").trim();
  if (limpo === "") return null;
  return limpo.length > teto ? `${limpo.slice(0, teto - 1)}…` : limpo;
}

export interface AvisoDeAgendamento {
  /** O nome da marca já resolvido por `marcaDaSaida(orgId)`. */
  marca: string;
  /** O idioma da ORGANIZAÇÃO (`organizations.locale`), já normalizado. */
  idioma: Idioma;
  evento: EventoDoAvisoDeAgendamento;
  /** O nome inteiro do contato — o corte para o primeiro nome é feito aqui. */
  cliente: string | null;
  /** O nome do tipo de atendimento (`calendar_event_types.name`) ou o título. */
  servico: string | null;
  inicio: Date;
  /** `organizations.timezone`. */
  fuso: string;
  /** O nome de quem atende — o corte para o primeiro nome é feito aqui. */
  profissional: string | null;
  origem: OrigemDoAgendamento;
}

/** Monta a mensagem. Função total: nunca lança, nunca devolve vazio. */
export function montarAvisoDeAgendamento(aviso: AvisoDeAgendamento): string {
  const t = (texto: string): string => traduzir(texto, aviso.idioma);
  const linhas = [
    `${ICONE_DO_EVENTO[aviso.evento]} ${aviso.marca}: ${t(TITULO_DO_EVENTO[aviso.evento])}`,
    "",
  ];
  const cliente = primeiroNome(aviso.cliente);
  if (cliente) linhas.push(`${t("Cliente")}: ${cliente}`);
  const servico = curto(aviso.servico);
  if (servico) linhas.push(`${t("Serviço")}: ${servico}`);
  linhas.push(`${t("Quando")}: ${diaEHora(aviso.inicio, aviso.fuso, aviso.idioma)}`);
  const profissional = primeiroNome(aviso.profissional);
  if (profissional) linhas.push(`${t("Profissional")}: ${profissional}`);
  linhas.push(`${t("Origem")}: ${t(ROTULO_DA_ORIGEM[aviso.origem])}`);
  return linhas.join("\n");
}

export interface LinhaDoResumo {
  inicio: Date;
  cliente: string | null;
  servico: string | null;
  profissional: string | null;
}

export interface MudancaDaNoite {
  evento: EventoDoAvisoDeAgendamento;
  inicio: Date;
  cliente: string | null;
}

export interface ResumoDoDia {
  marca: string;
  idioma: Idioma;
  fuso: string;
  /** Qualquer instante do dia que o resumo descreve. */
  dia: Date;
  /** A agenda do dia. A ordem é feita aqui, não confiada ao chamador. */
  agenda: LinhaDoResumo[];
  /** O que foi marcado, remarcado ou cancelado entre 22h e 7h. */
  daNoite: MudancaDaNoite[];
}

/** O resumo das 7h. Função total: nunca lança, nunca devolve vazio. */
export function montarResumoDoDia(resumo: ResumoDoDia): string {
  const t = (texto: string): string => traduzir(texto, resumo.idioma);
  const linhas = [
    `☀️ ${resumo.marca}: ${t("agenda de hoje")} (${soODia(resumo.dia, resumo.fuso, resumo.idioma)})`,
    "",
  ];

  const agenda = [...resumo.agenda].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  if (agenda.length === 0) {
    linhas.push(t("Nenhum agendamento para hoje."));
  } else {
    for (const linha of agenda) {
      const partes = [soAHora(linha.inicio, resumo.fuso, resumo.idioma)];
      const cliente = primeiroNome(linha.cliente);
      if (cliente) partes.push(cliente);
      const servico = curto(linha.servico, 40);
      if (servico) partes.push(servico);
      const profissional = primeiroNome(linha.profissional);
      if (profissional) partes.push(`${t("com")} ${profissional}`);
      linhas.push(partes.join(" · "));
    }
  }
  linhas.push("", `${t("Total")}: ${agenda.length}`);

  if (resumo.daNoite.length > 0) {
    linhas.push("", t("Durante a noite (22h às 7h):"));
    const daNoite = [...resumo.daNoite].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
    for (const m of daNoite) {
      const partes = [t(TITULO_DO_EVENTO[m.evento]), diaEHora(m.inicio, resumo.fuso, resumo.idioma)];
      const cliente = primeiroNome(m.cliente);
      if (cliente) partes.push(cliente);
      linhas.push(`• ${partes.join(" · ")}`);
    }
  }
  return linhas.join("\n");
}

/** A mensagem do botão "Enviar teste". */
export function montarTesteDoAvisoDeAgendamento(entrada: { marca: string; idioma: Idioma }): string {
  const t = (texto: string): string => traduzir(texto, entrada.idioma);
  return [
    `📅 ${entrada.marca}: ${t("teste do aviso de agendamento")}`,
    "",
    t("Se esta mensagem chegou, os avisos de agendamento estão configurados e funcionando."),
    "",
    t(
      "Quando um horário for marcado, remarcado ou cancelado, chega aqui o primeiro nome do cliente, o serviço, o dia e a hora, quem atende e de onde veio. Às 7h chega o resumo do dia.",
    ),
  ].join("\n");
}
