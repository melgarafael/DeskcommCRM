/**
 * Validação de env vars com Zod.
 *
 * Chamada implicitamente no startup do Next via import. Se variável crítica
 * está faltando, lança erro com mensagem clara antes do app subir.
 *
 * Uso: import { env } from "@/lib/env";
 */

import { z } from "zod";

const isProd = process.env.NODE_ENV === "production";

/**
 * Durante `next build` (NEXT_PHASE=phase-production-build) os segredos de runtime
 * ainda não existem — só as NEXT_PUBLIC_* são embutidas no bundle. Nessa fase
 * afrouxamos a validação (via seed de placeholders no parse abaixo) pra gerar a
 * imagem Docker (self-host) sem passar segredos como ARG, que vazariam nas
 * camadas. O boot real (sem essa fase) cobra os valores verdadeiros.
 *
 * A leniência é feita SÓ no parse — os validadores continuam com tipos Zod
 * estáveis, senão `z.infer` degrada `env.*` pra `{}` (uniões quebram `.url()`).
 */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

/**
 * Em produção exigimos todas as vars críticas. Em dev, algumas são opcionais
 * pra permitir setup parcial (ex: dev sem WAHA quando trabalhando só na UI).
 */
const required = (name: string) =>
  isProd
    ? z.string().min(1, `${name} é obrigatória em produção`)
    : z.string().default("");

const requiredAlways = (name: string) => z.string().min(1, `${name} é obrigatória`);

const schema = z.object({
  // Node
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Supabase — obrigatórias sempre (até pra dev local)
  NEXT_PUBLIC_SUPABASE_URL: requiredAlways("NEXT_PUBLIC_SUPABASE_URL").url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: requiredAlways("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: requiredAlways("SUPABASE_SERVICE_ROLE_KEY"),

  // Cron / interno
  INTERNAL_SECRET: required("INTERNAL_SECRET"),
  /** Optional dedicated secret for cron endpoints (S-06.07 onwards). */
  INTERNAL_CRON_SECRET: z.string().optional().default(""),

  // Encryption keys (pgcrypto)
  CPF_ENCRYPTION_KEY: required("CPF_ENCRYPTION_KEY"),
  // Opcional (template genérico) — só necessária ao ligar NUVEMSHOP_ENABLED.
  NUVEMSHOP_OAUTH_ENCRYPTION_KEY: z.string().optional().default(""),
  WAHA_BYO_ENCRYPTION_KEY: required("WAHA_BYO_ENCRYPTION_KEY"),
  /**
   * AES-256-GCM key (32 bytes em base64) usada pra cifrar API keys em
   * `ai_provider_credentials`. Em produção é obrigatória; em dev a default vazia
   * é tolerada — `lib/crypto/aes_gcm.ts` lança se a key não bate em runtime.
   */
  AI_CRED_AES_KEY: required("AI_CRED_AES_KEY"),

  // WAHA
  WAHA_API_BASE_URL: required("WAHA_API_BASE_URL"),
  WAHA_API_KEY: required("WAHA_API_KEY"),
  WAHA_WEBHOOK_BASE_URL: required("WAHA_WEBHOOK_BASE_URL"),

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: required("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: required("UPSTASH_REDIS_REST_TOKEN"),

  // AI providers — env-gated. Worker no-ops with skip="ai_gateway_key_missing"
  // when AI_GATEWAY_API_KEY is absent, so production boot must not be fatal.
  AI_GATEWAY_API_KEY: z.string().optional().default(""),
  AI_GATEWAY_BASE_URL: z.string().optional().default(""),
  VERCEL_AI_GATEWAY_URL: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),

  // Fusão (Fase 4): DONO ÚNICO dos eventos ai_agent.dispatch_requested.
  // 'engine' (default) = o worker agent-engine é o único consumidor (o cron
  // agent-dispatcher vira no-op mecânico); 'native' = o dispatcher EPIC-13
  // consome (deploy sem worker). NUNCA os dois — dois consumidores = turno
  // duplicado ou perdido (bug real da fusão).
  AGENT_DISPATCH_CONSUMER: z.enum(["engine", "native"]).optional().default("engine"),

  // Workers — opt-in via env so dev doesn't run loops. Production cron sets it.
  EVENT_LOG_WORKER_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  // EPIC-13 wave 6: enquanto S-13.08 (runtime real) não landa, o endpoint
  // :test devolve um trace fake quando esta flag = 'true'. Default 'true' em
  // dev, deve virar 'false' em produção quando a wave 8 estiver mergeada.
  INTERNAL_AGENT_RUN_STUB: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((v) => v === "true"),

  // Sentry
  SENTRY_DSN: z.string().optional().default(""),

  // EPIC-11 Impersonate cookie HMAC secret. Optional at boot (route returns
  // 503 at runtime if missing/short); required in prod for the feature to
  // function. Min 32 chars when present is enforced at use site.
  IMPERSONATE_COOKIE_SECRET: z.string().optional().default(""),

  // LGPD export (S-08.04)
  LGPD_SIGNING_KEY: z.string().optional().default(""),
  LGPD_EXPORT_EXPIRES_HOURS: z.string().optional().default("72"),
  LGPD_DPO_EMAIL: z.string().optional().default(""),

  // Nuvemshop — opcional (template genérico open-source). Só exigidas quando
  // NUVEMSHOP_ENABLED=true; o runtime já degrada via getConfig()==null.
  NUVEMSHOP_APP_ID: z.string().optional().default(""),
  NUVEMSHOP_CLIENT_ID: z.string().optional().default(""),
  NUVEMSHOP_CLIENT_SECRET: z.string().optional().default(""),
  NUVEMSHOP_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  // App URLs
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url()
    .default("http://localhost:3000"),
  NEXT_PUBLIC_ADMIN_URL: z
    .string()
    .url()
    .default("http://localhost:3000"),
});

let parsed = schema.safeParse(process.env);

// Na fase de build da imagem Docker, semeia placeholders pras vars que faltam
// (URL válida, passa .url()/.min(1)) e revalida — permite `next build` sem os
// segredos de runtime. NUNCA acontece em runtime: lá process.env está completo
// e este bloco não roda, então o boot real continua cobrando tudo.
if (!parsed.success && isBuildPhase) {
  const seeded: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(parsed.error.flatten().fieldErrors)) {
    if (!seeded[key]) seeded[key] = "https://build-placeholder.invalid";
  }
  parsed = schema.safeParse(seeded);
}

if (!parsed.success) {
  // Log estruturado pra debug. Sentry capturaria via uncaught.
  console.error("[env] Falha de validação de variáveis de ambiente:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error(
    "Variáveis de ambiente inválidas. Veja o erro acima e ajuste .env.local / Vercel.",
  );
}

export const env = parsed.data;

// Soft warning for env-gated AI keys (worker degrades gracefully but operators
// should know when the bot is silent for config reasons).
if (!env.AI_GATEWAY_API_KEY && !env.ANTHROPIC_API_KEY) {
  console.warn(
    "[env] No AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY set — ai-response-worker will skip with reason='ai_gateway_key_missing'.",
  );
}
if (!env.OPENAI_API_KEY) {
  console.warn(
    "[env] No OPENAI_API_KEY set — RAG embedding will be unavailable; bot answers without retrieved context.",
  );
}
if (!env.IMPERSONATE_COOKIE_SECRET || env.IMPERSONATE_COOKIE_SECRET.length < 32) {
  console.warn(
    "[env] IMPERSONATE_COOKIE_SECRET not set or shorter than 32 chars — impersonate flow will return 503 at runtime.",
  );
}

export type Env = typeof env;
