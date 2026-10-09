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
  /** Não é registro de cliente: funil, etapa, usuário, fluxo. */
  | "configuracao";

export const ESCOPO_DAS_ESCRITAS: Readonly<Record<string, Readonly<Record<string, DonoDoCampo>>>> = {
  // ---- agenda ----
  crm_book_appointment: { contact_id: "contato", owner_user_id: "configuracao" },
  crm_find_and_book_appointment: { contact_id: "contato", owner_user_id: "configuracao" },
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
    case "negocio":
    case "configuracao":
      return true;
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
  const campos = ESCOPO_DAS_ESCRITAS[ferramenta];
  if (!campos) {
    return {
      permitido: false,
      motivo: "escrita_sem_escopo_do_turno",
      mensagem: "esta ação não está disponível durante uma conversa; siga a conversa normalmente.",
    };
  }
  try {
    for (const [campo, dono] of Object.entries(campos)) {
      const valor = args[campo];
      if (valor === undefined || valor === null) continue;
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
