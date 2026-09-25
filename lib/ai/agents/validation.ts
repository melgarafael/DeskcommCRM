/**
 * Zod schemas + cross-reference validators for the AI Agents module (mcp_agent kind).
 * Spec 10 §3.2 + §4.3 + §4.5.
 *
 * Convention: "shape" schemas (no business rules) ship from here; cross-row
 * checks (credential.validated_at, channel_session.status, model exists) live
 * in `validateVersionReferences` and run BEFORE save AND inside the publish
 * Postgres function (defense in depth).
 */
import { z } from "zod";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";

/**
 * Derivado de `lib/ai/pontos/provedores.ts` (a lista única desde a 0127). Como
 * cópia à mão, esta constante mantinha `agent_turn`/`operator_turn` fora do
 * alcance da OpenRouter — justamente os dois pontos que a abertura do
 * vocabulário existia para atender.
 */
export const PROVIDERS = IDS_DE_PROVEDOR;
export type Provider = (typeof PROVIDERS)[number];

const UUID = z.string().uuid();

const triggerConfigSchema = z
  .object({
    events: z.array(z.enum(["message"])).default(["message"]),
    filters: z
      .object({
        ignore_groups: z.boolean().default(true),
        ignore_self: z.boolean().default(true),
        keyword_regex: z.string().nullable().optional().default(null),
        business_hours: z
          .object({
            timezone: z.string(),
            start: z.string(),
            end: z.string(),
            weekdays: z.array(z.number().int().min(0).max(6)),
          })
          .nullable()
          .optional()
          .default(null),
      })
      .default({ ignore_groups: true, ignore_self: true, keyword_regex: null, business_hours: null }),
    concurrency: z.enum(["one_per_conversation", "one_per_contact"]).default("one_per_conversation"),
  })
  .strict();

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Janela PROATIVA do follow-up. O fuso não é configurável aqui: quem executa
 * sempre usa `organizations.timezone`, para a faixa acompanhar o relógio da
 * empresa e não o knob anti-ban do número.
 */
const followupSendWindowSchema = z
  .object({
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  })
  .strict()
  .refine((window) => window.end > window.start, {
    path: ["end"],
    message: "followup_window_end_must_be_after_start",
  });

// Task 7.2 — vínculo do agente com fluxos de follow-up publicados. Aditivo:
// `.default(...)` faz agents/versions existentes (sem este campo no payload)
// continuarem válidos, lidos com enabled=false/[] (comportamento inalterado).
// `flow_pointer_ids` referencia `followup_flow_pointers.id` — sem FK real de
// array no Postgres (mesma doutrina de `tool_ids`: domínio validado em app,
// não em constraint de banco).
//
// #490 acrescenta `send_window`: `null` preserva o comportamento histórico; uma
// faixa limita SOMENTE envios proativos, sem tocar o horário do inbound.
const followupConfigObjectSchema = z
  .object({
    enabled: z.boolean().default(false),
    flow_pointer_ids: z.array(UUID).max(20).default([]),
    send_window: followupSendWindowSchema.nullable().optional().default(null),
  })
  .strict();

const followupConfigSchema = followupConfigObjectSchema.default({
  enabled: false,
  flow_pointer_ids: [],
  send_window: null,
});

const followupPatchSchema = followupConfigObjectSchema
  .extend({
    enabled: followupConfigObjectSchema.shape.enabled.removeDefault(),
    flow_pointer_ids: followupConfigObjectSchema.shape.flow_pointer_ids.removeDefault(),
    send_window: followupConfigObjectSchema.shape.send_window.removeDefault(),
  })
  .partial();

export type FollowupConfig = z.infer<typeof followupConfigSchema>;

const versionShapeSchema = z
  .object({
    system_prompt: z.string().trim().min(10).max(20000),
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1).max(120),
    /**
     * `null` = usar a chave que veio na INSTALAÇÃO.
     *
     * Era UUID obrigatório, e isso trancava a porta para o cenário mais comum do
     * produto: quem instala pelo kit cola a chave no `.env` e nunca abre a tela
     * de Credenciais — não existe uma única linha em `ai_provider_credentials`.
     * O runtime SEMPRE soube lidar com isso (`chaveDePlataforma` em
     * `lib/ai/runtime/agent.ts`, mesma precedência de `resolveOrgLlmConfig`); só
     * o editor não deixava salvar. O efeito: o agente do onboarding tinha de
     * nascer `rag_bot`, no editor legado, e as capacidades ficavam invisíveis
     * para o dono.
     *
     * ⚠️ QUEM ACEITA `null` PRECISA CONFERIR QUE A CHAVE EXISTE. O schema é de
     * FORMA, não de ambiente: nulo aqui significa "usa a da instalação", e se ela
     * não existir o agente é publicado para morrer em toda mensagem. A guarda
     * mora na rota de versões, que é quem conhece o `process.env` do servidor.
     */
    credential_id: UUID.nullable(),
    tool_ids: z
      .array(z.string().min(1).max(80))
      // O mesmo teto que a tela mostra ("13 de 20") é o que o servidor recusa —
      // ver `lib/mcp/tools/selecao-por-pacote.ts` para o porquê do número.
      .max(TETO_TOOLS_POR_AGENTE)
      .default([])
      .refine(
        (ids) => ids.every((id) => (VALID_TOOL_IDS as readonly string[]).includes(id)),
        { message: "tool_id_invalid" },
      ),
    trigger_config: triggerConfigSchema.optional(),
    /**
     * Por qual número o agente atende. `null` = AINDA NÃO ESCOLHIDO.
     *
     * Era UUID obrigatório, e isso trancava o caminho mais comum de uma
     * instalação nova: o dono escreve o prompt do atendente ANTES de conectar o
     * WhatsApp (pareia o aparelho outro dia, com o celular na mão). Sem número
     * em `channel_sessions`, o editor não deixava salvar uma linha do que ele
     * acabou de escrever — a tela exigia escolher de uma lista vazia.
     *
     * ⚠️ NULO RASCUNHA, NÃO ATENDE. Publicar sem número continua recusado, e em
     * três camadas independentes: `bloqueioDePublicacao` desabilita o botão,
     * `fn_publish_ai_agent_version` levanta `channel_session_not_found` (o
     * `select` por `channel_session_id` nulo não acha linha), e o runtime resolve
     * o agente por `published_version_id` — sem publicação, ninguém o executa.
     */
    channel_session_id: UUID.nullable(),
    max_steps: z.number().int().min(1).max(25).default(10),
    token_budget: z.number().int().min(1000).max(500000).default(50000),
    cost_budget_cents: z.number().int().min(1).max(10000).default(50),
    history_message_window: z.number().int().min(0).max(200).default(20),
    history_token_window: z.number().int().min(0).max(50000).default(8000),
    handoff_keywords: z
      .array(z.string().trim().min(1).max(60))
      .max(20)
      .default(["falar com humano", "atendente", "pessoa real"]),
    handoff_tool_enabled: z.boolean().default(true),
    cases_enabled: z.boolean().default(false),
    // Onda 4 — quebra a resposta em bolhas curtas (splitIntoBubbles) espaçadas
    // pelo pacing anti-ban. Defaults espelham a migration 0059.
    split_messages: z.boolean().default(false),
    split_max_chars: z.number().int().min(80).max(4000).default(600),
    followup: followupConfigSchema,
    // ── Papel OPERADOR (spec 16 §3.2) ───────────────────────────────────────
    // Todos com `.default(...)`, e é o que mantém retrocompatível: agent e
    // version que já existem, e qualquer payload que não conheça o papel,
    // seguem válidos e leem o papel como DESLIGADO.
    operator_enabled: z.boolean().default(false),
    // `.nullable()` e não opcional: null é o valor que SIGNIFICA "herda o modelo
    // do Conversador". Omitir seria indistinguível de "ainda não decidi".
    operator_model: z.string().trim().min(1).max(120).nullable().default(null),
    // Teto PRÓPRIO, não compartilhado com `tool_ids`: o Operador tem as 25 vagas
    // dele, o Conversador as dele, e nenhum come a lista do outro.
    //
    // ⚠️ A FRASE ANTERIOR VENCEU e está reescrita: ela dizia que separar os
    // papéis resolve o estouro "por divisão em vez de aumentar o número", e o
    // número FOI aumentado (20 → 25) quando o dono do produto ficou sem como
    // ligar as capacidades de agenda. Uma coisa não invalida a outra — a divisão
    // continua sendo o que impede os dois papéis de disputarem vaga —, mas
    // deixar escrito que o número nunca sobe faria a próxima sessão medir contra
    // uma régua que já não existe. O porquê do 25 está em
    // `lib/mcp/tools/selecao-por-pacote.ts`, junto da constante.
    operator_tool_ids: z
      .array(z.string().min(1).max(80))
      .max(TETO_TOOLS_POR_AGENTE)
      .default([])
      .refine(
        (ids) => ids.every((id) => (VALID_TOOL_IDS as readonly string[]).includes(id)),
        { message: "tool_id_invalid" },
      ),
    /**
     * Funis em que este agente pode ESCREVER (spec 17 passo 3). Vazio = NENHUM.
     *
     * ⚠️ Sem `.refine()` de existência, ao contrário de `operator_tool_ids` logo
     * acima — e a diferença não é descuido. Aquele valida contra uma CONSTANTE
     * em código, que o cliente também tem; funil é linha de tabela, e checar
     * existência é consulta cross-row. Um schema compartilhado com o browser não
     * pode fazer isso, então a validação de que o funil existe (e é desta
     * organização) mora no servidor, junto do resto.
     */
    pipeline_ids: z.array(z.string().uuid()).default([]),
    /**
     * Materiais que este agente consulta (0181). Vazio = NENHUM.
     *
     * Sem `.refine()` de existência pelo mesmo motivo de `pipeline_ids` logo
     * acima: material é linha de tabela, e um schema compartilhado com o browser
     * não faz consulta cross-row. Quem confere que o material existe e é desta
     * organização é o servidor.
     */
    knowledge_source_ids: z.array(z.string().uuid()).default([]),
  })
  .strict();

export type VersionInput = z.infer<typeof versionShapeSchema>;

export const versionCreateSchema = versionShapeSchema;

/** Edits permitted only on draft versions. Omitted fields never receive create defaults. */
export const versionPatchSchema = versionShapeSchema
  .extend({
    tool_ids: versionShapeSchema.shape.tool_ids.removeDefault(),
    max_steps: versionShapeSchema.shape.max_steps.removeDefault(),
    token_budget: versionShapeSchema.shape.token_budget.removeDefault(),
    cost_budget_cents: versionShapeSchema.shape.cost_budget_cents.removeDefault(),
    history_message_window: versionShapeSchema.shape.history_message_window.removeDefault(),
    history_token_window: versionShapeSchema.shape.history_token_window.removeDefault(),
    handoff_keywords: versionShapeSchema.shape.handoff_keywords.removeDefault(),
    handoff_tool_enabled: versionShapeSchema.shape.handoff_tool_enabled.removeDefault(),
    cases_enabled: versionShapeSchema.shape.cases_enabled.removeDefault(),
    split_messages: versionShapeSchema.shape.split_messages.removeDefault(),
    split_max_chars: versionShapeSchema.shape.split_max_chars.removeDefault(),
    followup: followupPatchSchema,
    operator_enabled: versionShapeSchema.shape.operator_enabled.removeDefault(),
    operator_model: versionShapeSchema.shape.operator_model.removeDefault(),
    operator_tool_ids: versionShapeSchema.shape.operator_tool_ids.removeDefault(),
    pipeline_ids: versionShapeSchema.shape.pipeline_ids.removeDefault(),
    knowledge_source_ids: versionShapeSchema.shape.knowledge_source_ids.removeDefault(),
  })
  .partial();

export const agentMcpCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    priority: z.number().int().min(0).max(1000).default(0),
    version: versionShapeSchema,
  })
  .strict();

export const agentMcpPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const publishSchema = z.object({ version_id: UUID }).strict();

export const testRunSchema = z
  .object({
    sample_message: z.string().trim().min(1).max(4000),
    sample_contact: z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        phone: z.string().trim().min(3).max(40).optional(),
      })
      .optional(),
  })
  .strict();

export const runsListQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z
      .enum(["pending", "running", "completed", "failed", "aborted", "handoff"])
      .optional(),
  })
  .strict();

export type PublishErrorCode =
  | "agent_not_found"
  | "agent_archived"
  | "version_not_found"
  | "existing_version_requires_review"
  | "version_invalid_state"
  | "credential_missing"
  | "credential_not_found"
  | "credential_inactive"
  | "credential_not_validated"
  | "credential_provider_mismatch"
  | "channel_session_not_found"
  | "channel_session_offline"
  | "model_not_found"
  | "tool_id_invalid";

export const PUBLISH_ERROR_CODES: ReadonlySet<string> = new Set<PublishErrorCode>([
  "agent_not_found",
  "agent_archived",
  "version_not_found",
  "version_invalid_state",
  "existing_version_requires_review",
  "credential_missing",
  "credential_not_found",
  "credential_inactive",
  "credential_not_validated",
  "credential_provider_mismatch",
  "channel_session_not_found",
  "channel_session_offline",
  "model_not_found",
  "tool_id_invalid",
]);
