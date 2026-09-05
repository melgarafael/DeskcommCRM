/**
 * A tradução de campos entre um agendamento nosso e um evento do Google.
 *
 * ─── Por que esta é a peça de maior risco da integração ───────────────────
 *
 * Sincronização não falha com barulho: ela falha escrevendo o horário errado.
 * Um campo lido com a régua errada não derruba nada — ele ocupa a agenda de uma
 * pessoa num horário em que ela está livre, ou libera um horário em que ela tem
 * consulta marcada. Ninguém abre chamado de "sync deu certo"; o defeito aparece
 * como cliente chegando na hora errada, semanas depois.
 *
 * Por isso a tradução é função pura, sem banco e sem rede: é a única parte da
 * integração que dá para provar inteira antes de existir token de verdade.
 *
 * ─── As duas direções NÃO são simétricas, e é de propósito ────────────────
 *
 * `paraEventoDoGoogle` LANÇA quando não consegue traduzir. A entrada é uma linha
 * nossa, cujas invariantes nós garantimos; violação ali é defeito de programa, e
 * mandar ao Google um evento pela metade é pior que não mandar — o compromisso
 * fica no calendário do cliente com hora errada e ninguém sabe.
 *
 * `doEventoDoGoogle` NUNCA lança: devolve leitura recusada com motivo nomeado.
 * A entrada é dado de terceiro, que chega malformado por motivos que não
 * controlamos, e um `throw` no meio de um lote de sincronização derrubaria os
 * eventos seguintes junto.
 *
 * ─── O que NÃO mandamos ao Google, e por quê ──────────────────────────────
 *
 * - `sequence`  — quem versiona o evento é o Google. Mandar um número menor que
 *   o que está lá devolve 400; mandar igual não faz nada. Nós LEMOS o `sequence`
 *   na volta (serve para reconhecer eco da nossa própria escrita) e nunca o
 *   escrevemos.
 * - `recurrence` — recorrência está fora do escopo (`03-DECISOES.md` §5). Nós
 *   lemos instância expandida; nunca criamos série.
 * - `conferenceData` / `conferenceDataVersion` / `sendUpdates` — não são corpo
 *   de evento, são parâmetros da requisição. Moram na chamada, não aqui.
 * - `guestsCanSeeOtherGuests` — o padrão do Google já é `true`. Mandar o padrão
 *   é payload sem decisão dentro.
 * - `reminders` — vai `useDefault: true` de propósito: esse é o alarme que o
 *   ATENDENTE já configurou no calendário dele, para ele mesmo. O lembrete do
 *   CLIENTE é outro caminho (`job_queue`, `03-DECISOES.md` §2) e vai por
 *   WhatsApp. Públicos diferentes — não é lembrete em dobro.
 */

import { instanteDaParede, primeiroInstanteDoDia } from "./tempo";

/**
 * O sufixo que marca um evento como nosso, gravado DENTRO do Google.
 *
 * É contrato de fio, não texto de interface: é por esta string que
 * reconhecemos, meses depois, quais eventos daquela agenda vieram do CRM — e é
 * o que impede o laço de eco (o Google avisa que algo mudou; se o evento é
 * nosso e nada mudou de fato, não reescrevemos).
 *
 * ⚠️ **Fixo do produto, NUNCA a marca resolvida.** Numa instalação de marca
 * própria, `branding()` devolve o nome do revendedor — e se o sufixo saísse
 * dali, todo evento criado antes da troca de marca deixaria de ser reconhecido.
 * O sintoma seria compromisso fantasma ocupando horário, sem erro nenhum.
 */
export const SUFIXO_ICAL_UID = "deskcomm.app";

/** Prefixo das `extendedProperties.private` que carregam a identidade do tenant. */
export const PREFIXO_PROPRIEDADE = "deskcomm";

/** Versão do formato das propriedades privadas — permite migrar sem adivinhar. */
const VERSAO_DA_PROPRIEDADE = "1";

// ─── O nosso lado ──────────────────────────────────────────────────────────

/** `calendar_appointments.status` (`01-ARQUITETURA.md` §2.2). */
export type StatusDoAgendamento = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";

/** `calendar_appointments.location_kind` (`01-ARQUITETURA.md` §4). */
export type TipoDeLocal = "in_person" | "phone" | "whatsapp" | "video_link" | "google_meet";

/**
 * Quem participa do compromisso, já resolvido pelo chamador.
 *
 * O agendamento guarda `owner_user_id` e `contact_id` — ids, não e-mails. Quem
 * traduz ids em endereços é a rota; esta camada recebe a lista pronta, e por
 * isso continua pura.
 *
 * **Lead sem e-mail é o caso comum, não a exceção:** contato que veio do
 * WhatsApp costuma ter só telefone. Ele simplesmente não entra na lista, e o
 * evento continua válido — quem avisa o cliente é a nossa própria cadeia de
 * envio, não o convite do Google.
 */
export interface ParticipanteDoAgendamento {
  email: string;
  nome?: string | null;
  /** O dono da agenda. Exatamente um participante deve marcar isto. */
  organizador?: boolean;
  /**
   * Este participante ainda NÃO confirmou nada aqui — o Google deve perguntar.
   *
   * O default (`false` ⇒ `responseStatus: "accepted"`) descreve o participante
   * que já confirmou do nosso lado, e é por isso que ele é o default: cobrar
   * RSVP de quem já disse sim no CRM seria pedir a mesma resposta duas vezes.
   *
   * O convidado DIGITADO À MÃO na tela é o caso oposto e por isso existe esta
   * chave: ele nunca falou com o CRM, não confirmou coisa nenhuma, e mandá-lo
   * como `accepted` produziria um convite que chega na caixa de entrada dele já
   * respondido em seu nome — sem os botões "Sim / Talvez / Não", que são o
   * motivo de se mandar convite do Google em vez de um e-mail comum.
   */
  aguardandoResposta?: boolean;
}

/** O subconjunto de `calendar_appointments` que o Google entende. */
export interface AgendamentoParaGoogle {
  id: string;
  organization_id: string;
  title: string;
  description?: string | null;
  /** ISO-8601. É instante, não hora de parede. */
  starts_at: string;
  ends_at: string;
  /** IANA — o fuso em que o compromisso foi marcado. */
  time_zone: string;
  status: StatusDoAgendamento;
  location_kind: TipoDeLocal;
  location_details?: string | null;
  meeting_url?: string | null;
  participantes?: ParticipanteDoAgendamento[];
  /** Quando já existe, é a identidade do evento lá — nunca se gera outra. */
  google_ical_uid?: string | null;
}

// ─── O lado do Google ──────────────────────────────────────────────────────

export interface InstanteDoGoogle {
  dateTime?: string | null;
  date?: string | null;
  timeZone?: string | null;
}

export interface ParticipanteDoGoogle {
  email?: string | null;
  displayName?: string | null;
  organizer?: boolean;
  responseStatus?: string | null;
  /** O Google marca com `self: true` o participante que é o dono da agenda lida. */
  self?: boolean;
}

/** O recurso `events` do Google, no recorte que lemos e escrevemos. */
export interface EventoDoGoogle {
  id?: string | null;
  status?: string | null;
  /** `default | outOfOffice | focusTime | workingLocation | birthday | fromGmail`. */
  eventType?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: InstanteDoGoogle | null;
  end?: InstanteDoGoogle | null;
  transparency?: string | null;
  iCalUID?: string | null;
  sequence?: number | null;
  recurrence?: string[] | null;
  recurringEventId?: string | null;
  updated?: string | null;
  attendees?: ParticipanteDoGoogle[] | null;
  reminders?: { useDefault?: boolean } | null;
  extendedProperties?: { private?: Record<string, string> | null } | null;
}

/** O corpo que mandamos no `events.insert` / `events.update`. */
export interface CorpoDeEventoDoGoogle {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  status: "confirmed" | "tentative" | "cancelled";
  transparency: "opaque";
  /**
   * ⚠️ NÃO EXISTE MAIS, e a ausência é o conserto.
   *
   * O `events.insert` recebia `id` E `iCalUID` juntos, e a referência do Google
   * diz que "only one of them should be supplied at event creation time".
   * Medido em produção em 2026-09-01, a cada 5 minutos, por horas:
   *
   *   HTTP 400 — {"reason":"invalid","message":"Invalid resource id value."}
   *
   * O `id` foi medido e é válido (43 caracteres, todos em [a-v0-9]); o que
   * violava contrato era a COPRESENÇA. `iCalUID` é do `events.import`, não do
   * insert.
   *
   * Sai dos DOIS verbos, não só do POST: depois disto o evento no Google nasce
   * com o uid que ELE gera, e um PUT tentando trocá-lo seria candidato ao mesmo
   * 400 por outro caminho.
   */
  reminders: { useDefault: true };
  attendees?: ParticipanteDoGoogle[];
  extendedProperties: { private: Record<string, string> };
}

// ─── IDA: nosso → Google ───────────────────────────────────────────────────

/**
 * O `status` do Google só tem três valores; o nosso tem cinco.
 *
 * `completed` e `no_show` viram `confirmed` porque descrevem o que aconteceu
 * DEPOIS do horário — o compromisso existiu e ocupou aquele espaço. Rebaixá-los
 * a `cancelled` reescreveria a história da agenda do atendente e liberaria, no
 * passado, um horário que esteve tomado.
 */
const STATUS_PARA_GOOGLE: Record<StatusDoAgendamento, "confirmed" | "tentative" | "cancelled"> = {
  pending: "tentative",
  confirmed: "confirmed",
  cancelled: "cancelled",
  completed: "confirmed",
  no_show: "confirmed",
};

/**
 * ⚠️ `icalUidDoAgendamento` e `ehIcalUidNosso` FORAM REMOVIDAS aqui.
 *
 * O uid ia no corpo do evento junto do `id`, e a referência do `events.insert`
 * proíbe os dois na criação. Medido em produção em 2026-09-01: HTTP 400,
 * `Invalid resource id value`, a cada 5 minutos, por horas — e NENHUM
 * compromisso jamais chegou ao Google, em instalação nenhuma.
 *
 * O reconhecimento anti-eco migrou para `ehEventoNosso` (`./escrita`), que olha
 * o PREFIXO DO ID — nosso por construção, preservado pelo Google, e já
 * disponível no mesmo ponto onde o filtro consultava o uid.
 *
 * Migrar não custou dado nenhum: não havia legado para reconhecer. E guardar as
 * duas "para um `events.import` futuro" seria manter função pura sem consumidor
 * — o cheiro que o cabeçalho de `escrita.ts` já nomeia como recurso pela metade.
 */

/**
 * O que escrever no campo `location`, que é o que a pessoa lê no calendário.
 *
 * `google_meet` não aparece aqui enquanto o link não existe: ele só nasce
 * DEPOIS do insert (o Google o cria), e a segunda passada que o grava é da
 * camada de chamada.
 */
function localDoEvento(a: AgendamentoParaGoogle): string | undefined {
  const detalhes = a.location_details?.trim() || "";
  switch (a.location_kind) {
    case "in_person":
      return detalhes || undefined;
    case "phone":
      return detalhes || undefined;
    case "whatsapp":
      return detalhes ? `WhatsApp — ${detalhes}` : "WhatsApp";
    case "video_link":
    case "google_meet":
      return a.meeting_url?.trim() || detalhes || undefined;
  }
}

function instanteValido(iso: string, campo: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`agendamento com ${campo} inválido: ${JSON.stringify(iso)}`);
  }
  return d;
}

/**
 * Traduz um agendamento nosso no corpo do evento do Google.
 *
 * Sempre escreve `dateTime` + `timeZone`, nunca `date`: um agendamento nosso
 * tem instante de início e de fim (colunas `timestamptz`), então dia inteiro não
 * é um estado que a nossa tabela consiga representar. Se um dia for, o lugar de
 * mudar é aqui — e o teste de dia inteiro da leitura já descreve o formato.
 *
 * Lança quando a linha não é traduzível. Ver o cabeçalho do arquivo.
 */
export function paraEventoDoGoogle(a: AgendamentoParaGoogle): CorpoDeEventoDoGoogle {
  const titulo = a.title?.trim();
  if (!titulo) throw new Error("agendamento sem título: o Google grava evento sem nome e ninguém entende a agenda");

  const inicio = instanteValido(a.starts_at, "starts_at");
  const fim = instanteValido(a.ends_at, "ends_at");
  if (fim.getTime() < inicio.getTime()) {
    throw new Error(`agendamento com fim antes do início: ${a.starts_at} → ${a.ends_at}`);
  }
  const fuso = a.time_zone?.trim();
  if (!fuso) throw new Error("agendamento sem time_zone: o evento ficaria com a hora certa e o fuso do servidor");

  const participantes = (a.participantes ?? []).map((p) => {
    const email = p.email?.trim();
    if (!email) {
      throw new Error("participante sem e-mail: o Google recusa o evento inteiro, não só o convidado");
    }
    // `responseStatus: "accepted"` é o DEFAULT, e continua sendo de propósito:
    // sem isso o Google trata o convite como pendente e passa a cobrar RSVP de
    // quem já confirmou aqui. Quem digitou um convidado à mão na tela não
    // confirmou nada — esse manda `aguardandoResposta` e recebe os botões de
    // RSVP. Quem silencia o e-mail do convite é `sendUpdates`, na chamada.
    const convidado: ParticipanteDoGoogle = {
      email,
      responseStatus: p.aguardandoResposta ? "needsAction" : "accepted",
    };
    if (p.nome?.trim()) convidado.displayName = p.nome.trim();
    if (p.organizador) convidado.organizer = true;
    return convidado;
  });

  const corpo: CorpoDeEventoDoGoogle = {
    summary: titulo,
    start: { dateTime: inicio.toISOString(), timeZone: fuso },
    end: { dateTime: fim.toISOString(), timeZone: fuso },
    status: STATUS_PARA_GOOGLE[a.status],
    // Compromisso nosso SEMPRE ocupa. Um agendamento que não ocupasse seria um
    // horário oferecido duas vezes.
    transparency: "opaque",
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        [`${PREFIXO_PROPRIEDADE}_org`]: a.organization_id,
        [`${PREFIXO_PROPRIEDADE}_appointment`]: a.id,
        [`${PREFIXO_PROPRIEDADE}_v`]: VERSAO_DA_PROPRIEDADE,
      },
    },
  };

  const descricao = a.description?.trim();
  if (descricao) corpo.description = descricao;
  const local = localDoEvento(a);
  if (local) corpo.location = local;
  if (participantes.length > 0) corpo.attendees = participantes;

  return corpo;
}

// ─── VOLTA: Google → nosso ─────────────────────────────────────────────────

/** Uma linha de `calendar_external_events` (`01-ARQUITETURA.md` §2.7). */
export interface EventoExternoLido {
  external_event_id: string;
  title: string | null;
  /** ISO-8601 UTC. */
  starts_at: string;
  ends_at: string;
  is_all_day: boolean;
  status: "confirmed" | "tentative";
  transparency: "opaque" | "transparent";
  external_updated_at: string | null;
  /** Só para reconhecer eco da nossa própria escrita — não é coluna. */
  ical_uid: string | null;
  sequence: number | null;
  /** Este evento tira horário da agenda? */
  ocupa: boolean;
}

export type MotivoDeRecusa =
  | "sem_id"
  | "sem_instante"
  | "instante_invalido"
  | "fuso_invalido"
  | "recorrencia_nao_expandida";

export type LeituraDeEvento =
  | { tipo: "evento"; evento: EventoExternoLido }
  /** Deixou de ocupar. A linha, se existir, sai da conta de horário. */
  | { tipo: "cancelado"; externalEventId: string }
  | { tipo: "recusado"; motivo: MotivoDeRecusa; detalhe: string };

function recusa(motivo: MotivoDeRecusa, detalhe: string): LeituraDeEvento {
  return { tipo: "recusado", motivo, detalhe };
}

/** `Z`, `+00:00` ou `-0300` no fim — a marca de que a string já é um instante. */
const COM_DESLOCAMENTO = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const SO_DATA_NO_CAMPO_ERRADO = /^\d{4}-\d{2}-\d{2}$/;
const DATA_E_HORA = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Lê o `dateTime` de um evento — e trata o caso em que ele NÃO traz deslocamento.
 *
 * ⚠️ Sem esta distinção o defeito é invisível e viaja com o contêiner:
 * `new Date("2026-09-02T14:00:00")` — sem `Z` e sem `-03:00` — é lido pela
 * especificação como hora LOCAL DO PROCESSO. O mesmo evento vira instantes
 * diferentes conforme o fuso da máquina onde a imagem roda, e a agenda de um
 * self-hoster em Manaus ocupa horário diferente da de um em São Paulo, com o
 * mesmo dado. Quando não há deslocamento, a string é hora de PAREDE, e o fuso
 * certo é o do próprio evento (`start.timeZone`) ou, na falta dele, o do
 * calendário.
 *
 * O campo `dateTime` trazendo só a data (`"2026-09-02"`) também cai aqui, e é
 * de propósito: é o mesmo bug de meia-noite UTC que `tempo.ts` existe para
 * impedir, entrando pelo campo errado.
 */
function instanteDoCampo(
  bruto: string,
  fusoDoEvento: string | null | undefined,
  fusoDoCalendario: string,
): Date | null {
  const texto = bruto.trim();
  if (!texto) return null;

  if (COM_DESLOCAMENTO.test(texto)) {
    const d = new Date(texto);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const fuso = fusoDoEvento?.trim() || fusoDoCalendario;
  if (SO_DATA_NO_CAMPO_ERRADO.test(texto)) return primeiroInstanteDoDia(texto, fuso);

  const m = DATA_E_HORA.exec(texto);
  if (!m) return null;
  const [, ano, mes, dia, hora, minuto, segundo] = m;
  if (!ano || !mes || !dia || !hora || !minuto) return null;
  return instanteDaParede(
    {
      ano: Number(ano),
      mes: Number(mes),
      dia: Number(dia),
      hora: Number(hora),
      minuto: Number(minuto),
      segundo: segundo ? Number(segundo) : 0,
    },
    fuso,
  );
}

/**
 * O dono desta agenda RECUSOU o convite?
 *
 * Compromisso que a pessoa recusou não é compromisso dela — deixar ocupando
 * some com horário livre por causa de convite que ela nem aceitou, e é o tipo
 * de sumiço que ninguém liga ao Google.
 */
function donoRecusou(evento: EventoDoGoogle): boolean {
  return (evento.attendees ?? []).some(
    (p) => p?.self === true && (p.responseStatus ?? "").trim().toLowerCase() === "declined",
  );
}

/**
 * Lê um evento do Google como ocupação de agenda.
 *
 * `fusoDoCalendario` é o fuso da agenda conectada (`calendarList.timeZone`), e
 * só é usado por evento de dia inteiro — que é o único que chega sem fuso
 * nenhum. Ver `tempo.ts`.
 */
export function doEventoDoGoogle(
  evento: EventoDoGoogle,
  opcoes: { fusoDoCalendario: string },
): LeituraDeEvento {
  const id = evento.id?.trim();
  if (!id) return recusa("sem_id", "evento sem `id`: não há como casar com a linha guardada");

  // Cancelado vem primeiro, e antes de qualquer exigência de horário: na
  // sincronização incremental o Google anuncia exclusão como uma lápide
  // `{ id, status: "cancelled" }`, SEM start nem end. Recusar por "sem
  // instante" deixaria o evento apagado ocupando horário para sempre — que é
  // exatamente o fantasma que a pesquisa mediu no cal.com.
  const statusBruto = (evento.status ?? "").trim().toLowerCase();
  if (statusBruto === "cancelled") return { tipo: "cancelado", externalEventId: id };

  // Série não expandida: o evento-mestre traz `recurrence` e descreve só a
  // PRIMEIRA ocorrência. Guardá-lo como ocupação isolada esconderia todas as
  // outras — a agenda diria "livre" em cima de compromisso semanal. A leitura
  // certa é `singleEvents: true` na listagem; aqui a única saída honesta é
  // recusar, com nome.
  const ehMestreDeSerie = (evento.recurrence?.length ?? 0) > 0 && !evento.recurringEventId;
  if (ehMestreDeSerie) {
    return recusa(
      "recorrencia_nao_expandida",
      "evento-mestre de série: liste com `singleEvents: true` para receber as instâncias",
    );
  }

  const inicio = evento.start;
  const fim = evento.end;
  if (!inicio || !fim) return recusa("sem_instante", "evento sem `start` ou sem `end`");

  // A narrowing sai da própria leitura: guardar a data numa constante evita o
  // `as string` que um booleano solto obrigaria — e cast é onde erro de tipo se
  // esconde.
  const dataDeDiaInteiro = typeof inicio.date === "string" && !inicio.dateTime ? inicio.date : null;
  const diaInteiro = dataDeDiaInteiro !== null;
  let inicioEm: Date | null;
  let fimEm: Date | null;

  if (dataDeDiaInteiro !== null) {
    if (typeof fim.date !== "string") {
      return recusa("instante_invalido", "evento de dia inteiro com `start.date` e sem `end.date`");
    }
    inicioEm = primeiroInstanteDoDia(dataDeDiaInteiro, opcoes.fusoDoCalendario);
    // `end.date` do Google é EXCLUSIVO: um evento no dia 2 vem com
    // `end.date = "2026-09-03"`. Converter os dois pelo mesmo caminho já dá o
    // fim correto — não subtraia um dia "para corrigir".
    fimEm = primeiroInstanteDoDia(fim.date, opcoes.fusoDoCalendario);
    if (!inicioEm || !fimEm) {
      // Distingue as duas causas: fuso que este runtime não conhece é problema
      // de configuração da conexão; data malformada é problema do evento.
      const fusoRuim = primeiroInstanteDoDia("2000-01-01", opcoes.fusoDoCalendario) === null;
      return fusoRuim
        ? recusa("fuso_invalido", `fuso do calendário desconhecido: ${JSON.stringify(opcoes.fusoDoCalendario)}`)
        : recusa("instante_invalido", `data de dia inteiro ilegível: ${dataDeDiaInteiro} → ${fim.date}`);
    }
  } else {
    if (!inicio.dateTime || !fim.dateTime) {
      return recusa("sem_instante", "evento sem `dateTime` em `start` ou em `end`");
    }
    inicioEm = instanteDoCampo(inicio.dateTime, inicio.timeZone, opcoes.fusoDoCalendario);
    fimEm = instanteDoCampo(fim.dateTime, fim.timeZone, opcoes.fusoDoCalendario);
    if (!inicioEm || !fimEm) {
      const fusoRuim = primeiroInstanteDoDia("2000-01-01", opcoes.fusoDoCalendario) === null;
      return fusoRuim
        ? recusa("fuso_invalido", `fuso do calendário desconhecido: ${JSON.stringify(opcoes.fusoDoCalendario)}`)
        : recusa("instante_invalido", `dateTime ilegível: ${inicio.dateTime} → ${fim.dateTime}`);
    }
  }

  if (fimEm.getTime() < inicioEm.getTime()) {
    return recusa("instante_invalido", `fim antes do início: ${inicioEm.toISOString()} → ${fimEm.toISOString()}`);
  }

  // `transparent` é o "Disponível" da tela do Google: o evento existe na agenda
  // e NÃO tira horário. Ausente ou qualquer outro valor conta como `opaque` —
  // errar para "ocupa" esconde um horário livre, errar para "livre" marca em
  // cima de compromisso real. Só um dos dois erros desmarca cliente.
  // Comparação em minúsculas de propósito: o irmão ao lado (`cancelled`) já
  // normaliza, e um `CANCELLED` de um cliente de terceiro virando "confirmado"
  // seria compromisso fantasma criado por diferença de caixa.
  const transparencyBruta = (evento.transparency ?? "").trim().toLowerCase();
  const transparency = transparencyBruta === "transparent" ? "transparent" : "opaque";
  // `cancelled` já saiu acima; sobra `tentative` e `confirmed`. Valor
  // desconhecido cai em `confirmed` pela mesma razão.
  const status = statusBruto === "tentative" ? "tentative" : "confirmed";

  // `workingLocation` é MARCADOR, não compromisso: o Google o usa para dizer
  // "hoje estou no escritório". Ele cobre o dia inteiro, então contá-lo como
  // ocupação apagaria a agenda de quem apenas marcou onde trabalha.
  const ehMarcadorDeLocal = (evento.eventType ?? "").trim().toLowerCase() === "workinglocation";
  const ocupa = transparency === "opaque" && !ehMarcadorDeLocal && !donoRecusou(evento);

  const atualizadoEm = evento.updated ? new Date(evento.updated) : null;

  return {
    tipo: "evento",
    evento: {
      external_event_id: id,
      title: evento.summary?.trim() || null,
      starts_at: inicioEm.toISOString(),
      ends_at: fimEm.toISOString(),
      is_all_day: diaInteiro,
      status,
      transparency,
      external_updated_at:
        atualizadoEm && !Number.isNaN(atualizadoEm.getTime()) ? atualizadoEm.toISOString() : null,
      ical_uid: evento.iCalUID?.trim() || null,
      sequence: typeof evento.sequence === "number" ? evento.sequence : null,
      ocupa,
    },
  };
}
