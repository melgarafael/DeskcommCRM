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
 * importa nada de lá, e `tests/unit/diagnostico-pela-ia.test.tsx` vigia isso.
 *
 * ── Por que mescla NO BANCO ─────────────────────────────────────────────────
 *
 * O `PATCH /api/v1/contacts/:id` substitui `custom_fields` inteiro, e ler para
 * gravar depois (como a aba faz) apaga o que outro caminho gravou no meio. Aqui
 * a escrita é `custom_fields || pedaço` dentro de UMA instrução
 * (`fn_contato_anotar_campos`, migration 9398): os `link_*`, os campos da
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
 * - O que a EQUIPE escreveu: diagnóstico assinado por uma pessoa não é
 *   sobrescrito por quem não é pessoa (`gravacaoDoAgente`). "Editável pela
 *   equipe" (D7) não pode virar "a equipe perde o que escreveu a cada turno".
 * - Token de integração: gravar direto na ficha exige `contacts:write`, além do
 *   `mcp:write`. A decisão D7 (gravar direto) vale para o agente da casa; um
 *   integrador sem esse escopo não grava direto, que é a régua que o PR #4534
 *   põe no `crm_update_contact`.
 * - Campos da organização: a leitura das definições FECHA na falha. Numa
 *   escrita que grava direto, seguir sem saber quais chaves são da organização
 *   deixaria o modelo sobrescrever, com texto livre, um campo dela.
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
import { defsDoPadraoDoFunil } from "@/lib/leads/padrao-do-campo";

import { McpAuthError } from "../auth";
import type { McpContext, McpToolDefinition } from "../types";

/** A função do banco que mescla `custom_fields` numa instrução só. */
export const FUNCAO_DE_MESCLA = "fn_contato_anotar_campos";

/**
 * O escopo que um TOKEN DE INTEGRAÇÃO precisa para gravar direto na ficha. É o
 * `contacts:write` ("Criar e editar contatos") que a tela de tokens já oferece.
 *
 * Fica aqui, e não num módulo compartilhado, porque o PR #4534 cria
 * `lib/api/escopos-do-token.ts` (`ESCOPO_CONTATOS_ESCRITA`) e
 * `lib/mcp/escopo-do-token.ts` (`exigeEscopoDoTokenDeIntegracao`) com esta mesma
 * régua: criar os dois arquivos aqui daria conflito de "adicionado dos dois
 * lados". Quando os dois PRs estiverem na `main`, esta função vira uma chamada
 * àquela.
 */
export const ESCOPO_DA_FICHA = "contacts:write";

/**
 * `ctx.tokenScopes` só existe no MCP externo (`lib/mcp/server.ts`); o agente da
 * casa monta o contexto sem ele e não paga este escopo. Não se usa
 * `actor.type`: um token com `actor:ai_agent` vira `ai_agent` e passaria batido.
 */
export function exigeEscopoDaFicha(ctx: Pick<McpContext, "tokenScopes">): void {
  if (ctx.tokenScopes === undefined) return;
  if (ctx.tokenScopes.includes(ESCOPO_DA_FICHA)) return;
  throw new McpAuthError(-32002, 403, `Token missing required scope '${ESCOPO_DA_FICHA}'.`, "forbidden_role");
}

/**
 * As chaves dos campos de CONTATO que a organização declarou nos funis, ou
 * `null` quando a leitura falha. É a mesma leitura de `defsDoPadraoDaOrg`, que
 * é fail-open de propósito para as rotas; aqui a falha precisa ser vista.
 */
async function chavesDaOrganizacao(ctx: McpContext): Promise<string[] | null> {
  try {
    const { data, error } = await ctx.supabase
      .from("crm_pipelines")
      .select("settings")
      .eq("organization_id", ctx.organizationId)
      .order("created_at", { ascending: true });
    if (error || !Array.isArray(data)) return null;
    return (data as Array<{ settings?: unknown }>)
      .flatMap((linha) => defsDoPadraoDoFunil(linha?.settings, "contato"))
      .map((def) => def.key);
  } catch {
    return null;
  }
}

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
    "esses campos foram configurados pela equipe desta conta e esta ferramenta não os preenche; nada foi gravado.",
  escrito_pela_equipe:
    "o diagnóstico desta ficha foi escrito por uma pessoa da equipe e fica como está; nada foi gravado. " +
    "Não tente gravar de novo os campos listados em preservados.",
  indisponivel:
    "não foi possível conferir os campos configurados nesta conta agora; nada foi gravado. Tente de novo mais tarde.",
} as const;

function recusa(motivo: keyof typeof RECUSAS, extra: Record<string, unknown> = {}) {
  return { gravado: false, motivo, ...extra, mensagem: RECUSAS[motivo] };
}

export const crmSaveLeadDiagnosis: McpToolDefinition<typeof diagnosticoShape> = {
  name: "crm_save_lead_diagnosis",
  description:
    "Grava na ficha do contato desta conversa o que você concluiu sobre a empresa (pelo site, pelas " +
    "redes ou pela conversa): segmento, CNPJ, resumo (o que ela faz e onde perde venda) e oferta " +
    "sugerida. Grava direto, com o selo Escrito pela IA; a equipe revisa na aba Diagnóstico. Mande só " +
    "os campos que você concluiu; os outros não mudam. Não use para dados pessoais do cliente (nome, " +
    "telefone, e-mail) nem para copiar a fala dele: grave a sua conclusão.",
  inputSchema: diagnosticoShape,
  category: "write",
  // Paridade com `PATCH /api/v1/contacts/:id` (`requireRole("agent")`): editar
  // a ficha é trabalho de quem atende.
  requiresRole: "agent",
  requiresScope: "mcp:write",
  redigirParaAuditoria,
  handler: async (input, ctx) => {
    exigeEscopoDaFicha(ctx);
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
    // opções, padrão). Fecha na falha: sem saber quais chaves são dela, não grava.
    const daOrganizacao = await chavesDaOrganizacao(ctx);
    if (daOrganizacao === null) return recusa("indisponivel");
    const plano = gravacaoDoAgente(ficha.custom_fields, entrada, autoriaDoAtor(ctx.actor), daOrganizacao);
    if (!plano.ok) {
      if (plano.motivo === "valor_invalido") {
        return {
          gravado: false,
          motivo: plano.motivo,
          campo: plano.campo,
          mensagem: `o valor de ${plano.campo} não é válido (vazio, longo demais ou CNPJ inválido); nada foi gravado.`,
        };
      }
      if (plano.motivo === "campo_da_organizacao" || plano.motivo === "escrito_pela_equipe") {
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
        preservados_pela_equipe: plano.daEquipe,
        escrito_pela_ia: plano.escritoPelaIA,
      },
    });

    return {
      gravado: true,
      campos: plano.gravados,
      ...(plano.preservados.length > 0 ? { preservados: plano.preservados } : {}),
      ...(plano.daEquipe.length > 0 ? { preservados_pela_equipe: plano.daEquipe } : {}),
      escrito_pela_ia: plano.escritoPelaIA,
      // Gravação parcial não pode soar como total: sem a frase do meio, o modelo
      // lê "gravado" e acha que o resumo preservado pela equipe é o dele.
      mensagem:
        "os campos listados em campos foram gravados na ficha do contato; a equipe revisa na aba Diagnóstico. " +
        (plano.preservados.length > 0
          ? "Os campos listados em preservados ficaram como estavam; não tente gravá-los de novo. "
          : "") +
        "Não repita este texto ao cliente.",
    };
  },
};
