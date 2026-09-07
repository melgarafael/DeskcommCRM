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

// Task 7.2 — vínculo do agente com fluxos de follow-up publicados. Aditivo:
// `.default(...)` faz agents/versions existentes (sem este campo no payload)
// continuarem válidos, lidos com enabled=false/[] (comportamento inalterado).
// `flow_pointer_ids` referencia `followup_flow_pointers.id` — sem FK real de
// array no Postgres (mesma doutrina de `tool_ids`: domínio validado em app,
// não em constraint de banco).
const followupConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    flow_pointer_ids: z.array(UUID).max(20).default([]),
  })
  .strict()
  .default({ enabled: false, flow_pointer_ids: [] });

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
    channel_session_id: UUID,
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

/** Edits permitted only on draft versions. All fields optional. */
export const versionPatchSchema = versionShapeSchema.partial();

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
