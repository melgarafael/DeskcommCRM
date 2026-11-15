/**
 * crm_save_lead_diagnosis — o agente qualificador grava o DIAGNÓSTICO da
 * empresa na ficha do contato (aba Diagnóstico).
 *
 * ── Grava direto (decisão D7 do dono) ────────────────────────────────────────
 *
 * Diferente de `crm_propose_contact_field`, que deixa o dado na fila para uma
 * pessoa confirmar, aqui o texto entra na ficha com o selo "Escrito pela IA"
 * (`diag_por = agente:<uuid>`), e a equipe edita pela aba. Proposta por campo
 * seria lenta demais para a prospecção em lote, e o diagnóstico não é dado
 * cadastral do titular: é a leitura comercial que a IA fez da empresa.
 *
 * ── Fora da conferência de campos ───────────────────────────────────────────
 *
 * `lib/mcp/conferencia-de-campos.ts` confere se o valor de um campo do NEGÓCIO
 * aparece no que o cliente disse no turno. O diagnóstico não é algo que o
 * cliente disse — é o que a IA concluiu (do site, do Instagram, da conversa) —,
 * então passar por ali recusaria todo diagnóstico legítimo. Esta ferramenta não
 * importa nada de lá, e `tests/unit/diagnostico-pela-ia.test.ts` vigia isso.
 *
 * ── Por que mescla NO BANCO ─────────────────────────────────────────────────
 *
 * O `PATCH /api/v1/contacts/:id` substitui `custom_fields` inteiro, e ler para
 * gravar depois (como a aba faz) apaga o que outro caminho gravou no meio. Aqui
 * a escrita é `custom_fields || pedaço` dentro de UMA instrução
 * (`fn_contato_anotar_campos`, migration 9393): os `link_*`, os campos da
 * organização e as observações da equipe nem passam pelo aplicativo.
 *
 * ── Cercas ──────────────────────────────────────────────────────────────────
 *
 * - Organização: toda leitura filtra `ctx.organizationId` (cliente de serviço,
 *   sem RLS), e a função do banco filtra de novo — contato de outra organização
 *   é "não encontrado", sem revelar que existe.
 * - Contato do turno: `contact_id: "contato"` em
 *   `lib/ai/runtime/escopo-das-escritas.ts`; a ponte recusa outro contato antes
 *   de o handler rodar.
 * - Ficha pessoal ou anonimizada: recusa com motivo em texto, no molde de
 *   `crm_get_contact`. A anonimizada é conferida também DENTRO da função do
 *   banco, porque gravar depois da anonimização devolveria dado apagado.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import {
  autoriaDoAgente,
  autoriaDoUsuario,
  autoriaSchema,
  CAMPOS_DO_AGENTE,
  gravacaoDoAgente,
  TETO_DO_DIAGNOSTICO,
  type EntradaDoAgente,
} from "@/lib/contacts/diagnostico-do-contato";
import type { Actor } from "@/lib/api/handlers/types";
import { defsDoPadraoDaOrg } from "@/lib/leads/padrao-do-campo";

import type { McpToolDefinition } from "../types";

/** A função do banco que mescla `custom_fields` numa instrução só. */
export const FUNCAO_DE_MESCLA = "fn_contato_anotar_campos";

const diagnosticoShape = {
  contact_id: z.string().uuid().describe("UUID do contato desta conversa."),
  segmento: z.string().max(TETO_DO_DIAGNOSTICO.segmento).optional().describe("Ramo da empresa."),
  cnpj: z.string().max(TETO_DO_DIAGNOSTICO.cnpj).optional().describe("CNPJ, com ou sem máscara."),
  resumo: z
    .string()
    .max(TETO_DO_DIAGNOSTICO.resumo)
    .optional()
    .describe("Diagnóstico: o que a empresa faz e onde perde venda."),
  oferta: z
    .string()
    .max(TETO_DO_DIAGNOSTICO.oferta)
    .optional()
    .describe("A oferta sugerida para esta empresa."),
};

/**
 * Quem assina. Só o AGENTE (com a linha em `ai_agents`) gera o selo "Escrito
 * pela IA"; uma pessoa por token assina como ela mesma. Token de integração e
 * agente sem `agent_id` não têm assinatura válida: a autoria antiga sai.
 */
export function autoriaDoAtor(actor: Actor): string | null {
  let autor: string | null = null;
  if (actor.type === "ai_agent" && actor.agent_id) autor = autoriaDoAgente(actor.agent_id);
  else if (actor.type === "user") autor = autoriaDoUsuario(actor.id);
  return autor !== null && autoriaSchema.safeParse(autor).success ? autor : null;
}

/**
 * Os textos do diagnóstico NÃO vão para a auditoria: `api_audit_log` é
 * append-only e a anonimização não o alcança. Fica o tamanho, que basta para
 * saber o que foi pedido.
 */
function redigirParaAuditoria(args: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = { ...args };
  for (const campo of CAMPOS_DO_AGENTE) {
    const valor = args[campo];
    if (typeof valor === "string") saida[campo] = `[${valor.length} caracteres]`;
  }
  return saida;
}

const RECUSAS = {
  contato_nao_encontrado: "não encontrei esse contato nesta conta.",
  contato_anonimizado:
    "esse contato exerceu o direito de exclusão de dados; não é possível registrar nada na ficha dele.",
  contato_pessoal:
    "este contato foi marcado como pessoal — ele está fora da operação e nada se escreve para ele.",
  nada_para_gravar: "informe ao menos um campo: segmento, cnpj, resumo ou oferta.",
  campo_da_organizacao:
    "esses campos são da própria empresa (configurados por ela) e não são preenchidos por esta ferramenta.",
} as const;

function recusa(motivo: keyof typeof RECUSAS, extra: Record<string, unknown> = {}) {
  return { gravado: false, motivo, ...extra, mensagem: RECUSAS[motivo] };
}

export const crmSaveLeadDiagnosis: McpToolDefinition<typeof diagnosticoShape> = {
  name: "crm_save_lead_diagnosis",
  description:
    "Grava na ficha do contato o diagnóstico da empresa: segmento, CNPJ, resumo (o que ela faz e onde " +
    "perde venda) e oferta sugerida. Grava direto, com o selo Escrito pela IA; a equipe revisa na aba " +
    "Diagnóstico. Só mude o campo que você concluiu; os outros ficam como estão. Não use para dados " +
    "pessoais do cliente nem para repetir o que ele disse.",
  inputSchema: diagnosticoShape,
  category: "write",
  // Paridade com `PATCH /api/v1/contacts/:id` (`requireRole("agent")`): editar
  // a ficha é trabalho de quem atende.
  requiresRole: "agent",
  requiresScope: "mcp:write",
  redigirParaAuditoria,
  handler: async (input, ctx) => {
    const { data: contato, error } = await ctx.supabase
      .from("contacts")
      .select("id, is_anonymized, is_personal, custom_fields")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.contact_id)
      .maybeSingle();
    if (error) throw new Error(`contacts: ${error.message}`);
    if (!contato) return recusa("contato_nao_encontrado");
    const ficha = contato as {
      is_anonymized: boolean | null;
      is_personal: boolean | null;
      custom_fields: Record<string, unknown> | null;
    };
    if (ficha.is_anonymized) return recusa("contato_anonimizado");
    if (ficha.is_personal) return recusa("contato_pessoal");

    const entrada: EntradaDoAgente = {};
    for (const campo of CAMPOS_DO_AGENTE) {
      if (input[campo] !== undefined) entrada[campo] = input[campo];
    }
    // Campo de CONTATO declarado pela organização nos funis é dela (tipo,
    // opções, padrão). Fail-open: falha de leitura devolve lista vazia, e a
    // segunda régua (valor fora do nosso formato) continua valendo.
    const chavesDaOrganizacao = (await defsDoPadraoDaOrg(ctx.supabase, ctx.organizationId, "contato")).map(
      (def) => def.key,
    );
    const plano = gravacaoDoAgente(ficha.custom_fields, entrada, autoriaDoAtor(ctx.actor), chavesDaOrganizacao);
    if (!plano.ok) {
      if (plano.motivo === "valor_invalido") {
        return {
          gravado: false,
          motivo: plano.motivo,
          campo: plano.campo,
          mensagem: `o valor de ${plano.campo} não é válido (vazio, longo demais ou CNPJ inválido); nada foi gravado.`,
        };
      }
      if (plano.motivo === "campo_da_organizacao") {
        return recusa(plano.motivo, { preservados: plano.preservados });
      }
      return recusa(plano.motivo);
    }

    const { data: gravado, error: rpcError } = await ctx.supabase.rpc(FUNCAO_DE_MESCLA, {
      p_org: ctx.organizationId,
      p_contato: input.contact_id,
      p_campos: plano.campos,
      p_remover: plano.remover,
    });
    if (rpcError) throw new Error(`${FUNCAO_DE_MESCLA}: ${rpcError.message}`);
    // Nulo = a linha não casou DENTRO da instrução: o contato foi anonimizado
    // (ou removido) entre a leitura acima e a gravação.
    if (gravado === null || gravado === undefined) return recusa("contato_anonimizado");

    const ator =
      ctx.actor.type === "user"
        ? { actorUserId: ctx.actor.id as string | null, metadata: { actor_type: "user" } }
        : { actorUserId: null, metadata: { actor_type: ctx.actor.type, actor_id: ctx.actor.id } };
    await audit({
      action: "contact.diagnosis_saved",
      actorUserId: ator.actorUserId,
      organizationId: ctx.organizationId,
      resourceType: "contact",
      resourceId: input.contact_id,
      requestId: ctx.requestId,
      // Só os NOMES dos campos: o texto mora na ficha, que a LGPD alcança.
      metadata: {
        ...ator.metadata,
        campos: plano.gravados,
        preservados: plano.preservados,
        escrito_pela_ia: plano.escritoPelaIA,
      },
    });

    return {
      gravado: true,
      campos: plano.gravados,
      ...(plano.preservados.length > 0 ? { preservados: plano.preservados } : {}),
      escrito_pela_ia: plano.escritoPelaIA,
      mensagem:
        "diagnóstico gravado na ficha do contato; a equipe revisa na aba Diagnóstico. " +
        "Não repita este texto ao cliente.",
    };
  },
};
