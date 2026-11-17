/**
 * EDITAR OS ASSISTENTES DE IA PELO MCP — o dono corrigindo, pelo ChatGPT, como
 * o assistente responde: lê as instruções, vê por que uma resposta saiu
 * errada, grava a correção num RASCUNHO, testa, publica, volta atrás.
 *
 * ⚠️ NENHUMA REGRA MORA AQUI. Rascunho, publicação e reversão são
 * `lib/ai/agents/edicao.ts`; o teste é `lib/ai/agents/teste-da-versao.ts` — os
 * mesmos que a tela do assistente usa (as server actions de
 * `app/app/ai/agents/[id]/_actions.ts` e a rota do Testar). Aqui só há tradução
 * de argumento e o recorte do que volta ao modelo.
 *
 * ⚠️ A ORGANIZAÇÃO SAI SEMPRE DE `ctx.organizationId`, NUNCA DO INPUT. O client
 * é service-role; cada consulta filtra `organization_id` à mão.
 *
 * ⚠️ PAPEL: todas pedem `admin` — a mesma régua da tela (`ensureAdmin`) e da
 * rota de publicar. Um assistente nunca chega aqui: o papel dele no turno é
 * `ai_operator`, abaixo de admin.
 *
 * O ator gravado na auditoria é o TOKEN (`ctx.apiTokenId`); numa conexão OAuth
 * (ChatGPT) é a linha "ChatGPT (OAuth)" de API Tokens, criada pela pessoa que
 * autorizou.
 */
import { z } from "zod";

import type { AtorDaEdicao } from "@/lib/ai/agents/edicao";
import { linhaDoRascunhoClonado, VERSION_COLUMNS, type LinhaDaVersao } from "@/lib/ai/agents/linha-da-versao";
import { aplicarConfiguracoes, QUANDO_VOZ } from "@/lib/ai/agents/configuracao-do-rascunho";
import { aplicarEdicaoNoPrompt, explicarRecusa, PROMPT_MAX } from "@/lib/ai/agents/editar-prompt";
import { PROVIDERS, testeHistoryMessageSchema, testRunSchema } from "@/lib/ai/agents/validation";
import { escolherVersoesDaTela } from "@/lib/ai/agents/versoes-da-tela";

import type { McpContext, McpToolDefinition } from "../types";

/**
 * `edicao.ts` e `teste-da-versao.ts` são carregados SOB DEMANDA: eles puxam o
 * motor de IA, que importa a lista de ferramentas MCP — a mesma lista que
 * importa este arquivo. Importados no topo, fechariam um ciclo e a lista
 * nasceria com um buraco. Ver o cabeçalho de `lib/ai/agents/linha-da-versao.ts`.
 */
const carregarEdicao = () => import("@/lib/ai/agents/edicao");
const carregarTeste = () => import("@/lib/ai/agents/teste-da-versao");

interface LinhaDoAgente {
  id: string;
  name: string | null;
  kind: string;
  archived_at: string | null;
  paused_at?: string | null;
  published_version_id: string | null;
}

interface LinhaDaVersaoResumo {
  id: string;
  version_number: number;
  status: string;
  model: string;
  provider: string;
  channel_session_id: string | null;
  voz_enabled: boolean | null;
  voz_quando: string | null;
  created_at: string;
  published_at: string | null;
}

const RESUMO_DA_VERSAO =
  "id, agent_id, version_number, status, model, provider, channel_session_id, voz_enabled, voz_quando, created_at, published_at";

function ator(ctx: McpContext): AtorDaEdicao {
  return { userId: null, apiTokenId: ctx.apiTokenId, requestId: ctx.requestId };
}

async function lerAgentes(ctx: McpContext, ids?: readonly string[]): Promise<LinhaDoAgente[]> {
  let q = ctx.supabase
    .from("ai_agents")
    .select("id, name, kind, archived_at, paused_at, published_version_id")
    .eq("organization_id", ctx.organizationId)
    .order("name", { ascending: true });
  if (ids) q = q.in("id", ids as string[]);
  const { data, error } = await q;
  if (error) throw new Error(`ai_agents: ${error.message}`);
  return (data ?? []) as LinhaDoAgente[];
}

async function versoesDe(
  ctx: McpContext,
  agentIds: readonly string[],
): Promise<Map<string, LinhaDaVersaoResumo[]>> {
  const mapa = new Map<string, LinhaDaVersaoResumo[]>();
  if (agentIds.length === 0) return mapa;
  const { data, error } = await ctx.supabase
    .from("ai_agent_versions")
    .select(RESUMO_DA_VERSAO)
    .eq("organization_id", ctx.organizationId)
    .in("agent_id", agentIds as string[])
    .order("version_number", { ascending: false });
  if (error) throw new Error(`ai_agent_versions: ${error.message}`);
  for (const v of (data ?? []) as Array<LinhaDaVersaoResumo & { agent_id: string }>) {
    const lista = mapa.get(v.agent_id) ?? [];
    lista.push(v);
    mapa.set(v.agent_id, lista);
  }
  return mapa;
}

/** O número de uma versão a partir do id (para dizer "v7", e não um uuid). */
async function numeroDaVersao(ctx: McpContext, versionId: string | null): Promise<number | null> {
  if (!versionId) return null;
  const { data } = await ctx.supabase
    .from("ai_agent_versions")
    .select("version_number")
    .eq("organization_id", ctx.organizationId)
    .eq("id", versionId)
    .maybeSingle();
  return (data as { version_number?: number } | null)?.version_number ?? null;
}

/** "rascunho" | "publicada" | número → a linha da versão daquele agente. */
const seletorDeVersao = z
  .union([z.literal("rascunho"), z.literal("publicada"), z.number().int().min(1)])
  .describe('Which version: "rascunho" (current draft), "publicada" (live) or a version number.');

async function resolverVersao(
  ctx: McpContext,
  agente: LinhaDoAgente,
  seletor: "rascunho" | "publicada" | number,
): Promise<LinhaDaVersaoResumo | null> {
  const versoes = (await versoesDe(ctx, [agente.id])).get(agente.id) ?? [];
  if (typeof seletor === "number") return versoes.find((v) => v.version_number === seletor) ?? null;
  const escolha = escolherVersoesDaTela(versoes, agente.published_version_id ?? null);
  return seletor === "rascunho" ? escolha.draft : escolha.published;
}

async function canais(ctx: McpContext, ids: readonly string[]): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const unicos = [...new Set(ids.filter(Boolean))];
  if (unicos.length === 0) return mapa;
  const { data } = await ctx.supabase
    .from("channel_sessions")
    .select("id, display_name, phone_number, provider")
    .eq("organization_id", ctx.organizationId)
    .in("id", unicos);
  for (const c of (data ?? []) as Array<{ id: string; display_name: string | null; phone_number: string | null; provider: string | null }>) {
    mapa.set(c.id, [c.display_name, c.phone_number, c.provider].filter(Boolean).join(" · "));
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// crm_list_ai_agents
// ---------------------------------------------------------------------------

const listShape = {
  incluir_arquivados: z.boolean().optional().describe("Also list archived assistants. Default false."),
};

export const crmListAiAgents: McpToolDefinition<typeof listShape> = {
  name: "crm_list_ai_agents",
  description:
    "Lists the organization's AI assistants (agents): id, name, the channel/number each one answers, the LIVE " +
    "(published) version number and model, and whether there is a DRAFT version being prepared. Use the ids " +
    "with crm_get_ai_agent_version, crm_save_ai_agent_draft, crm_test_ai_agent_version and crm_publish_ai_agent_version.",
  inputSchema: listShape,
  category: "read",
  requiresRole: "admin",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const agentes = (await lerAgentes(ctx)).filter((a) => input.incluir_arquivados || !a.archived_at);
    const versoes = await versoesDe(ctx, agentes.map((a) => a.id));
    const todos = agentes.flatMap((a) => versoes.get(a.id) ?? []);
    const nomesDeCanal = await canais(ctx, todos.map((v) => v.channel_session_id ?? ""));
    return {
      assistentes: agentes.map((a) => {
        const { draft, published, draftObsoleto } = escolherVersoesDaTela(
          versoes.get(a.id) ?? [],
          a.published_version_id ?? null,
        );
        const vigente = published ?? draft;
        return {
          id: a.id,
          nome: a.name,
          tipo: a.kind,
          arquivado: Boolean(a.archived_at),
          pausado: Boolean(a.paused_at),
          canal: vigente?.channel_session_id ? (nomesDeCanal.get(vigente.channel_session_id) ?? null) : null,
          publicada: published
            ? {
                versao: published.version_number,
                modelo: published.model,
                voz: published.voz_enabled ? published.voz_quando : "nunca",
                publicada_em: published.published_at,
              }
            : null,
          rascunho: draft ? { versao: draft.version_number, criado_em: draft.created_at } : null,
          rascunho_superado: draftObsoleto ? draftObsoleto.version_number : null,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// crm_get_ai_agent_version
// ---------------------------------------------------------------------------

const getVersionShape = {
  agent_id: z.string().uuid(),
  versao: seletorDeVersao.default("publicada"),
};

export const crmGetAiAgentVersion: McpToolDefinition<typeof getVersionShape> = {
  name: "crm_get_ai_agent_version",
  description:
    "Reads ONE version of an AI assistant: the full instructions text (system_prompt) and its settings (model, " +
    'channel, tools, voice, handoff). versao = "publicada" (live, default), "rascunho" (current draft) or a number. ' +
    "Read this before proposing an edit, and copy excerpts EXACTLY into crm_save_ai_agent_draft substituicoes.",
  inputSchema: getVersionShape,
  category: "read",
  requiresRole: "admin",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const [agente] = await lerAgentes(ctx, [input.agent_id]);
    if (!agente) return { erro: "assistente_nao_encontrado", mensagem: "No assistant with this id in this organization." };
    const alvo = await resolverVersao(ctx, agente, input.versao);
    if (!alvo) {
      return {
        erro: "versao_nao_encontrada",
        mensagem: `This assistant has no ${typeof input.versao === "number" ? `version ${input.versao}` : input.versao} version.`,
      };
    }
    const { data, error } = await ctx.supabase
      .from("ai_agent_versions")
      .select(VERSION_COLUMNS)
      .eq("organization_id", ctx.organizationId)
      .eq("id", alvo.id)
      .maybeSingle();
    if (error || !data) return { erro: "versao_nao_encontrada", mensagem: "Version could not be read." };
    const v = data as unknown as LinhaDaVersao & { version_number: number; status: string; published_at: string | null };
    const nomeDoCanal = v.channel_session_id ? (await canais(ctx, [v.channel_session_id])).get(v.channel_session_id) : null;
    return {
      assistente: { id: agente.id, nome: agente.name },
      versao: v.version_number,
      estado: agente.published_version_id === alvo.id ? "publicada" : v.status === "draft" ? "rascunho" : v.status,
      instrucoes: v.system_prompt,
      tamanho_das_instrucoes: v.system_prompt.length,
      limite_de_tamanho: PROMPT_MAX,
      modelo: v.model,
      provedor: v.provider,
      canal: nomeDoCanal ?? null,
      ferramentas: v.tool_ids ?? [],
      voz: { ligada: v.voz_enabled, quando: v.voz_quando },
      passar_para_humano: {
        palavras: v.handoff_keywords ?? [],
        pode_chamar_humano: v.handoff_tool_enabled,
        assunto_juridico: v.handoff_legal_enabled,
      },
      dividir_mensagens: { ligado: v.split_messages, tamanho_maximo_da_parte: v.split_max_chars },
      ver_imagens: v.image_vision_enabled ?? true,
      publicada_em: v.published_at,
    };
  },
};

// ---------------------------------------------------------------------------
// crm_get_ai_agent_turn
// ---------------------------------------------------------------------------

const turnShape = {
  conversation_id: z.string().uuid().describe("The conversation where the reply happened (from crm_list_conversations)."),
  limite: z.number().int().min(1).max(10).default(3).describe("How many of the latest assistant turns to return."),
};

export const crmGetAiAgentTurn: McpToolDefinition<typeof turnShape> = {
  name: "crm_get_ai_agent_turn",
  description:
    "Explains the assistant's latest replies in ONE conversation: for each recent AI turn, which assistant and which " +
    "VERSION of the instructions answered, the model, the tools it called (ok/failed/blocked), whether the turn was " +
    "aborted and why, plus the AI messages sent around that time. Use it to find why a reply was wrong before " +
    "proposing a fix with crm_save_ai_agent_draft.",
  inputSchema: turnShape,
  category: "read",
  requiresRole: "admin",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data: conversa } = await ctx.supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (!conversa) return { erro: "conversa_nao_encontrada", mensagem: "No conversation with this id in this organization." };

    const { data: tracos, error } = await ctx.supabase
      .from("agent_turn_traces")
      .select(
        "id, created_at, agent_id, agent_version_id, status, abort_reason, error_code, provider, model, messages_sent, ferramentas, skills, historico_mensagens, latency_ms",
      )
      .eq("organization_id", ctx.organizationId)
      .eq("conversation_id", input.conversation_id)
      .eq("is_dry_run", false)
      .order("created_at", { ascending: false })
      .limit(input.limite);
    if (error) return { erro: "falha_na_leitura", mensagem: error.message };

    const linhas = (tracos ?? []) as Array<{
      id: string;
      created_at: string;
      agent_id: string | null;
      agent_version_id: string | null;
      status: string;
      abort_reason: string | null;
      error_code: string | null;
      provider: string | null;
      model: string | null;
      messages_sent: number;
      ferramentas: unknown;
      skills: unknown;
      historico_mensagens: number | null;
      latency_ms: number;
    }>;

    const agentes = await lerAgentes(ctx, [...new Set(linhas.map((l) => l.agent_id).filter((x): x is string => !!x))]);
    const nomes = new Map(agentes.map((a) => [a.id, a.name]));
    const versaoIds = [...new Set(linhas.map((l) => l.agent_version_id).filter((x): x is string => !!x))];
    const numeros = new Map<string, number>();
    if (versaoIds.length) {
      const { data } = await ctx.supabase
        .from("ai_agent_versions")
        .select("id, version_number")
        .eq("organization_id", ctx.organizationId)
        .in("id", versaoIds);
      for (const v of (data ?? []) as Array<{ id: string; version_number: number }>) numeros.set(v.id, v.version_number);
    }

    const { data: mensagens } = await ctx.supabase
      .from("messages")
      .select("id, created_at, direction, sent_via, body, type")
      .eq("organization_id", ctx.organizationId)
      .eq("conversation_id", input.conversation_id)
      .order("created_at", { ascending: false })
      .limit(Math.min(40, input.limite * 8));

    return {
      turnos: linhas.map((l) => ({
        quando: l.created_at,
        assistente: l.agent_id ? { id: l.agent_id, nome: nomes.get(l.agent_id) ?? null } : null,
        versao_das_instrucoes: l.agent_version_id ? (numeros.get(l.agent_version_id) ?? null) : null,
        modelo: l.model,
        estado: l.status,
        motivo_de_interrupcao: l.abort_reason,
        codigo_de_erro: l.error_code,
        mensagens_enviadas: l.messages_sent,
        ferramentas: l.ferramentas,
        habilidades: l.skills,
        mensagens_de_historico_lidas: l.historico_mensagens,
        duracao_ms: l.latency_ms,
      })),
      mensagens_recentes: ((mensagens ?? []) as Array<{
        id: string;
        created_at: string;
        direction: string;
        sent_via: string;
        body: string | null;
        type: string;
      }>)
        .reverse()
        .map((m) => ({
          id: m.id,
          quando: m.created_at,
          de: m.direction === "inbound" ? "cliente" : m.sent_via === "ai" ? "assistente" : m.sent_via,
          tipo: m.type,
          texto: m.body ? m.body.slice(0, 1500) : null,
        })),
    };
  },
};

// ---------------------------------------------------------------------------
// crm_save_ai_agent_draft
// ---------------------------------------------------------------------------

const substituicaoShape = z
  .object({
    procurar: z.string().min(1).max(5000).describe("Exact excerpt of the CURRENT instructions to replace (copy it verbatim)."),
    substituir_por: z.string().max(PROMPT_MAX).describe("New text. Empty string deletes the excerpt."),
    todas: z.boolean().optional().describe("Replace every occurrence. Without it, the excerpt must appear exactly once."),
  })
  .strict();

const saveDraftShape = {
  agent_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(5)
    .describe("One or more assistants. The same edit is applied to each, each in its OWN draft."),
  novo_prompt: z.string().min(10).max(PROMPT_MAX).optional().describe("The WHOLE new instructions text. Excludes substituicoes/anexar_ao_final."),
  substituicoes: z.array(substituicaoShape).min(1).max(20).optional().describe("Targeted find/replace edits, applied in order."),
  anexar_ao_final: z.string().min(1).max(5000).optional().describe("Text appended at the end of the instructions."),
  configuracoes: z
    .object({
      provedor: z.enum(PROVIDERS).optional().describe("AI provider. Omit to keep the current one."),
      modelo: z.string().trim().min(1).max(120).optional().describe("Model id, e.g. claude-sonnet-5-5. Must belong to the provider."),
      voz_ligada: z.boolean().optional().describe("Voice replies on/off."),
      voz_quando: z.enum(QUANDO_VOZ).optional().describe('When to reply by voice: "nunca", "espelhar" (when the customer sends audio), "sempre", "quando_pede".'),
      ferramentas_adicionar: z.array(z.string().min(1).max(120)).max(27).optional().describe("Tool ids to give the assistant."),
      ferramentas_remover: z.array(z.string().min(1).max(120)).max(27).optional().describe("Tool ids to take away."),
      palavras_para_humano: z.array(z.string().trim().min(1).max(60)).max(20).optional().describe("Words that hand the chat to a person (replaces the list)."),
      pode_chamar_humano: z.boolean().optional().describe("Whether the assistant may decide to hand over to a person."),
      assunto_juridico_para_humano: z.boolean().optional().describe("Hand over to a person on legal matters."),
      dividir_mensagens: z.boolean().optional().describe("Split long replies into several messages."),
      tamanho_maximo_da_parte: z.number().int().min(80).max(4000).optional().describe("Max characters per split part."),
      ver_imagens: z.boolean().optional().describe("Whether the assistant looks at images customers send."),
    })
    .strict()
    .optional()
    .describe("Assistant SETTINGS to change in the same draft. Channel/number, AI key, funnels and knowledge are not changeable here."),
};

export const crmSaveAiAgentDraft: McpToolDefinition<typeof saveDraftShape> = {
  name: "crm_save_ai_agent_draft",
  description:
    "Saves a correction to an AI assistant's instructions and/or SETTINGS as a DRAFT. NOTHING changes for customers " +
    "until the draft is published. The edit starts from the assistant's current draft if one exists (so other pending " +
    "draft work is kept), otherwise from the live version; anything not mentioned is copied unchanged. Settings " +
    "(configuracoes): model, voice, tools, hand-over-to-person words, message splitting, image reading. " +
    "Prefer targeted edits: substituicoes (exact find/replace, refused if the excerpt is missing or ambiguous) and/or " +
    "anexar_ao_final. Use novo_prompt only to replace the whole text. Several agent_ids apply the same edit to each " +
    "assistant separately; a failure on one does not block the others. After saving, test with crm_test_ai_agent_version.",
  inputSchema: saveDraftShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const temEdicaoDeTexto =
      input.novo_prompt !== undefined || (input.substituicoes?.length ?? 0) > 0 || input.anexar_ao_final !== undefined;
    if (!temEdicaoDeTexto && !input.configuracoes) {
      return { erro: "pedido_vazio", mensagem: "Nothing to change: send an instructions edit and/or configuracoes." };
    }
    const ids = [...new Set(input.agent_ids)];
    const agentes = new Map((await lerAgentes(ctx, ids)).map((a) => [a.id, a]));
    const versoes = await versoesDe(ctx, ids);

    const resultados = [];
    for (const id of ids) {
      const agente = agentes.get(id);
      if (!agente) {
        resultados.push({ agent_id: id, ok: false, erro: "assistente_nao_encontrado" });
        continue;
      }
      const { base, draft } = escolherVersoesDaTela(versoes.get(id) ?? [], agente.published_version_id ?? null);
      if (!base) {
        resultados.push({ agent_id: id, nome: agente.name, ok: false, erro: "sem_versao", mensagem: "This assistant has no version to start from." });
        continue;
      }
      const { data: linha } = await ctx.supabase
        .from("ai_agent_versions")
        .select(VERSION_COLUMNS)
        .eq("organization_id", ctx.organizationId)
        .eq("id", base.id)
        .maybeSingle();
      if (!linha) {
        resultados.push({ agent_id: id, nome: agente.name, ok: false, erro: "versao_nao_encontrada" });
        continue;
      }
      const src = linha as unknown as LinhaDaVersao;
      let texto = src.system_prompt;
      let aplicadas: Array<{ procurar: string; ocorrencias: number }> = [];
      if (temEdicaoDeTexto) {
        const edicao = aplicarEdicaoNoPrompt(src.system_prompt, input);
        if (!edicao.ok) {
          resultados.push({ agent_id: id, nome: agente.name, ok: false, erro: edicao.motivo, mensagem: explicarRecusa(edicao) });
          continue;
        }
        texto = edicao.texto;
        aplicadas = edicao.aplicadas;
      }
      let alvo: LinhaDaVersao = { ...src, system_prompt: texto };
      let mudancasDeConfiguracao: string[] = [];
      if (input.configuracoes) {
        const cfg = aplicarConfiguracoes(alvo, input.configuracoes);
        if (!cfg.ok) {
          resultados.push({ agent_id: id, nome: agente.name, ok: false, erro: cfg.motivo, mensagem: cfg.mensagem });
          continue;
        }
        alvo = cfg.linha;
        mudancasDeConfiguracao = cfg.mudancas;
        if (!temEdicaoDeTexto && mudancasDeConfiguracao.length === 0) {
          resultados.push({ agent_id: id, nome: agente.name, ok: false, erro: "sem_mudanca", mensagem: "These settings are already in place." });
          continue;
        }
      }
      const salvo = await (await carregarEdicao()).salvarRascunhoDaVersao(ctx.supabase, {
        orgId: ctx.organizationId,
        agentId: id,
        payload: linhaDoRascunhoClonado(alvo),
        ator: ator(ctx),
      });
      if (!salvo.ok) {
        resultados.push({
          agent_id: id,
          nome: agente.name,
          ok: false,
          erro: salvo.error,
          mensagem: salvo.message ?? "The draft could not be saved.",
          ...(salvo.details ? { detalhes: salvo.details } : {}),
        });
        continue;
      }
      resultados.push({
        agent_id: id,
        nome: agente.name,
        ok: true,
        rascunho: { versao: salvo.data.version_number, criado_agora: salvo.data.criada },
        partiu_de: { versao: base.version_number, era: draft && draft.id === base.id ? "rascunho" : "publicada" },
        mudancas: aplicadas,
        configuracoes_alteradas: mudancasDeConfiguracao,
        tamanho: { antes: src.system_prompt.length, depois: texto.length },
      });
    }

    const algumOk = resultados.some((r) => r.ok);
    if (!algumOk) {
      const primeiro = resultados[0] as { erro?: string; mensagem?: string } | undefined;
      return {
        erro: primeiro?.erro ?? "nada_salvo",
        mensagem: primeiro?.mensagem ?? "No draft was saved.",
        resultados,
      };
    }
    return {
      resultados,
      aviso: "Saved as DRAFT only — customers still get the live version. Test it, then publish only after the owner confirms.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_test_ai_agent_version
// ---------------------------------------------------------------------------

const testShape = {
  agent_id: z.string().uuid(),
  versao: seletorDeVersao.default("rascunho"),
  mensagem: z.string().trim().min(1).max(4000).describe("The customer message to simulate."),
  historico: z
    .array(testeHistoryMessageSchema)
    .max(30)
    .optional()
    .describe('Earlier messages of the simulated conversation, oldest first: {direction: "inbound"|"outbound", body}.'),
};

export const crmTestAiAgentVersion: McpToolDefinition<typeof testShape> = {
  name: "crm_test_ai_agent_version",
  description:
    "Simulates a customer message against a version of an AI assistant (default: the current DRAFT) and returns what " +
    "it WOULD reply, the tools it would call and the safety checks verdict. Nothing is sent to anyone and no " +
    "customer data changes; it spends model credits. This is the same test as the assistant page's Testar button.",
  inputSchema: testShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const [agente] = await lerAgentes(ctx, [input.agent_id]);
    if (!agente) return { erro: "assistente_nao_encontrado", mensagem: "No assistant with this id in this organization." };
    const alvo = await resolverVersao(ctx, agente, input.versao);
    if (!alvo) {
      return {
        erro: "versao_nao_encontrada",
        mensagem:
          input.versao === "rascunho"
            ? "This assistant has no draft. Save one with crm_save_ai_agent_draft, or test versao=\"publicada\"."
            : "Version not found for this assistant.",
      };
    }
    const pedido = testRunSchema.safeParse({ sample_message: input.mensagem, history: input.historico });
    if (!pedido.success) return { erro: "pedido_invalido", mensagem: pedido.error.issues.map((i) => i.message).join("; ") };

    const r = await (await carregarTeste()).testarVersaoDoAgente(ctx.supabase, {
      orgId: ctx.organizationId,
      agentId: agente.id,
      versionId: alvo.id,
      pedido: pedido.data,
      ator: ator(ctx),
    });
    if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem };
    const d = r.data as {
      status?: string;
      final_text?: string;
      tool_calls?: unknown;
      ferramentas?: unknown;
      guardrails?: unknown;
      latency_ms?: number;
      run_id?: string;
    };
    return {
      assistente: { id: agente.id, nome: agente.name },
      versao: alvo.version_number,
      estado: d.status,
      resposta: d.final_text ?? "",
      ferramentas_chamadas: d.ferramentas ?? [],
      acoes_propostas: d.tool_calls ?? [],
      avaliacao_da_resposta: d.guardrails ?? null,
      duracao_ms: d.latency_ms,
      teste_id: d.run_id,
      aviso: "Simulation only — nothing was sent to any customer.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_publish_ai_agent_version
// ---------------------------------------------------------------------------

const publishShape = {
  agent_id: z.string().uuid(),
  versao: z.number().int().min(1).describe("The version NUMBER to publish (usually the draft number). Required on purpose — never implied."),
};

export const crmPublishAiAgentVersion: McpToolDefinition<typeof publishShape> = {
  name: "crm_publish_ai_agent_version",
  description:
    "HIGH RISK. Publishes a version of an AI assistant: from the NEXT customer message on, customers are answered " +
    "with these instructions. Always show the owner what changed and get an explicit confirmation BEFORE calling " +
    "this. Runs the same checks as the assistant page (credential, channel, model, tools). Returns the published and " +
    "the previous version numbers, so the change can be undone with crm_rollback_ai_agent.",
  inputSchema: publishShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const [agente] = await lerAgentes(ctx, [input.agent_id]);
    if (!agente) return { erro: "assistente_nao_encontrado", mensagem: "No assistant with this id in this organization." };
    const alvo = await resolverVersao(ctx, agente, input.versao);
    if (!alvo) return { erro: "versao_nao_encontrada", mensagem: `Version ${input.versao} not found for this assistant.` };
    if (agente.published_version_id === alvo.id) {
      return { erro: "ja_publicada", mensagem: `Version ${input.versao} is already the live version.` };
    }
    const r = await (await carregarEdicao()).publicarVersao(ctx.supabase, {
      orgId: ctx.organizationId,
      agentId: agente.id,
      versionId: alvo.id,
      ator: ator(ctx),
    });
    if (!r.ok) return { erro: r.error, mensagem: r.message ?? `Publishing was refused (${r.error}).`, ...(r.details ? { detalhes: r.details } : {}) };
    return {
      assistente: { id: agente.id, nome: agente.name },
      publicada: input.versao,
      anterior: await numeroDaVersao(ctx, r.data.previous_version_id),
      publicada_em: r.data.published_at,
      aviso: "Live now. To undo, call crm_rollback_ai_agent with para_versao = the previous version.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_rollback_ai_agent
// ---------------------------------------------------------------------------

const rollbackShape = {
  agent_id: z.string().uuid(),
  para_versao: z.number().int().min(1).describe("The earlier version NUMBER to bring back."),
};

export const crmRollbackAiAgent: McpToolDefinition<typeof rollbackShape> = {
  name: "crm_rollback_ai_agent",
  description:
    "HIGH RISK. Brings an earlier version of an AI assistant back to live: copies that version into a new version " +
    "and publishes it (history is kept; nothing is deleted). Get an explicit confirmation from the owner BEFORE " +
    "calling this. Same checks as the assistant page's Revert button.",
  inputSchema: rollbackShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const [agente] = await lerAgentes(ctx, [input.agent_id]);
    if (!agente) return { erro: "assistente_nao_encontrado", mensagem: "No assistant with this id in this organization." };
    const origem = await resolverVersao(ctx, agente, input.para_versao);
    if (!origem) return { erro: "versao_nao_encontrada", mensagem: `Version ${input.para_versao} not found for this assistant.` };
    const r = await (await carregarEdicao()).reverterParaVersao(ctx.supabase, {
      orgId: ctx.organizationId,
      agentId: agente.id,
      versionId: origem.id,
      ator: ator(ctx),
    });
    if (!r.ok) return { erro: r.error, mensagem: r.message ?? `Rollback was refused (${r.error}).`, ...(r.details ? { detalhes: r.details } : {}) };
    return {
      assistente: { id: agente.id, nome: agente.name },
      copiada_de: input.para_versao,
      nova_versao_publicada: r.data.new_version_number,
      anterior: await numeroDaVersao(ctx, r.data.previous_version_id),
      aviso: "Live now with the instructions of the earlier version.",
    };
  },
};
