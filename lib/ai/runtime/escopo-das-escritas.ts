/**
 * Uma ESCRITA do agente num turno só alcança registros do CONTATO desse turno.
 *
 * As leituras já seguem essa regra, cada uma no seu handler (issues #2158,
 * #2178, #2184; PRs #2271, #2274, #2276). As escritas recebem o alvo por campos de nomes diferentes
 * (`contact_id`, `conversation_id`, `appointment_id`, `followup_id`,
 * `case_id`, `target_id`), e um handler de escrita filtra só por
 * `organization_id`, porque ele serve também a rota HTTP e o integrador, onde a
 * organização inteira é o alcance certo. Por isso a regra mora na ponte
 * (`lib/ai/runtime/tools.ts`), que é o único ponto que sabe que quem age é o
 * agente dentro de uma conversa.
 *
 * Tabela declarativa no molde de `ALVO_DE_FUNIL`: para cada escrita, cada campo
 * que traz um identificador diz de quem ele é. Duas regras de vacuidade:
 *
 *  - escrita AUSENTE da tabela é RECUSADA no turno, não liberada;
 *  - `tests/unit/escrita-do-turno-escopo.test.ts` reprova escrita do catálogo
 *    sem entrada, e campo `*_id`/`*_ids` sem dono declarado;
 *  - campo declarado que chega com valor que não é texto (lista, objeto) é
 *    RECUSADO: a conferência abaixo é por um id por campo.
 *
 * Granularidade de caso, de propósito diferente da nativa: o dono `chamado`
 * aceita caso de QUALQUER conversa do contato, enquanto o `provide_case_update`
 * do motor exige a conversa do turno (`human-cases.ts`). Os dois ficam dentro
 * do mesmo cliente. Não "alinhe" afrouxando o nativo.
 *
 * A recusa é UMA só para id inexistente e para id de outro cliente, com o
 * mesmo número de consultas: a resposta não distingue os dois casos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export type DonoDoCampo =
  /** O valor É o id do contato. Igualdade, sem consulta. */
  | "contato"
  /** `conversations.contact_id`. */
  | "conversa"
  /** `calendar_appointments.contact_id`. */
  | "compromisso"
  /** `cron_jobs.contact_id` (retorno: `kind='at'`, `job_kind='followup_turn'`). */
  | "retorno"
  /** `agent_cases.conversation_id` → `conversations.contact_id`. */
  | "chamado"
  /** `target_id` cujo dono depende de `target_kind` (conversation|contact|lead). */
  | "alvo_de_tag"
  /** `lead_id`: quem guarda é `negocioDaEscritaDoTurno`, em `tools.ts`. */
  | "negocio"
  /** Vínculos externos: número positivo e conexão ativa da organização. */
  | "paciente_amigo"
  | "consulta_amigo"
  /** Escolha ainda sem vínculo: linkAmigoPatient verifica paciente/telefone no domínio. */
  | "selecao_amigo"
  /** Catálogo externo numérico; schemas e relações são conferidos pelo domínio. */
  | "recurso_amigo"
  | "contexto_amigo"
  | "negocio_do_contato"
  /** Não é registro de cliente: funil, etapa, usuário, fluxo. */
  | "configuracao";

export const ESCOPO_DAS_ESCRITAS: Readonly<Record<string, Readonly<Record<string, DonoDoCampo>>>> = {
  // Amigo não usa escritaDelegadaAoContato. A ponte confere vínculos atuais;
  // o handler repete a autorização no domínio antes de acessar o provedor.
  crm_amigo_patient_create: { contact_id: "contato", insurance_id: "recurso_amigo" },
  crm_amigo_patient_update: { contact_id: "contato", patientId: "paciente_amigo", insurance_id: "recurso_amigo" },
  crm_amigo_link_patient: { contact_id: "contato", patient_id: "selecao_amigo", lead_id: "negocio_do_contato" },
  crm_amigo_attendance_create: {
    contact_id: "contato", patient_id: "paciente_amigo", event_id: "recurso_amigo", user_id: "recurso_amigo",
    place_id: "recurso_amigo", insurance_id: "recurso_amigo", insurance_product_id: "recurso_amigo",
  },
  crm_amigo_attendance_cancel: { contact_id: "contato", patient_id: "paciente_amigo", id: "consulta_amigo" },
  crm_amigo_attendance_reschedule: { contact_id: "contato", patient_id: "paciente_amigo", id: "consulta_amigo" },
  crm_amigo_attendance_status: { contact_id: "contato", patient_id: "paciente_amigo", attendance_id: "consulta_amigo" },
  // ---- agenda ----
  crm_book_appointment: { contact_id: "contato", owner_user_id: "configuracao", amigo: "contexto_amigo" },
  crm_find_and_book_appointment: { contact_id: "contato", owner_user_id: "configuracao", amigo: "contexto_amigo" },
  crm_reschedule_appointment: { appointment_id: "compromisso" },
  crm_cancel_appointment: { appointment_id: "compromisso" },
  crm_confirm_appointment: { appointment_id: "compromisso" },
  crm_set_appointment_outcome: { appointment_id: "compromisso" },

  // ---- contato e conversa ----
  crm_propose_contact_field: { contact_id: "contato" },
  crm_create_conversation_draft: { conversation_id: "conversa" },
  crm_assign_conversation: { conversation_id: "conversa", to_user_id: "configuracao" },
  crm_manage_tags: { target_id: "alvo_de_tag" },
  crm_send_whatsapp_message: { conversation_id: "conversa" },
  crm_request_human_handoff: { conversation_id: "conversa", target_user_id: "configuracao" },
  crm_resume_ai_attendance: { conversation_id: "conversa" },

  // ---- casos humanos ----
  crm_add_case_note: { case_id: "chamado" },
  crm_close_human_case: { case_id: "chamado" },

  // ---- negócio ----
  crm_create_lead: {
    contact_id: "contato",
    pipeline_id: "configuracao",
    stage_id: "configuracao",
    owner_user_id: "configuracao",
    owner_agent_id: "configuracao",
  },
  crm_update_lead: {
    lead_id: "negocio",
    contact_id: "contato",
    owner_user_id: "configuracao",
    owner_agent_id: "configuracao",
  },
  crm_move_lead_stage: { lead_id: "negocio", to_stage_id: "configuracao" },
  crm_retomar_lead: { lead_id: "negocio", stage_id: "configuracao" },
  crm_close_demand: { lead_id: "negocio" },
  crm_propose_reactivation: { lead_id: "negocio" },
  crm_draft_proposal: { lead_id: "negocio", conversation_id: "conversa" },
  // #3316 — proposta de campo lida num documento: só o card (o proposto entra
  // em `lead_field_proposals`, nunca no card; confirma quem atende na tela).
  crm_propose_lead_fields_from_document: {
    lead_id: "negocio",
    // o documento anexado pertence ao MESMO card da proposta
    attachment_id: "negocio",
  },

  // ---- retorno ----
  crm_schedule_followup: { lead_id: "negocio", contact_id: "contato" },
  crm_cancel_followup: { followup_id: "retorno" },
  crm_enroll_followup_flow: { contact_id: "contato", flow_id: "configuracao" },

  // ---- sem registro de cliente ----
  crm_save_org_memory: {},
};

export type VereditoDaEscrita =
  | { permitido: true }
  | { permitido: false; motivo: "fora_da_conversa" | "indisponivel" | "escrita_sem_escopo_do_turno"; mensagem: string };

const FORA_DA_CONVERSA = {
  permitido: false,
  motivo: "fora_da_conversa",
  mensagem:
    "esta conversa é com outra pessoa — um registro que não é deste cliente não é seu para " +
    "alterar; siga a conversa com quem está falando.",
} as const;

/** `true` quando o registro existe nesta organização E é do contato do turno. */
async function existeDoContato(
  supabase: SupabaseClient,
  tabela: string,
  organizationId: string,
  contato: string,
  id: string,
  extra: Record<string, string> = {},
): Promise<boolean> {
  let q = supabase
    .from(tabela)
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .eq("contact_id", contato);
  for (const [coluna, valor] of Object.entries(extra)) q = q.eq(coluna, valor);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

async function campoEhDoContato(
  supabase: SupabaseClient,
  organizationId: string,
  contato: string,
  dono: DonoDoCampo,
  id: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  switch (dono) {
    case "paciente_amigo":
    case "consulta_amigo":
    case "selecao_amigo":
    case "recurso_amigo":
    case "contexto_amigo":
      return false; // Conferidos como números em identificadorAmigoCabeNoTurno.
    case "negocio":
    case "configuracao":
      return true;
    case "negocio_do_contato":
      return existeDoContato(supabase, "crm_leads", organizationId, contato, id);
    case "contato":
      return id.toLowerCase() === contato.toLowerCase();
    case "conversa":
      return existeDoContato(supabase, "conversations", organizationId, contato, id);
    case "compromisso":
      return existeDoContato(supabase, "calendar_appointments", organizationId, contato, id);
    case "retorno":
      return existeDoContato(supabase, "cron_jobs", organizationId, contato, id, {
        kind: "at",
        job_kind: "followup_turn",
      });
    case "chamado": {
      // Duas consultas sempre, exista o caso ou não: a do recorte de
      // `casosVisiveisNoTurno` (escalacao.ts) e a do caso dentro dele.
      const conversas = await supabase
        .from("conversations")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contato);
      if (conversas.error) throw new Error(conversas.error.message);
      const ids = (conversas.data ?? []).map((c) => (c as { id: string }).id);
      const caso = await supabase
        .from("agent_cases")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("id", id)
        .in("conversation_id", ids)
        .maybeSingle();
      if (caso.error) throw new Error(caso.error.message);
      return caso.data !== null;
    }
    case "alvo_de_tag":
      switch (args.target_kind) {
        case "contact":
          return id.toLowerCase() === contato.toLowerCase();
        case "conversation":
          return existeDoContato(supabase, "conversations", organizationId, contato, id);
        case "lead":
          return existeDoContato(supabase, "crm_leads", organizationId, contato, id);
        default:
          return false;
      }
  }
}

async function identificadorAmigoCabeNoTurno(
  db: SupabaseClient, organizationId: string, contato: string, dono: DonoDoCampo,
  id: number, args: Record<string, unknown>,
): Promise<boolean> {
  if (dono === "recurso_amigo" || dono === "selecao_amigo") return true;
  const { data: connection, error } = await db.from("amigo_connections").select("id")
    .eq("organization_id", organizationId).eq("active", true).maybeSingle();
  if (error) throw new Error("amigo_scope_lookup_failed");
  if (!connection) return false;
  let patientId = id;
  if (dono === "consulta_amigo") {
    const attendance = await db.from("amigo_appointment_links").select("patient_id")
      .eq("organization_id", organizationId).eq("connection_id", connection.id)
      .eq("attendance_id", id).maybeSingle();
    if (attendance.error) throw new Error("amigo_scope_lookup_failed");
    if (!attendance.data || attendance.data.patient_id !== args.patient_id) return false;
    patientId = attendance.data.patient_id;
  }
  const link = await db.from("amigo_patient_links").select("patient_id")
    .eq("organization_id", organizationId).eq("connection_id", connection.id)
    .eq("contact_id", contato).eq("patient_id", patientId).maybeSingle();
  if (link.error) throw new Error("amigo_scope_lookup_failed");
  return link.data !== null;
}

/**
 * O veredito da ponte para uma escrita (`write` ou `handoff`) durante um turno.
 *
 * Campo ausente (`undefined`/`null`) não é conferido: não há alvo a mirar.
 * Campo presente que não é texto é recusado, nunca pulado. Falha de
 * leitura vira `indisponivel`, nunca `fora_da_conversa` — o modelo leria a
 * segunda como veredito e pararia de tentar.
 */
export async function escritaCabeNoTurno(
  supabase: SupabaseClient,
  organizationId: string,
  contatoDoTurno: string,
  ferramenta: string,
  args: Record<string, unknown>,
): Promise<VereditoDaEscrita> {
  // `hasOwn`: o nome vem também de servidor remoto, e `valueOf`/`constructor`
  // achariam a propriedade HERDADA — truthy, sem campos, e a escrita passaria.
  const campos = Object.hasOwn(ESCOPO_DAS_ESCRITAS, ferramenta)
    ? ESCOPO_DAS_ESCRITAS[ferramenta]
    : undefined;
  if (!campos) {
    return {
      permitido: false,
      motivo: "escrita_sem_escopo_do_turno",
      mensagem: "esta ação não está disponível durante uma conversa; siga a conversa normalmente.",
    };
  }
  try {
    // As novas escritas externas sempre declaram responsável e paciente. Não
    // herdam a vacuidade dos inputs legados nem aceitam ID numérico como UUID.
    if (ferramenta.startsWith("crm_amigo_")) {
      if (typeof args.contact_id !== "string" || args.contact_id.toLowerCase() !== contatoDoTurno.toLowerCase()) return FORA_DA_CONVERSA;
      const campoPaciente = ferramenta === "crm_amigo_patient_update" ? "patientId" : "patient_id";
      if (ferramenta !== "crm_amigo_patient_create" && !Number.isSafeInteger(args[campoPaciente])) return FORA_DA_CONVERSA;
    }
    for (const [campo, dono] of Object.entries(campos)) {
      const valor = args[campo];
      if (valor === undefined || valor === null) continue;
      if (dono === "contexto_amigo") {
        if (typeof valor !== "object" || Array.isArray(valor) || typeof args.contact_id !== "string" || args.contact_id.toLowerCase() !== contatoDoTurno.toLowerCase()) return FORA_DA_CONVERSA;
        const selecao = valor as Record<string, unknown>;
        const permitidos = ["patient_id", "user_id", "place_id", "insurance_id", "insurance_product_id"];
        if (Object.keys(selecao).some(c => !permitidos.includes(c)) ||
          ["patient_id", "user_id", "place_id"].some(c => !Number.isSafeInteger(selecao[c])) ||
          Object.values(selecao).some(v => typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) ||
          (selecao.insurance_product_id !== undefined && selecao.insurance_id === undefined)) return FORA_DA_CONVERSA;
        if (!(await identificadorAmigoCabeNoTurno(supabase, organizationId, contatoDoTurno, "paciente_amigo", selecao.patient_id as number, selecao))) return FORA_DA_CONVERSA;
        continue;
      }
      if (["paciente_amigo", "consulta_amigo", "selecao_amigo", "recurso_amigo"].includes(dono)) {
        if (typeof valor !== "number" || !Number.isSafeInteger(valor) || valor <= 0) return FORA_DA_CONVERSA;
        if (!(await identificadorAmigoCabeNoTurno(supabase, organizationId, contatoDoTurno, dono, valor, args))) return FORA_DA_CONVERSA;
        continue;
      }
      if (typeof valor !== "string") return FORA_DA_CONVERSA;
      if (!(await campoEhDoContato(supabase, organizationId, contatoDoTurno, dono, valor, args))) {
        return FORA_DA_CONVERSA;
      }
    }
  } catch (err) {
    logger.warn("escopo da escrita do turno: consulta falhou", {
      tool: ferramenta,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      permitido: false,
      motivo: "indisponivel",
      mensagem: "não consegui conferir o registro desta conversa agora; tente de novo.",
    };
  }
  return { permitido: true };
}
