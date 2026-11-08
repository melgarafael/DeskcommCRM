/**
 * A PORTA DO ENCAIXE CONTRA O SUPABASE — e os ganchos que a agenda chama.
 *
 * Nenhuma decisão mora aqui: quem decide é `lista-de-espera.ts` (cabe ou não
 * cabe) e `encaixe.ts` (a ordem dos passos). Este é o único ponto do produto que
 * sabe que a fila se chama `calendar_waitlist`.
 *
 * ─── Módulo opcional (doc 208, ADR-0002) ──────────────────────────────────
 *
 * A tabela só existe onde o módulo foi instalado. Todo gancho começa pela chave
 * e usa o client de serviço, porque `modulos_instalados` não tem policy e a fila
 * não aceita escrita de sessão: com o módulo desligado, nenhuma consulta alcança
 * `calendar_waitlist`, e a agenda segue como sempre.
 *
 * ─── As escritas ──────────────────────────────────────────────────────────
 *
 * Segurar a vaga e marcar a inscrição são `fn_lista_de_espera_ofertar`, numa
 * transação. Soltar passa por `fn_appointment_change`, que confere a revisão e
 * recusa linha já cancelada; é uma escrita do produto, sem o laço de automação
 * do cancelamento, porque a pessoa nunca teve aquele horário marcado.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { foraDaFronteira } from "@/lib/atendimento/fronteira-server";
import { audit } from "@/lib/audit";
import { desfechoDoEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { espacarEnvio } from "@/lib/automation/throttle";
import { ehContatoPessoal } from "@/lib/contacts/contato-pessoal";
import { moduloLigado, moduloLigadoComMemo } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { ehOperante } from "@/lib/organizacao/operante";
import type { ScheduleWindow } from "@/lib/schemas/routing";
import { createAdminClient } from "@/lib/supabase/admin";

import type {
  ConfigDaListaDeEspera,
  InscricaoNaEspera,
  ServicoDaEspera,
} from "./lista-de-espera";
import { configDaListaDeEsperaSchema, janelasDaEsperaSchema } from "./lista-de-espera";
import {
  oferecerVagaQueAbriu,
  recusarEncaixe,
  vencerOfertas,
  type OfertaCorrente,
  type PortaDoEncaixe,
  type ResultadoDaOferta,
} from "./encaixe";

type SB = SupabaseClient;

/** Teto da fila lida por vaga. Uma clínica não tem mil pedidos de encaixe. */
const TETO_DA_FILA = 200;

/** Teto por rodada de cron. O que sobrar volta na rodada seguinte. */
const TETO_DA_VARREDURA = 500;

/** O módulo, no vocabulário de `lib/instalacao/modulos.ts`. */
const MODULO = "lista_de_espera" as const;

function dataOuNulo(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `janelas` é jsonb. `null` = a coluna não é uma lista de janelas válidas, e a
 * inscrição não entra na fila: virar "qualquer horário" chamaria a pessoa num
 * horário que ela não ofereceu. Falha fechada, com aviso no log.
 */
export function lerJanelas(bruto: unknown): ScheduleWindow[] | null {
  const lidas = janelasDaEsperaSchema.safeParse(bruto);
  return lidas.success ? lidas.data : null;
}

/** Traduz a linha da fila para o vocabulário da decisão. */
function lerInscricao(linha: Record<string, unknown>): InscricaoNaEspera | null {
  const id = typeof linha.id === "string" ? linha.id : null;
  const contactId = typeof linha.contact_id === "string" ? linha.contact_id : null;
  const eventTypeId = typeof linha.event_type_id === "string" ? linha.event_type_id : null;
  const createdAt = dataOuNulo(linha.created_at);
  const janelas = lerJanelas(linha.janelas);
  if (!id || !contactId || !eventTypeId || !createdAt) return null;
  if (!janelas) {
    logger.warn("[encaixe] inscrição com janelas ilegíveis fora da fila", { espera_id: id });
    return null;
  }
  return {
    id,
    contactId,
    eventTypeId,
    ownerUserId: typeof linha.owner_user_id === "string" ? linha.owner_user_id : null,
    janelas,
    antecedenciaMinimaHoras: Number(linha.antecedencia_minima_horas ?? 0),
    validoAte: dataOuNulo(linha.valido_ate),
    urgencia: Number(linha.urgencia ?? 0),
    createdAt,
    vagaRecusadaInicio: dataOuNulo(linha.vaga_recusada_inicio),
  };
}

const COLUNAS_DA_INSCRICAO =
  "id, contact_id, event_type_id, owner_user_id, janelas, antecedencia_minima_horas, valido_ate, urgencia, vaga_recusada_inicio, created_at";

/**
 * Os prazos da organização, se o recurso está ligado e a organização opera. Só o
 * que passa inteiro pelo schema vale: sem prazos escolhidos, `null`, nunca um
 * padrão (doc 208). Empresa suspensa não oferece vaga, porque a oferta é mensagem.
 */
export async function configDaEspera(
  admin: SB,
  organizationId: string,
): Promise<ConfigDaListaDeEspera | null> {
  const { data, error } = await admin
    .from("organizations")
    .select("settings, status")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const linha = data as { settings?: Record<string, unknown> | null; status?: string } | null;
  if (!ehOperante(linha?.status)) return null;
  const config = configDaListaDeEsperaSchema.safeParse(linha?.settings?.lista_de_espera);
  return config.success && config.data.ativa ? config.data : null;
}

/** O número pelo qual a pessoa seria avisada. `null` = não dá para avisar por aqui. */
async function canalDoAviso(admin: SB, organizationId: string, contatoId: string): Promise<string | null> {
  const { data: contato, error } = await admin
    .from("contacts")
    .select("id, is_blocked, is_anonymized, is_personal, phone_number, consent")
    .eq("organization_id", organizationId)
    .eq("id", contatoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const linha = contato as ({ is_anonymized?: boolean; is_personal?: boolean } & Record<string, unknown>) | null;
  if (!linha || linha.is_anonymized || ehContatoPessoal(linha)) return null;
  if (!checarGuardasDeContato({ context: { contact: linha } }).ok) return null;

  const { data: conversas, error: erroConversa } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contatoId)
    .eq("is_group", false)
    .not("channel_session_id", "is", null)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (erroConversa) throw new Error(erroConversa.message);
  const sessao = (conversas as Array<{ channel_session_id?: string | null }> | null)?.[0]?.channel_session_id;
  return sessao ?? null;
}

/** A porta de verdade. `agora` NÃO é lido aqui: quem chama decide o instante. */
export function portaSupabase(admin: SB): PortaDoEncaixe {
  async function revisaoAtual(organizationId: string, id: string, status: string) {
    const { data, error } = await admin
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
    config: (organizationId) => configDaEspera(admin, organizationId),

    async vaga(organizationId, appointmentId) {
      const { data, error } = await admin
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
      const { data, error } = await admin
        .from("calendar_waitlist")
        .select(COLUNAS_DA_INSCRICAO)
        .eq("organization_id", organizationId)
        .eq("status", "waiting")
        .is("fora_da_fila_em", null)
        .order("urgencia", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(TETO_DA_FILA);
      if (error) throw new Error(error.message);
      const lidas: InscricaoNaEspera[] = [];
      for (const linha of (data ?? []) as Record<string, unknown>[]) {
        const inscricao = lerInscricao(linha);
        if (inscricao) lidas.push(inscricao);
      }
      if (lidas.length === 0) return [];
      // Bloqueado ou anonimizado não recebe vaga: quem pediu para sair saiu.
      const { data: contatos, error: erroContatos } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", organizationId)
        .in("id", [...new Set(lidas.map((i) => i.contactId))])
        .eq("is_blocked", false)
        .eq("is_anonymized", false);
      if (erroContatos) throw new Error(erroContatos.message);
      const disponiveis = new Set(((contatos ?? []) as Array<{ id: string }>).map((c) => c.id));
      return lidas.filter((i) => disponiveis.has(i.contactId));
    },

    async servico(organizationId, eventTypeId) {
      const { data, error } = await admin
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

    async podeAvisar(organizationId, contatoId) {
      const sessao = await canalDoAviso(admin, organizationId, contatoId);
      if (!sessao) return false;
      if (await adiarAteAJanelaAbrir(admin, organizationId, sessao)) return false;
      const ritmo = await (await criarPacingDoCanal(admin)).decide(organizationId, sessao, new Date());
      // Espaçamento é questão de segundos e `avisar` espera por ele; o teto do dia não.
      return ritmo.liberado || ritmo.motivo === "espacamento";
    },

    async ofertar(pedido) {
      const { data, error } = await admin.rpc("fn_lista_de_espera_ofertar", {
        p_org: pedido.organizationId,
        p_espera: pedido.esperaId,
        p_inicio: pedido.inicio.toISOString(),
        p_fim: pedido.fim.toISOString(),
        p_fuso: pedido.fuso,
        p_owner: pedido.ownerUserId,
        p_vaga_fim: pedido.vagaFim.toISOString(),
        p_expira: pedido.expiraEm.toISOString(),
      });
      if (error) throw new Error(error.message);
      const r = data as { ok?: boolean; compromisso_id?: string; motivo?: string };
      if (r.ok && r.compromisso_id) return { ok: true, compromissoId: r.compromisso_id };
      const motivo = r.motivo;
      if (motivo === "inscricao_mudou" || motivo === "contato_indisponivel" || motivo === "vaga_ja_ocupada") {
        return { ok: false, motivo };
      }
      return { ok: false, motivo: "servico_indisponivel" };
    },

    async avisar(organizationId, contatoId, texto) {
      try {
        const sessao = await canalDoAviso(admin, organizationId, contatoId);
        if (!sessao) return false;
        await espacarEnvio(sessao);
        const boundary = await beginServiceAtOrigin(admin, organizationId, contatoId, sessao);
        const mensagem = await sendMessageHandler(
          admin,
          {
            organization_id: organizationId,
            serviceBoundary: boundary,
            // A vaga segurada é um compromisso da própria pessoa, e sem esta
            // escolha a guarda da agenda adiaria justamente o convite dela. Só
            // esta mensagem muda: janela, opt-out e limite seguem valendo, e os
            // outros envios automáticos do contato continuam adiados.
            proactiveContext: { organizationId, contactId: contatoId, escolhaNoEnvio: "enviar" },
            actor: { type: "webhook_source", id: MODULO },
            requestId: `lista-de-espera:${randomUUID()}`,
          },
          { conversation_id: boundary.conversation_id, type: "text", body: texto },
        );
        // `queued` conta como saída: o motor reenvia quando o canal volta.
        const saiu = desfechoDoEnvio(MODULO, mensagem as unknown as MensagemEnviada).status !== "failed";
        if (saiu) await (await criarPacingDoCanal(admin)).registraEnvio(organizationId, sessao, new Date());
        return saiu;
      } catch (erro) {
        logger.warn("[encaixe] o aviso da vaga não saiu", {
          organization_id: organizationId,
          contact_id: contatoId,
          error: erro instanceof Error ? erro.message : String(erro),
        });
        return false;
      }
    },

    async oferta(organizationId, esperaId) {
      const { data, error } = await admin
        .from("calendar_waitlist")
        .select("id, contact_id, status, oferta_appointment_id, oferta_expira_em, oferta_vaga_fim")
        .eq("organization_id", organizationId)
        .eq("id", esperaId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const linha = data as Record<string, unknown> | null;
      if (!linha || String(linha.status) !== "offered") return null;
      return ofertaComCompromisso(admin, organizationId, linha);
    },

    async ofertasVencidas(organizationId, agora) {
      const { data, error } = await admin
        .from("calendar_waitlist")
        .select("id, contact_id, oferta_appointment_id, oferta_expira_em, oferta_vaga_fim")
        .eq("organization_id", organizationId)
        .eq("status", "offered")
        .lte("oferta_expira_em", agora.toISOString())
        .order("oferta_expira_em", { ascending: true })
        .limit(TETO_DA_FILA);
      if (error) throw new Error(error.message);
      const vencidas: OfertaCorrente[] = [];
      for (const linha of (data ?? []) as Record<string, unknown>[]) {
        const oferta = await ofertaComCompromisso(admin, organizationId, linha);
        if (oferta) vencidas.push(oferta);
        // O compromisso sumiu (a FK zerou a coluna): não há vaga a soltar.
        else await this.situar(organizationId, String(linha.id), "waiting");
      }
      return vencidas;
    },

    async soltar(organizationId, compromissoId, motivo) {
      const revision = await revisaoAtual(organizationId, compromissoId, "pending");
      // Soltar o que já está solto é o desfecho esperado quando a varredura de
      // pendentes venceu a corrida com a recusa. Não é erro.
      if (revision === null) return;
      const { error } = await admin.rpc("fn_appointment_change", {
        p_org: organizationId,
        p_id: compromissoId,
        p_revision: revision,
        p_patch: { status: "cancelled", cancellation_reason: motivo },
      });
      if (error) throw new Error(error.message);
    },

    async situar(organizationId, esperaId, situacao, vagaRecusada) {
      const { error } = await admin
        .from("calendar_waitlist")
        .update({
          status: situacao,
          updated_at: new Date().toISOString(),
          ...(situacao === "waiting"
            ? { oferta_appointment_id: null, oferta_expira_em: null, oferta_vaga_fim: null, ofertada_em: null }
            : {}),
          ...(vagaRecusada ? { vaga_recusada_inicio: vagaRecusada.toISOString() } : {}),
        })
        .eq("organization_id", organizationId)
        .eq("id", esperaId);
      if (error) throw new Error(error.message);
    },
  };
}

/** Completa a oferta com o compromisso segurado e o estado do contato. */
async function ofertaComCompromisso(
  admin: SB,
  organizationId: string,
  linha: Record<string, unknown>,
): Promise<OfertaCorrente | null> {
  const compromissoId = typeof linha.oferta_appointment_id === "string" ? linha.oferta_appointment_id : null;
  const contatoId = typeof linha.contact_id === "string" ? linha.contact_id : null;
  const expiraEm = dataOuNulo(linha.oferta_expira_em);
  const vagaFim = dataOuNulo(linha.oferta_vaga_fim);
  if (!compromissoId || !contatoId || !expiraEm || !vagaFim) return null;

  const { data, error } = await admin
    .from("calendar_appointments")
    .select("id, starts_at, ends_at, owner_user_id, time_zone, status")
    .eq("organization_id", organizationId)
    .eq("id", compromissoId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const compromisso = data as Record<string, unknown> | null;
  const startsAt = dataOuNulo(compromisso?.starts_at);
  const endsAt = dataOuNulo(compromisso?.ends_at);
  if (!compromisso || !startsAt || !endsAt) return null;

  const { data: contato, error: erroContato } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", contatoId)
    .eq("is_blocked", false)
    .eq("is_anonymized", false)
    .maybeSingle();
  if (erroContato) throw new Error(erroContato.message);

  return {
    esperaId: String(linha.id),
    contatoId,
    compromissoId,
    compromissoStatus: String(compromisso.status),
    contatoDisponivel: contato !== null,
    expiraEm,
    vagaFim,
    startsAt,
    endsAt,
    ownerUserId: typeof compromisso.owner_user_id === "string" ? compromisso.owner_user_id : null,
    timeZone: typeof compromisso.time_zone === "string" ? compromisso.time_zone : "America/Sao_Paulo",
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
  /** Quando e por onde a pessoa aceitou ser avisada (doc 208). Sem isto não há inscrição. */
  consentimentoEm: Date;
  consentimentoOrigem: "tela" | "agente" | "contato";
  /** Quem inscreveu. */
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
      consentimento_em: pedido.consentimentoEm.toISOString(),
      consentimento_origem: pedido.consentimentoOrigem,
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
 * A vaga abriu. Chamado pelo cancelamento da agenda, pela expiração de pendentes
 * e pelo cancelamento vindo do Google.
 *
 * DOIS DESFECHOS, e a diferença é o que evita oferecer a mesma vaga à mesma
 * pessoa em laço: se o compromisso cancelado era a vaga SEGURADA de alguém,
 * essa pessoa recusou — ela volta para a fila DEPOIS de a vaga passar para o
 * próximo. Se era um compromisso comum, a vaga é oferecida à fila.
 *
 * Nunca lança: o cancelamento já está gravado, e um encaixe que falha deixa a
 * vaga livre, que é o estado anterior.
 *
 * `foraDaFronteira` porque quem cancela pode ser o agente no turno de OUTRO
 * contato: o aviso desta oferta não pertence àquele atendimento.
 */
export async function aposVagaLiberada(entrada: {
  organizationId: string;
  appointmentId: string;
  agora: Date;
}): Promise<ResultadoDaOferta | { ofertada: false; motivo: "erro" }> {
  try {
    const admin = createAdminClient();
    if (!(await moduloLigadoComMemo(admin, MODULO))) return { ofertada: false, motivo: "desligada" };
    return await foraDaFronteira(async () => {
      const porta = portaSupabase(admin);
      const { data, error } = await admin
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
    });
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
 * O compromisso segurado foi CONFIRMADO, por qualquer porta da agenda: a
 * inscrição sai da fila como `booked`. Em compromisso comum o update casa zero
 * linhas. Se esta escrita falhar, a varredura de prazo fecha a inscrição.
 */
export async function fecharEncaixeConfirmado(entrada: {
  organizationId: string;
  appointmentId: string;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!(await moduloLigadoComMemo(admin, MODULO))) return;
    const { error } = await admin
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
 * Lê as ofertas vencidas sem filtro de tenant e chama o vencimento por
 * organização; toda escrita continua escopada. Desligado na instalação, não toca
 * na tabela. Desligado numa organização, a oferta vencida ainda é solta, e só a
 * nova oferta deixa de sair.
 */
export async function varrerOfertasVencidas(
  admin: SB,
  entrada: { agora: Date },
): Promise<{ organizacoes: number; vencidas: number; reoferecidas: number }> {
  const zero = { organizacoes: 0, vencidas: 0, reoferecidas: 0 };
  try {
    if (!(await moduloLigado(admin, MODULO))) return zero;
    const { data, error } = await admin
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
    await foraDaFronteira(async () => {
      for (const organizationId of organizacoes) {
        const r = await vencerOfertas(portaSupabase(admin), { organizationId, agora: entrada.agora });
        vencidas += r.vencidas;
        reoferecidas += r.reoferecidas;
      }
    });
    if (vencidas > 0) {
      await audit({
        action: "agenda.encaixe_vencido",
        resourceType: "calendar_waitlist",
        metadata: { vencidas, reoferecidas, organizacoes: organizacoes.length },
      });
    }
    return { organizacoes: organizacoes.length, vencidas, reoferecidas };
  } catch (erro) {
    logger.warn("[encaixe] a varredura de ofertas vencidas falhou", {
      error: erro instanceof Error ? erro.message : String(erro),
    });
    return zero;
  }
}
