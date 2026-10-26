/**
 * A REGRA da mensagem agendada — pura, sem banco e sem HTTP.
 *
 * Toda superfície (a rota REST, as ferramentas MCP e o handler do worker) lê a
 * MESMA régua daqui. Foi uma lista escrita à mão por superfície que separou as
 * três no #3434: cada uma aprendeu um limite novo e as outras ficaram para trás.
 * Aqui, limite de corpo, teto de partes, janela do agendamento, quem pode
 * cancelar e o que cada estado significa existem UMA vez.
 *
 * ─── Vocabulário ───────────────────────────────────────────────────────────
 *
 *   pacote  → a linha de `scheduled_messages`: o que sai junto, na hora marcada
 *   parte   → a linha de `scheduled_message_parts`: um balão (texto e/ou anexo)
 *
 * O pacote e as partes em duas tabelas, e não uma mensagem em `messages` com
 * status 'scheduled': cabe uma parte por linha, e aí `partial`, a parada no meio
 * e o "reenviar o que faltou" viram arqueologia de linha.
 */

/** Os estados do pacote. O espelho do CHECK de `scheduled_messages.status`. */
export const STATUS_DO_PACOTE = [
  "scheduled",
  "sending",
  "sent",
  "partial",
  "failed",
  "cancelled",
] as const;
export type StatusDoPacote = (typeof STATUS_DO_PACOTE)[number];

/** Os estados de uma parte. Espelho do CHECK de `scheduled_message_parts.status`. */
export const STATUS_DA_PARTE = ["pending", "sent", "failed", "skipped"] as const;
export type StatusDaParte = (typeof STATUS_DA_PARTE)[number];

/** Mesmo teto de `lib/schemas/messaging.ts`: o limite é do canal, não da tela. */
export const TETO_DO_CORPO = 4096;

/**
 * Teto de partes por pacote. Dez balões seguidos já é o limite do bom senso no
 * WhatsApp; acima disso o operador está montando campanha, e campanha tem outra
 * porta (com ritmo e teto diário).
 */
export const MAXIMO_DE_PARTES = 10;

/**
 * Intervalo entre partes. Curto de propósito: são balões do MESMO pacote, e o
 * cliente lê na ordem em que chegam. Também é o que evita rajada no canal.
 */
export const INTERVALO_ENTRE_PARTES_MS = 3_000;

/**
 * Piso do agendamento — 30 s. Não é capricho: agendar para "agora" pela tela é
 * o Enviar com um passo extra, e um pacote que nasce vencido dispara no tick
 * seguinte sem ninguém ter tempo de conferir. O teto de um ano é o mesmo da
 * janela do retorno (`lib/followup/janela.ts`): além disso, o agendamento é
 * promessa, não lembrete.
 */
export const PISO_DO_AGENDAMENTO_MS = 30_000;
export const TETO_DO_AGENDAMENTO_MS = 365 * 24 * 3_600_000;

/** Quantas vezes o worker reagenda um pacote antes de chamar de falha. */
export const MAXIMO_DE_TENTATIVAS = 5;

/** Backoff do reagendamento (sessão fora de `WORKING`, janela fechada). */
export const BACKOFF_BASE_MS = 60_000;

export interface ParteDoAgendamento {
  /** Texto do balão. Obrigatório quando não há anexo. */
  body?: string | null;
  /** Caminho já subido ao bucket `whatsapp-media`. */
  media_storage_path?: string | null;
  media_mime?: string | null;
  media_size_bytes?: number | null;
}

export interface AgendamentoDeMensagem {
  /** A conversa. Sem ela, o contato precisa ter UMA conversa aberta e só. */
  conversation_id?: string | null;
  contact_id?: string | null;
  /** Instante absoluto, ISO 8601. */
  scheduled_for: string;
  /** Fuso IANA usado na tela, só para exibir. */
  tz?: string | null;
  parts: ParteDoAgendamento[];
  cancel_if_contact_replies?: boolean;
}

export type MotivoDeRecusa =
  | "sem_conversa"
  | "sem_partes"
  | "partes_demais"
  | "parte_vazia"
  | "corpo_longo_demais"
  | "instante_invalido"
  | "instante_no_passado"
  | "instante_longe_demais"
  | "fuso_invalido";

export interface RecusaDoAgendamento {
  ok: false;
  codigo: MotivoDeRecusa;
  mensagem: string;
}

export interface AgendamentoValidado {
  ok: true;
  quando: Date;
  /** `null` = o adaptador resolve a conversa do contato. */
  conversaId: string | null;
  contatoId: string | null;
  tz: string;
  cancelarSeResponder: boolean;
  partes: Array<{
    position: number;
    body: string | null;
    media_storage_path: string | null;
    media_mime: string | null;
    media_size_bytes: number | null;
  }>;
}

/** Fuso IANA de verdade — `Intl` é quem sabe, e não uma lista nossa. */
export function fusoValido(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida e normaliza o pedido de agendamento.
 *
 * Devolve o pedido pronto para gravar — partes com `position` já numerada a
 * partir de 0 e texto aparado — ou a recusa com o motivo curto e a frase que a
 * tela (e o modelo, no MCP) pode mostrar.
 */
export function validaAgendamento(
  input: AgendamentoDeMensagem,
  agora: Date = new Date(),
): AgendamentoValidado | RecusaDoAgendamento {
  const conversa = input.conversation_id ?? null;
  const contato = input.contact_id ?? null;
  if (conversa === null && contato === null) {
    return {
      ok: false,
      codigo: "sem_conversa",
      mensagem: "informe conversation_id ou contact_id: a mensagem sai numa conversa.",
    };
  }

  const quando = new Date(input.scheduled_for);
  if (Number.isNaN(quando.getTime())) {
    return {
      ok: false,
      codigo: "instante_invalido",
      mensagem: `scheduled_for precisa ser um instante ISO 8601 (ex.: '${agora.toISOString()}').`,
    };
  }
  const distancia = quando.getTime() - agora.getTime();
  if (distancia < PISO_DO_AGENDAMENTO_MS) {
    return {
      ok: false,
      codigo: "instante_no_passado",
      mensagem: "scheduled_for tem de estar pelo menos 30 s à frente de agora.",
    };
  }
  if (distancia > TETO_DO_AGENDAMENTO_MS) {
    return {
      ok: false,
      codigo: "instante_longe_demais",
      mensagem: "scheduled_for está a mais de um ano de agora.",
    };
  }

  const tz = (input.tz ?? "UTC").trim() || "UTC";
  if (!fusoValido(tz)) {
    return { ok: false, codigo: "fuso_invalido", mensagem: `fuso desconhecido: ${tz}.` };
  }

  const brutas = Array.isArray(input.parts) ? input.parts : [];
  if (brutas.length === 0) {
    return { ok: false, codigo: "sem_partes", mensagem: "o agendamento precisa de ao menos uma parte." };
  }
  if (brutas.length > MAXIMO_DE_PARTES) {
    return {
      ok: false,
      codigo: "partes_demais",
      mensagem: `no máximo ${MAXIMO_DE_PARTES} partes por agendamento.`,
    };
  }

  const partes: AgendamentoValidado["partes"] = [];
  for (const [indice, parte] of brutas.entries()) {
    const body = typeof parte.body === "string" ? parte.body.trim() : "";
    const caminho =
      typeof parte.media_storage_path === "string" && parte.media_storage_path.trim() !== ""
        ? parte.media_storage_path.trim()
        : null;
    if (body === "" && caminho === null) {
      return {
        ok: false,
        codigo: "parte_vazia",
        mensagem: `a parte ${indice + 1} não tem texto nem anexo.`,
      };
    }
    if (body.length > TETO_DO_CORPO) {
      return {
        ok: false,
        codigo: "corpo_longo_demais",
        mensagem: `a parte ${indice + 1} passa de ${TETO_DO_CORPO} caracteres.`,
      };
    }
    partes.push({
      position: indice,
      body: body === "" ? null : body,
      media_storage_path: caminho,
      media_mime: caminho === null ? null : (parte.media_mime?.trim() ?? null),
      media_size_bytes:
        caminho === null || parte.media_size_bytes === undefined || parte.media_size_bytes === null
          ? null
          : parte.media_size_bytes,
    });
  }

  return {
    ok: true,
    quando,
    conversaId: conversa,
    contatoId: contato,
    tz,
    cancelarSeResponder: input.cancel_if_contact_replies === true,
    partes,
  };
}

/**
 * Quem pode ser CANCELADO. Uma função só, lida pela rota, pelo MCP e pela tela:
 * enquanto o pacote não começou a sair, desmarcar é seguro; depois, o que já
 * saiu não volta atrás e o estado é histórico, não botão.
 */
export function podeCancelar(status: StatusDoPacote): boolean {
  return status === "scheduled";
}

/** Quem pode ser EDITADO. Mesma régua do cancelamento, e pelo mesmo motivo. */
export function podeEditar(status: StatusDoPacote): boolean {
  return status === "scheduled";
}

/**
 * O desfecho de um pacote a partir das partes — a regra que decide entre `sent`,
 * `partial` e `failed`, e a mesma que o handler usa no fim do laço.
 */
export function desfechoDasPartes(
  partes: ReadonlyArray<{ status: StatusDaParte }>,
): "sent" | "partial" | "failed" {
  if (partes.length === 0) return "failed";
  const enviadas = partes.filter((p) => p.status === "sent").length;
  if (enviadas === partes.length) return "sent";
  if (enviadas === 0) return "failed";
  return "partial";
}

/**
 * O que fazer quando chega a hora do disparo.
 *
 * As travas são as mesmas que o envio já respeita (`sendMessageHandler` recusa
 * organização parada, contato bloqueado, canal arquivado); a diferença é que
 * aqui a resposta precisa virar ESTADO do pacote, com motivo, em vez de erro
 * devolvido a quem chamou. A ordem importa: cancelar (não faz mais sentido
 * mandar) vem antes de falhar (não deu para mandar), e reagendar vem por último
 * porque é o único desfecho que mantém a promessa viva.
 */
export interface FatosDoDisparo {
  organizacaoOperante: boolean;
  contatoBloqueado: boolean;
  contatoAnonimizado: boolean;
  canalArquivado: boolean;
  /** `channel_sessions.status === 'WORKING'`. */
  sessaoEmDia: boolean;
  /** Houve mensagem de ENTRADA do contato depois do agendamento. */
  contatoRespondeu: boolean;
  /** Fora da janela do número: quando ela reabre, ou `null` se está aberta. */
  janelaReabreEm: Date | null;
}

export type VereditoDoDisparo =
  | { acao: "enviar" }
  | { acao: "cancelar"; motivo: string }
  | { acao: "falhar"; motivo: string }
  | { acao: "reagendar"; motivo: string; para: Date };

export function vereditoDoDisparo(
  fatos: FatosDoDisparo,
  pacote: { cancelarSeResponder: boolean },
  agora: Date,
): VereditoDoDisparo {
  if (!fatos.organizacaoOperante) {
    return { acao: "falhar", motivo: "org_nao_operante" };
  }
  if (fatos.contatoAnonimizado) {
    return { acao: "cancelar", motivo: "Contato anonimizado (LGPD)" };
  }
  if (fatos.contatoBloqueado) {
    return { acao: "cancelar", motivo: "Contato pediu para parar (opt-out)" };
  }
  if (pacote.cancelarSeResponder && fatos.contatoRespondeu) {
    return { acao: "cancelar", motivo: "contato_respondeu" };
  }
  if (fatos.canalArquivado) {
    return { acao: "falhar", motivo: "canal_arquivado" };
  }
  if (fatos.janelaReabreEm !== null && fatos.janelaReabreEm.getTime() > agora.getTime()) {
    return {
      acao: "reagendar",
      motivo: "fora_da_janela",
      para: fatos.janelaReabreEm,
    };
  }
  if (!fatos.sessaoEmDia) {
    // Sessão fora de `WORKING` não é falha: o número pode voltar. Deixar o
    // pacote em `queued` não serve — não há dono para esse estado no envio
    // manual; por isso o pacote volta para `scheduled` com hora nova.
    return {
      acao: "reagendar",
      motivo: "sessao_fora_de_working",
      para: new Date(agora.getTime() + BACKOFF_BASE_MS),
    };
  }
  return { acao: "enviar" };
}

/** Backoff do reagendamento: 1, 2, 4, 8, 16 min — teto de 30 min. */
export function esperaDaTentativa(tentativas: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, tentativas - 1), 30 * 60_000);
}

/** Frase curta para o motivo guardado no pacote — a tela e o MCP mostram isto. */
export function motivoLegivel(motivo: string): string {
  switch (motivo) {
    case "org_nao_operante":
      return "A organização está parada (suspensa, redigida ou arquivada).";
    case "canal_arquivado":
      return "O canal desta conversa foi arquivado.";
    case "contato_respondeu":
      return "O contato respondeu antes da hora marcada.";
    case "fora_da_janela":
      return "Fora da janela de envio do número — o pacote saiu na abertura.";
    case "sessao_fora_de_working":
      return "O número não está conectado neste momento; o envio foi reagendado.";
    case "canal_nao_confirmou":
      return "O canal não confirmou o envio.";
    case "parte_falhou":
      return "Uma das partes não saiu; as seguintes não foram enviadas.";
    case "tentativas_esgotadas":
      return "O número não voltou a conectar e as tentativas se esgotaram.";
    default:
      return motivo;
  }
}
