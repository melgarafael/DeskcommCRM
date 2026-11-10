import type { createClient } from "@/lib/supabase/server";
import type { TimelineItem, TimelineItemView } from "@/lib/types/contacts";

/**
 * As peças que as DUAS timelines compartilham — a do contato e a do lead.
 *
 * Extraídas em vez de copiadas: a lista de colunas tem um portão de
 * exaustividade contra `TimelineItem`, e uma segunda cópia dele começaria
 * idêntica e divergiria no primeiro campo novo, sem nada acusar. É a mesma
 * razão pela qual o formulário do dossiê foi extraído e não duplicado.
 */
export const TIMELINE_COL_LIST = [
  "id",
  "organization_id",
  "lead_id",
  "contact_id",
  "source_module",
  "source_id",
  "type",
  "payload",
  "metadata",
  "performed_at",
  "performed_by_user_id",
  "actor_kind",
  "actor_agent_id",
  "reason",
  "evidence",
] as const satisfies readonly (keyof TimelineItem)[];

/**
 * O PORTÃO, em tempo de compilação — o comentário acima virou regra executável.
 *
 * `satisfies keyof TimelineItem` pega a primeira direção: pedir coluna que o
 * tipo não conhece não compila. O `Faltando` abaixo pega a segunda, que é a que
 * doeu de verdade: campo novo no tipo e esquecido no SELECT deixa de ser um
 * bug silencioso (opcional vira `undefined`, tela cai no fallback, tudo verde)
 * e passa a ser erro de tipo, com o nome do campo que falta na mensagem.
 *
 * O CASO QUE O MOTIVOU, porque portão sem história vira "cerimônia" e é
 * removido: a `0071` criou `reason`/`actor_kind`, o tipo passou a declará-los, a
 * tela passou a lê-los — e a lista de colunas ficou para trás. Como os campos
 * são OPCIONAIS no tipo, `it.reason` virava `undefined`, o corpo da linha caía
 * no resumo do payload (JSON de UUID na cara do usuário) e todo ator virava
 * "não registrado". Tudo compilando verde: a interrogação do opcional é que
 * cala o compilador. Este bloco existe para que aquilo não compile de novo.
 */
type ColunasPedidas = (typeof TIMELINE_COL_LIST)[number];
type Faltando = Exclude<keyof TimelineItem, ColunasPedidas>;
const _todoCampoDoTipoEstaNoSelect: Faltando extends never
  ? true
  : ["TIMELINE_COL_LIST não pede estes campos de TimelineItem:", Faltando] = true;
void _todoCampoDoTipoEstaNoSelect;

export const TIMELINE_COLS = TIMELINE_COL_LIST.join(", ");

export interface Cursor {
  performed_at: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
export function decodeCursor(raw: string): Cursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Cursor;
    if (typeof parsed.id !== "string" || typeof parsed.performed_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * O EIXO do dossiê: quais atividades pertencem a ESTE negócio.
 *
 * Função em vez de string solta na rota porque o segundo lado da união é
 * removível sem nada quebrar — hoje ele casa ZERO linhas, e é exatamente por
 * isso que parece redundante para quem lê rápido. O teste ao lado
 * (`timeline-eixo.test.ts`) prende as três propriedades; o comentário pede, o
 * teste obriga.
 *
 *  - lado 1 (`lead_id = este`): dá porta ao negócio SEM contato, que antes não
 *    tinha nenhuma e mostrava "Nada aconteceu" com 111 atividades no banco;
 *  - lado 2 (`contact_id = <contato> and lead_id is null`): preserva a
 *    atividade que nasce da CONVERSA e não de um negócio — o que o eixo antigo,
 *    por contato, protegia de graça e que eu perderia ao trocar de eixo;
 *  - o negócio IRMÃO fica de fora por construção: a atividade dele tem
 *    `lead_id = irmão`, e não casa com nenhum dos dois lados.
 */
export function eixoDoDossie(leadId: string, contactId: string | null): string | null {
  if (!contactId) return null; // sem contato o lado 2 não existe: quem chama usa `.eq`
  return `lead_id.eq.${leadId},and(contact_id.eq.${contactId},lead_id.is.null)`;
}

/** Anexa o nome do agente e da pessoa que agiram, para a linha não dizer só "Agente". */
export async function comNomeDoAtor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  rows: TimelineItem[],
): Promise<TimelineItemView[]> {
  const agentIds = [...new Set(rows.map((r) => r.actor_agent_id).filter((v): v is string => !!v))];
  const userIds = [...new Set(rows.map((r) => r.performed_by_user_id).filter((v): v is string => !!v))];

  const nomeAgente = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data } = await supabase.from("ai_agents").select("id, name").in("id", agentIds);
    for (const a of (data ?? []) as Array<{ id: string; name: string }>) nomeAgente.set(a.id, a.name);
  }

  const nomeUsuario = new Map<string, string>();
  if (userIds.length > 0) {
    // ⚠️ IMPORTS TARDIOS, E NÃO É ESTILO: os DOIS módulos abaixo importam
    // `@/lib/env`, que VALIDA o ambiente no topo e LANÇA se faltar variável.
    // Com eles no topo daqui, só de carregar este arquivo o ambiente precisava
    // estar completo — e `eixoDoDossie`, que é função PURA e não toca em
    // Supabase nenhum, arrastava o env junto.
    //
    // Foi assim que a main quebrou (run 30182066284): `tests/unit/timeline-
    // eixo.test.ts` importava só a função pura, o CI não tem `.env` no disco, e
    // a SUÍTE INTEIRA falhou ao carregar — 1 failed / 134 passed. Falha de
    // MÓDULO, não de teste: nenhuma asserção chegou a rodar.
    //
    // E `@/lib/audit` é o menos óbvio dos dois: `isServiceRoleConfigured` é um
    // helper de três linhas que não usa env para nada — quem o arrasta é o
    // módulo em que ele mora. Consertar só o admin client deixava a main
    // vermelha do mesmo jeito (medido: a sonda de import continuou falhando).
    //
    // Os imports ficam onde as funções são de fato USADAS. Quem importa a
    // função pura não paga por dependência que ela não tem.
    const { nomesDosAtendentes } = await import("@/lib/users/nome-do-atendente");
    for (const [id, nome] of await nomesDosAtendentes(orgId, userIds)) {
      if (typeof nome === "string" && nome.trim() !== "") nomeUsuario.set(id, nome);
    }
  }

  return rows.map((r) => ({
    ...r,
    actor_agent_name: r.actor_agent_id ? (nomeAgente.get(r.actor_agent_id) ?? null) : null,
    actor_user_name: r.performed_by_user_id
      ? (nomeUsuario.get(r.performed_by_user_id) ?? null)
      : null,
  }));
}

