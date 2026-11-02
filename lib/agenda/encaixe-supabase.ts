/**
 * A PORTA DO ENCAIXE CONTRA O SUPABASE — e os três ganchos que o produto chama.
 *
 * A escrita aqui é fina de propósito: nenhuma decisão mora neste arquivo. Quem
 * decide é `lista-de-espera.ts` (cabe ou não cabe) e `encaixe.ts` (a ordem dos
 * passos). O que existe aqui é a tradução de linha para objeto e o único ponto
 * do produto que sabe que a fila se chama `calendar_waitlist`.
 *
 * ─── As duas escritas canônicas são reaproveitadas, não reinventadas ───────
 *
 * Confirmar e soltar passam por `fn_appointment_change` — a MESMA função que a
 * rota e as ferramentas do agente chamam. Ela confere revisão, recusa linha já
 * cancelada e emite o laço de automação. Um `update` cru aqui deixaria a
 * revisão parada (a tela do atendente continuaria achando que tem a versão
 * atual) e calaria `appointment.confirmed` / `appointment.cancelled`, que é como
 * as automações e os webhooks do cliente ficam sabendo.
 *
 * A ÚNICA escrita nova é o INSERT da vaga segurada (a tabela é a mesma, os
 * gatilhos são os mesmos, e o índice único parcial
 * `calendar_appointments_sem_duplicata_idx` é quem garante "um dono por
 * instante"). O que se pula é a validação de disponibilidade — e de propósito: o
 * horário acabou de VAGAR, era de um compromisso daquele profissional e o
 * instante está protegido pelo índice. Revalidar jornada aqui custaria duas
 * consultas por encaixe para responder uma pergunta que o banco já responde no
 * INSERT.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ScheduleWindow } from "@/lib/schemas/routing";
import { logger } from "@/lib/logger";

import type { InscricaoNaEspera, ServicoDaEspera } from "./lista-de-espera";
import {
  oferecerVagaQueAbriu,
  recusarEncaixe,
  vencerOfertas,
  type OfertaCorrente,
  type PortaDoEncaixe,
  type ResultadoDaOferta,
  type SeguroDaVaga,
} from "./encaixe";

type SB = SupabaseClient;

/** Teto da fila lida por vaga. Uma clínica não tem mil pedidos de encaixe. */
const TETO_DA_FILA = 200;

/** Teto por rodada de cron. O que sobrar volta na rodada seguinte. */
const TETO_DA_VARREDURA = 500;

function dataOuNulo(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `janelas` é jsonb: o que não for janela de verdade é DESCARTADO, e não vira
 * `undefined` no meio do objeto. Inscrição com lixo na coluna fica com lista
 * vazia — que, nesta régua, é "qualquer horário". O lado oposto (descartar a
 * inscrição inteira) puniria a pessoa por um dado que ela não digitou.
 */
function lerJanelas(bruto: unknown): ScheduleWindow[] {
  if (!Array.isArray(bruto)) return [];
  const janelas: ScheduleWindow[] = [];
  for (const item of bruto) {
    if (!item || typeof item !== "object") continue;
    const j = item as Record<string, unknown>;
    const dow = Number(j.dow);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (typeof j.start !== "string" || typeof j.end !== "string") continue;
    janelas.push({ dow, start: j.start, end: j.end });
  }
  return janelas;
}

/** Traduz a linha da fila para o vocabulário da decisão. */
function lerInscricao(linha: Record<string, unknown>): InscricaoNaEspera | null {
  const id = typeof linha.id === "string" ? linha.id : null;
  const contactId = typeof linha.contact_id === "string" ? linha.contact_id : null;
  const eventTypeId = typeof linha.event_type_id === "string" ? linha.event_type_id : null;
  const createdAt = dataOuNulo(linha.created_at);
  if (!id || !contactId || !eventTypeId || !createdAt) return null;
  return {
    id,
    contactId,
    eventTypeId,
    ownerUserId: typeof linha.owner_user_id === "string" ? linha.owner_user_id : null,
    janelas: lerJanelas(linha.janelas),
    antecedenciaMinimaHoras: Number(linha.antecedencia_minima_horas ?? 0),
    validoAte: dataOuNulo(linha.valido_ate),
    urgencia: Number(linha.urgencia ?? 0),
    createdAt,
  };
}

const COLUNAS_DA_INSCRICAO =
  "id, contact_id, event_type_id, owner_user_id, janelas, antecedencia_minima_horas, valido_ate, urgencia, created_at";

/** A porta de verdade. `agora` NÃO é lido aqui: quem chama decide o instante. */
export function portaSupabase(supabase: SB): PortaDoEncaixe {
  async function revisaoAtual(organizationId: string, id: string, status: string) {
    const { data, error } = await supabase
      .from("calendar_appointments")
      .select("revision, status")
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const linha = data as { revision?: unknown; status?: unknown } | null;
    if (!linha) return null;
    if (String(linha.status) !== status) return null;
    return Number(linha.revision);
  }

  return {
    async vaga(organizationId, appointmentId) {
      const { data, error } = await supabase
        .from("calendar_appointments")
        .select("id, starts_at, ends_at, owner_user_id, time_zone, status")
        .eq("organization_id", organizationId)
        .eq("id", appointmentId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const linha = data as Record<string, unknown> | null;
      if (!linha) return null;
      // Só compromisso DESMARCADO abre vaga. `completed` e `no_show` já
      // passaram, e `pending`/`confirmed` ainda ocupam o horário.
      if (String(linha.status) !== "cancelled") return null;
      const startsAt = dataOuNulo(linha.starts_at);
      const endsAt = dataOuNulo(linha.ends_at);
      if (!startsAt || !endsAt || !linha.id) return null;
      return {
        appointmentId: String(linha.id),
        startsAt,
        endsAt,
        ownerUserId: typeof linha.owner_user_id === "string" ? linha.owner_user_id : null,
        timeZone: typeof linha.time_zone === "string" ? linha.time_zone : "America/Sao_Paulo",
      };
    },

    async fila(organizationId) {
      const { data, error } = await supabase
        .from("calendar_waitlist")
        .select(COLUNAS_DA_INSCRICAO)
        .eq("organization_id", organizationId)
        .eq("status", "waiting")
        .order("urgencia", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(TETO_DA_FILA);
      if (error) throw new Error(error.message);
      const fila: InscricaoNaEspera[] = [];
      for (const linha of (data ?? []) as Record<string, unknown>[]) {
        const inscricao = lerInscricao(linha);
        if (inscricao) fila.push(inscricao);
      }
      return fila;
    },

    async servico(organizationId, eventTypeId) {
      const { data, error } = await supabase
        .from("calendar_event_types")
        .select("id, name, duration_minutes, minimum_notice_minutes, is_active")
        .eq("organization_id", organizationId)
        .eq("id", eventTypeId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const linha = data as Record<string, unknown> | null;
      // Tipo desativado não está sendo agendado: oferecer encaixe nele seria
      // vender um atendimento que a clínica parou de fazer.
      if (!linha || linha.is_active === false) return null;
      const servico: ServicoDaEspera = {
        eventTypeId: String(linha.id),
        nome: String(linha.name ?? "atendimento"),
        duracaoMinutos: Number(linha.duration_minutes ?? 30),
        avisoMinimoMinutos: Number(linha.minimum_notice_minutes ?? 0),
      };
      return servico;
    },

    async segurar(entrada: SeguroDaVaga) {
      const { data, error } = await supabase
        .from("calendar_appointments")
        .insert({
          organization_id: entrada.organizationId,
          event_type_id: entrada.servico.eventTypeId,
          contact_id: entrada.contatoId,
          owner_user_id: entrada.ownerUserId,
          title: `${entrada.servico.nome} — encaixe da lista de espera`,
          starts_at: entrada.inicio.toISOString(),
          ends_at: entrada.fim.toISOString(),
          time_zone: entrada.fuso,
          status: "pending",
          // `system` e `waitlist`: a linha nasceu do produto, não de uma pessoa
          // clicando nem do Google. A coluna é a autoria que a timeline lê.
          created_by_kind: "system",
          source: "waitlist",
          notes:
            "Vaga segurada para a lista de espera. Confirme a resposta da pessoa " +
            "para virar compromisso confirmado, ou desmarque para chamar o próximo.",
        })
        .select("id")
        .maybeSingle();
      if (error) {
        // 23505 = o instante já tem dono (índice único parcial). Perder essa
        // corrida é um desfecho normal: outra desmarcação abriu a mesma vaga.
        if (error.code === "23505") return null;
        throw new Error(error.message);
      }
      const linha = data as { id?: unknown } | null;
      return linha?.id ? String(linha.id) : null;
    },

    async marcarOfertada({ esperaId, compromissoId, expiraEm }) {
      const { data, error } = await supabase
        .from("calendar_waitlist")
        .update({
          status: "offered",
          oferta_appointment_id: compromissoId,
          oferta_expira_em: expiraEm.toISOString(),
          ofertada_em: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", esperaId)
        .eq("status", "waiting")
        .select("id");
      if (error) throw new Error(error.message);
      return ((data ?? []) as unknown[]).length > 0;
    },

    async oferta(organizationId, esperaId) {
      const { data, error } = await supabase
        .from("calendar_waitlist")
        .select("id, contact_id, status, oferta_appointment_id, oferta_expira_em")
        .eq("organization_id", organizationId)
        .eq("id", esperaId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const linha = data as Record<string, unknown> | null;
      if (!linha || String(linha.status) !== "offered") return null;
      const compromissoId =
        typeof linha.oferta_appointment_id === "string" ? linha.oferta_appointment_id : null;
      const expiraEm = dataOuNulo(linha.oferta_expira_em);
      const contatoId = typeof linha.contact_id === "string" ? linha.contact_id : null;
      if (!compromissoId || !expiraEm || !contatoId) return null;
      return ofertaComCompromisso(supabase, organizationId, {
        esperaId: String(linha.id),
        contatoId,
        compromissoId,
        expiraEm,
      });
    },

    async ofertasVencidas(organizationId, agora) {
      const { data, error } = await supabase
        .from("calendar_waitlist")
        .select("id, contact_id, oferta_appointment_id, oferta_expira_em")
        .eq("organization_id", organizationId)
        .eq("status", "offered")
        .lte("oferta_expira_em", agora.toISOString())
        .order("oferta_expira_em", { ascending: true })
        .limit(TETO_DA_FILA);
      if (error) throw new Error(error.message);
      const vencidas: OfertaCorrente[] = [];
      for (const linha of (data ?? []) as Record<string, unknown>[]) {
        const compromissoId =
          typeof linha.oferta_appointment_id === "string" ? linha.oferta_appointment_id : null;
        const contatoId = typeof linha.contact_id === "string" ? linha.contact_id : null;
        const expiraEm = dataOuNulo(linha.oferta_expira_em);
        if (!compromissoId || !contatoId || !expiraEm) continue;
        const oferta = await ofertaComCompromisso(supabase, organizationId, {
          esperaId: String(linha.id),
          contatoId,
          compromissoId,
          expiraEm,
        });
        if (oferta) vencidas.push(oferta);
      }
      return vencidas;
    },

    async confirmar(organizationId, compromissoId) {
      const revision = await revisaoAtual(organizationId, compromissoId, "pending");
      // Já confirmado (alguém respondeu SIM duas vezes) não é erro: a pessoa
      // está confirmada, que é o desfecho pedido.
      if (revision === null) return;
      const { error } = await supabase.rpc("fn_appointment_change", {
        p_org: organizationId,
        p_id: compromissoId,
        p_revision: revision,
        p_patch: { status: "confirmed" },
      });
      if (error) throw new Error(error.message);
    },

    async soltar(organizationId, compromissoId, motivo) {
      const revision = await revisaoAtual(organizationId, compromissoId, "pending");
      // Soltar o que já está solto é o desfecho esperado quando a varredura de
      // pendentes venceu a corrida com a recusa. Não é erro.
      if (revision === null) return;
      const { error } = await supabase.rpc("fn_appointment_change", {
        p_org: organizationId,
        p_id: compromissoId,
        p_revision: revision,
        p_patch: { status: "cancelled", cancellation_reason: motivo },
      });
      if (error) throw new Error(error.message);
    },

    async situar(organizationId, esperaId, situacao) {
      const { error } = await supabase
        .from("calendar_waitlist")
        .update({ status: situacao, updated_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("id", esperaId);
      if (error) throw new Error(error.message);
    },
  };
}

/** Completa a oferta com o horário do compromisso segurado — o texto precisa dele. */
async function ofertaComCompromisso(
  supabase: SB,
  organizationId: string,
  base: { esperaId: string; contatoId: string; compromissoId: string; expiraEm: Date },
): Promise<OfertaCorrente | null> {
  const { data, error } = await supabase
    .from("calendar_appointments")
    .select("id, starts_at, ends_at, owner_user_id, time_zone, status")
    .eq("organization_id", organizationId)
    .eq("id", base.compromissoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const linha = data as Record<string, unknown> | null;
  if (!linha) return null;
  const startsAt = dataOuNulo(linha.starts_at);
  const endsAt = dataOuNulo(linha.ends_at);
  if (!startsAt || !endsAt) return null;
  return {
    ...base,
    startsAt,
    endsAt,
    ownerUserId: typeof linha.owner_user_id === "string" ? linha.owner_user_id : null,
    timeZone: typeof linha.time_zone === "string" ? linha.time_zone : "America/Sao_Paulo",
  };
}

export interface InscricaoPedida {
  organizationId: string;
  contactId: string;
  eventTypeId: string;
  ownerUserId?: string | null;
  janelas?: ScheduleWindow[];
  antecedenciaMinimaHoras?: number;
  validoAte?: Date | null;
  urgencia?: number;
  observacoes?: string | null;
  /** Quem inscreveu. `system` para a inscrição nascida de uma ferramenta do agente. */
  createdByKind: "user" | "ai" | "system" | "contact";
  createdByUserId?: string | null;
}

export type ResultadoDaInscricao =
  | { inscrito: true; esperaId: string; jaEstava: boolean }
  | { inscrito: false; motivo: "contato_sem_servico" };

/**
 * "Quero encaixe" — a marca que hoje vive no caderno da recepção.
 *
 * Idempotente por construção: o índice único parcial
 * (`calendar_waitlist_viva_por_contato_servico_idx`) recusa uma segunda
 * inscrição viva do mesmo contato no mesmo serviço, e o 23505 aqui é traduzido
 * em `jaEstava` — pedir duas vezes o mesmo encaixe não duplica a pessoa na fila
 * nem vira erro para o modelo.
 */
export async function inscreverNaEspera(
  supabase: SB,
  pedido: InscricaoPedida,
): Promise<ResultadoDaInscricao> {
  const janelas = Array.isArray(pedido.janelas) ? pedido.janelas : [];
  const { data, error } = await supabase
    .from("calendar_waitlist")
    .insert({
      organization_id: pedido.organizationId,
      contact_id: pedido.contactId,
      event_type_id: pedido.eventTypeId,
      owner_user_id: pedido.ownerUserId ?? null,
      janelas,
      antecedencia_minima_horas: pedido.antecedenciaMinimaHoras ?? 0,
      valido_ate: pedido.validoAte ? pedido.validoAte.toISOString() : null,
      urgencia: pedido.urgencia ?? 0,
      observacoes: pedido.observacoes ?? null,
      created_by_kind: pedido.createdByKind,
      created_by_user_id: pedido.createdByUserId ?? null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code !== "23505") throw new Error(error.message);
    const { data: existente, error: erroLeitura } = await supabase
      .from("calendar_waitlist")
      .select("id")
      .eq("organization_id", pedido.organizationId)
      .eq("contact_id", pedido.contactId)
      .eq("event_type_id", pedido.eventTypeId)
      .in("status", ["waiting", "offered"])
      .maybeSingle();
    if (erroLeitura) throw new Error(erroLeitura.message);
    const linha = existente as { id?: unknown } | null;
    if (!linha?.id) return { inscrito: false, motivo: "contato_sem_servico" };
    return { inscrito: true, esperaId: String(linha.id), jaEstava: true };
  }

  const linha = data as { id?: unknown } | null;
  if (!linha?.id) return { inscrito: false, motivo: "contato_sem_servico" };
  return { inscrito: true, esperaId: String(linha.id), jaEstava: false };
}

/**
 * A vaga abriu — chamado pelo cancelamento e pela varredura de pendentes.
 *
 * DOIS DESFECHOS, e a diferença é o que evita oferecer a mesma vaga à mesma
 * pessoa em laço: se o compromisso cancelado era a vaga SEGURADA de alguém,
 * essa pessoa recusou — ela volta para a fila DEPOIS de a vaga passar para o
 * próximo. Se era um compromisso comum, a vaga é oferecida à fila.
 *
 * Nunca lança: quem chama é um caminho que já concluiu o efeito principal
 * (o cancelamento está gravado). Derrubar a resposta por causa de um encaixe
 * seria transformar um bônus em defeito — e a vaga continua livre, que é o
 * estado anterior.
 */
export async function aposVagaLiberada(
  supabase: SB,
  entrada: { organizationId: string; appointmentId: string; agora: Date },
): Promise<ResultadoDaOferta | { ofertada: false; motivo: "erro" }> {
  try {
    const porta = portaSupabase(supabase);
    const { data, error } = await supabase
      .from("calendar_waitlist")
      .select("id")
      .eq("organization_id", entrada.organizationId)
      .eq("oferta_appointment_id", entrada.appointmentId)
      .eq("status", "offered")
      .maybeSingle();
    if (error) throw new Error(error.message);
    const dono = data as { id?: unknown } | null;
    if (dono?.id) {
      const recusa = await recusarEncaixe(porta, {
        organizationId: entrada.organizationId,
        esperaId: String(dono.id),
        definitivo: false,
        agora: entrada.agora,
      });
      return recusa.proximo ?? { ofertada: false, motivo: "sem_candidato" };
    }
    return await oferecerVagaQueAbriu(porta, entrada);
  } catch (erro) {
    logger.warn("[encaixe] a vaga abriu e o encaixe falhou", {
      organizationId: entrada.organizationId,
      appointmentId: entrada.appointmentId,
      error: erro instanceof Error ? erro.message : String(erro),
    });
    return { ofertada: false, motivo: "erro" };
  }
}

/**
 * O compromisso segurado foi CONFIRMADO: a pessoa está atendida, e a inscrição
 * dela sai da fila como `booked`.
 *
 * Chamado pelo handler de alteração quando o status virou `confirmed`. Se a
 * linha não for uma vaga da lista de espera, o update casa zero linhas — é o
 * caso de todo compromisso comum.
 */
export async function fecharEncaixeConfirmado(
  supabase: SB,
  entrada: { organizationId: string; appointmentId: string },
): Promise<void> {
  try {
    const { error } = await supabase
      .from("calendar_waitlist")
      .update({ status: "booked", updated_at: new Date().toISOString() })
      .eq("organization_id", entrada.organizationId)
      .eq("oferta_appointment_id", entrada.appointmentId)
      .eq("status", "offered");
    if (error) throw new Error(error.message);
  } catch (erro) {
    logger.warn("[encaixe] confirmar o compromisso não fechou a inscrição", {
      organizationId: entrada.organizationId,
      appointmentId: entrada.appointmentId,
      error: erro instanceof Error ? erro.message : String(erro),
    });
  }
}

/**
 * A varredura de TODAS as organizações, para a rota de cron.
 *
 * A rota de pendentes não tem organização no contexto (ela varre o banco
 * inteiro), então lê as ofertas vencidas sem filtro de tenant e chama o
 * vencimento por organização — o serviço continua sendo sempre escopado, como
 * manda a regra do repo para client service-role.
 */
export async function varrerOfertasVencidas(
  supabase: SB,
  entrada: { agora: Date },
): Promise<{ organizacoes: number; vencidas: number; reoferecidas: number }> {
  try {
    const { data, error } = await supabase
      .from("calendar_waitlist")
      .select("organization_id")
      .eq("status", "offered")
      .lte("oferta_expira_em", entrada.agora.toISOString())
      .limit(TETO_DA_VARREDURA);
    if (error) throw new Error(error.message);
    const organizacoes = [
      ...new Set(
        ((data ?? []) as Array<{ organization_id?: unknown }>)
          .map((l) => (typeof l.organization_id === "string" ? l.organization_id : null))
          .filter((id): id is string => id !== null),
      ),
    ];
    let vencidas = 0;
    let reoferecidas = 0;
    for (const organizationId of organizacoes) {
      const r = await vencerOfertasDeEncaixe(supabase, { organizationId, agora: entrada.agora });
      vencidas += r.vencidas;
      reoferecidas += r.reoferecidas;
    }
    return { organizacoes: organizacoes.length, vencidas, reoferecidas };
  } catch (erro) {
    logger.warn("[encaixe] a varredura de ofertas vencidas falhou", {
      error: erro instanceof Error ? erro.message : String(erro),
    });
    return { organizacoes: 0, vencidas: 0, reoferecidas: 0 };
  }
}

/** O vencimento dentro de UMA organização — a unidade que sempre tem escopo. */
export async function vencerOfertasDeEncaixe(
  supabase: SB,
  entrada: { organizationId: string; agora: Date },
): Promise<{ vencidas: number; reoferecidas: number }> {
  try {
    return await vencerOfertas(portaSupabase(supabase), entrada);
  } catch (erro) {
    logger.warn("[encaixe] a varredura de ofertas vencidas falhou", {
      organizationId: entrada.organizationId,
      error: erro instanceof Error ? erro.message : String(erro),
    });
    return { vencidas: 0, reoferecidas: 0 };
  }
}
