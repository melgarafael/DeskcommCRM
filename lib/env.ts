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

/**
 * Knob de retenção em dias: NUNCA derruba o app.
 *
 * `z.coerce.number().int().positive()` lança para `=0`, que é justamente o que
 * o operador da VPS escreve quando quer desligar a poda — e `lib/env.ts` roda
 * no import do Next, então o throw vira 500 em TODAS as telas, com o contêiner
 * `healthy` e nada dizendo o porquê. Falha fechada na AÇÃO (o valor inválido
 * não vale) e aberta na INFORMAÇÃO (o app sobe e diz alto o que ignorou).
 *
 * Desligar a poda não é isto: se tiver de existir, é decisão de produto e vem
 * com nome próprio, não com um zero que o schema recusa.
 */
const diasDeRetencao = (nome: string, padrao: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .default(padrao)
    .catch(({ error }) => {
      console.warn(
        `[env] ${nome} inválida (${JSON.stringify(process.env[nome])}) — usando o padrão ${padrao} dias. ` +
          `Só número inteiro maior que zero vale aqui; "0" não desliga a poda. ` +
          `(${error.issues[0]?.message ?? "valor recusado"})`,
      );
      return padrao;
    });

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

  /**
   * Retenção do arquivo do corpo cru dos webhooks (`webhook_events_log`).
   *
   * O default de 7 dias não é gosto: numa instalação real esse arquivo era 86%
   * do banco (468 MB de 545 MB) e crescia ~23 MB/dia, contra os 500 MB do plano
   * gratuito do Supabase — onde a maioria dos clones vive. Com 7 dias o regime
   * estável fica em ~160 MB de corpo mais ~11 MB de índice forense; com 14 já
   * não cabe. Quem tem plano pago sobe o número e fica com mais corpo à mão.
   */
  WEBHOOK_LOG_BODY_RETENTION_DAYS: diasDeRetencao("WEBHOOK_LOG_BODY_RETENTION_DAYS", 7),
  /**
   * Quando a LINHA some, e não só o corpo. Horizonte longo de propósito: até
   * aqui a linha custa ~200 B e ainda responde "quantos eventos de que tipo
   * chegaram, quando, e a assinatura conferia?", que é a pergunta de depois do
   * incidente.
   */
  WEBHOOK_LOG_ROW_RETENTION_DAYS: diasDeRetencao("WEBHOOK_LOG_ROW_RETENTION_DAYS", 90),

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

  // Postgres direto do Supabase (Settings → Database) — só as rotas de skills
  // instaláveis (import/install) usam `pg` cru (mesmo pool do agent-engine).
  SUPABASE_DB_URL: required("SUPABASE_DB_URL"),
  /**
   * A conexão de DDL do KIT (install.sh/update.sh/backup.sh), não do app —
   * declarada aqui só porque o `docker-compose.prod.yml` entrega o `.env`
   * inteiro ao app e ao worker (`env_file`), e uma chave que chega ao processo
   * merece estar no contrato em vez de ser um desconhecido tolerado.
   *
   * NENHUM código de app pode lê-la: ela é o DONO do banco quando a instalação
   * é num Supabase próprio, e `SUPABASE_DB_URL` é a role menor de propósito
   * (issue #192). Vigiado por `tests/unit/env-ddl-fora-do-app.test.ts`.
   */
  SUPABASE_DB_ADMIN_URL: z.string().optional().default(""),

  // WAHA
  WAHA_API_BASE_URL: required("WAHA_API_BASE_URL"),
  WAHA_API_KEY: required("WAHA_API_KEY"),
  WAHA_WEBHOOK_BASE_URL: required("WAHA_WEBHOOK_BASE_URL"),
  // Segredo com que o WAHA assina os webhooks. O compose já o entrega ao
  // contêiner do WAHA; o app precisa dele para CONFERIR a assinatura — e não o
  // declarava aqui, então nunca teve como verificar nada.
  WAHA_HMAC_SECRET: z.string().optional().default(""),
  // "true" exige assinatura válida em todo webhook do WAHA. Fica desligado por
  // padrão porque o WAHA Core não assina (medido: 2026.7.2 CORE manda os
  // eventos sem header mesmo com WHATSAPP_HOOK_HMAC configurado), e exigir
  // derrubaria a ingestão de mensagens. Ligue se usa WAHA Plus ou um proxy que
  // assine — aí a verificação passa a ser obrigatória.
  WAHA_WEBHOOK_REQUIRE_SIGNATURE: z.string().optional().default("false"),

  // Upstash Redis
  UPSTASH_REDIS_REST_URL: required("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: required("UPSTASH_REDIS_REST_TOKEN"),

  // AI providers — env-gated. Worker no-ops with skip="ai_gateway_key_missing"
  // when AI_GATEWAY_API_KEY is absent, so production boot must not be fatal.
  AI_GATEWAY_API_KEY: z.string().optional().default(""),
  AI_GATEWAY_BASE_URL: z.string().optional().default(""),
  // OpenRouter: alternativa ao gateway da Vercel, compatível com a API da
  // OpenAI. Opcional — sem ela nada muda; com ela o chat passa a ser roteado
  // por lá. Ver resolveLanguageModel() em lib/ai/gateway.ts.
  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENROUTER_BASE_URL: z.string().optional().default(""),
  // Atribuição OPCIONAL da OpenRouter (`HTTP-Referer` / `X-Title`): identifica a
  // instalação no painel e no ranking público DELES. A doc da OpenRouter chama
  // os dois de opcionais e a chamada funciona sem — por isso default vazio e
  // nenhum header enviado quando não preenchidos. Quem lê é
  // `cabecalhosDeAtribuicaoOpenRouter()`, em edge/llm/providers.ts.
  OPENROUTER_APP_URL: z.string().optional().default(""),
  OPENROUTER_APP_TITLE: z.string().optional().default(""),
  VERCEL_AI_GATEWAY_URL: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),

  // Fusão (Fase 4): DONO ÚNICO dos eventos ai_agent.dispatch_requested.
  // 'engine' (default) = o worker agent-engine é o único consumidor (o cron
  // agent-dispatcher vira no-op mecânico); 'native' = o dispatcher EPIC-13
  // consome (deploy sem worker). NUNCA os dois — dois consumidores = turno
  // duplicado ou perdido (bug real da fusão).
  AGENT_DISPATCH_CONSUMER: z.enum(["engine", "native"]).optional().default("engine"),

  /**
   * Kill switch do teto de gasto de IA — a alavanca que o operador da VPS puxa
   * às 2h da manhã quando a IA parou e ele não sabe SQL.
   *
   * `on` (default) NÃO LIGA NADA: significa "respeite o que cada organização
   * escolheu na tela". A chave só sabe AFROUXAR — `avisar` rebaixa qualquer
   * bloqueio a aviso, e `off|false|0|no|nao|não|disabled` cala a proteção
   * inteira. É essa monotonicidade que a torna um kill switch de verdade.
   *
   * ⚠️ `z.string()` E JAMAIS `z.enum`, e o motivo é o modo de falha deste
   * arquivo: `safeParse` abaixo LANÇA quando o schema recusa, e no Next isso
   * acontece na primeira requisição — com healthcheck TCP puro, o contêiner
   * fica `healthy` com 100% das requisições em 500. Um `z.enum` transformaria a
   * alavanca de EMERGÊNCIA no derrubador do app inteiro no dia em que o
   * operador escrevesse `false`. A normalização (que aceita as grafias falsas
   * comuns como desligado, e resolve lixo para o lado seguro) mora em
   * `normalizarChaveDeOrcamento`, em lib/agent-engine/edge/llm/orcamento.ts.
   * Mesmo raciocínio de APP_ACCENT_HEX, algumas linhas abaixo.
   */
  AI_BUDGET_ENFORCEMENT: z.string().optional().default("on"),

  // Workers — opt-in via env so dev doesn't run loops. Production cron sets it.
  EVENT_LOG_WORKER_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  // O endpoint :test devolve um trace fake quando esta flag = 'true'.
  // Default 'false' desde que a S-13.08 landou: `callInternalRuntime` executa
  // o `runAgent` real, então quem instala do zero testa o agente de verdade.
  // Ligue 'true' só para exercitar o render da UI sem gastar token.
  INTERNAL_AGENT_RUN_STUB: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  // Sentry
  SENTRY_DSN: z.string().optional().default(""),

  /**
   * Resend — o transporte de TODO e-mail transacional (convite, LGPD, alarme).
   *
   * Estavam lidas de `process.env` CRU dentro de `lib/email/resend.ts`, fora do
   * Zod e fora do `.env.example` (medido: `grep -n RESEND lib/env.ts` → nada;
   * `grep -c -i resend .env.example` → 0). Duas consequências que só apareciam
   * na VPS: o `env-example-sync` nunca cobrou a documentação da chave, e o
   * `install.sh` não a gravava — como o `.env` é escrito com truncamento
   * (`} > .env`), a chave posta à mão era DESCARTADA na instalação seguinte,
   * num script que o README vende como idempotente.
   *
   * `RESEND_FROM_EMAIL` vazio NÃO cai num domínio nosso: ver `fromAddress()`.
   */
  RESEND_API_KEY: z.string().optional().default(""),
  RESEND_FROM_EMAIL: z.string().optional().default(""),

  /**
   * E-mail de suporte que a instalação mostra ao CLIENTE FINAL (tela de conta
   * suspensa, tela de cobrança).
   *
   * Vazio = a tela não mostra endereço nenhum. É deliberado: cair no nosso
   * endereço numa tela de suspensão manda o cliente do revendedor escrever
   * para quem não suspendeu a conta dele e não tem como resolvê-la.
   */
  SUPPORT_EMAIL: z.string().optional().default(""),

  // EPIC-11 Impersonate cookie HMAC secret. Optional at boot (route returns
  // 503 at runtime if missing/short); required in prod for the feature to
  // function. Min 32 chars when present is enforced at use site.
  IMPERSONATE_COOKIE_SECRET: z.string().optional().default(""),

  /**
   * Retenção do histórico que o cron `data-retention` poda (issue #261).
   *
   * As DUAS entram como `z.string()` e nunca como `z.coerce.number()`, pelo
   * mesmo motivo de `AI_BUDGET_ENFORCEMENT` algumas linhas acima: o `safeParse`
   * deste arquivo LANÇA quando o schema recusa, e no Next isso derruba toda
   * requisição com 500 num contêiner que segue `healthy` (o healthcheck é probe
   * TCP). Quem digita `noventa` às 2h da manhã tentando liberar espaço não pode
   * derrubar o produto. A interpretação — com padrão, piso e AVISO quando o
   * valor não vale como escrito — mora em `lib/retencao/politica.ts`.
   *
   * Ausentes = o comportamento default (90 dias de fila, 5 anos de auditoria).
   * Nenhuma instalação precisa editar `.env` para a poda funcionar.
   */
  JOB_QUEUE_RETENTION_DAYS: z.string().optional().default(""),
  AUDIT_LOG_RETENTION_DAYS: z.string().optional().default(""),
  EVENT_LOG_RETENTION_DAYS: z.string().optional().default(""),

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

  // Marca da instalação (white-label) — ver lib/branding.ts.
  // Sem prefixo NEXT_PUBLIC_ de propósito: essas seriam queimadas no bundle
  // durante o build da imagem, e o self-hoster roda uma imagem pré-buildada.
  // O <PublicEnvScript/> injeta os valores em runtime.
  APP_NAME: z.string().optional().default(""),
  APP_LOGO_URL: z.string().optional().default(""),
  /**
   * Cor da marca — um hex (`#506d48`), do qual `lib/branding/` deriva a rampa
   * inteira. Vazio = o produto se pinta com a cor dele.
   *
   * `optional().default("")` e NUNCA `required()`, e o motivo é o modo de falha,
   * não a preguiça: `lib/env.ts` lança no import do módulo, que no Next
   * acontece na PRIMEIRA REQUISIÇÃO, não no boot. E o healthcheck do contêiner é
   * um probe TCP puro (`docker-compose.prod.yml:44`, deliberadamente — /health
   * derrubaria o app quando o WAHA cai). Somando os dois: o Docker mostraria
   * `healthy` com 100% das requisições em 500. Uma var de COR não pode ter esse
   * poder; a validação do valor é do resolvedor, que degrada e diz o motivo.
   */
  APP_ACCENT_HEX: z.string().optional().default(""),
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
// `OPENROUTER_API_KEY` entra na condição porque `isAiGatewayConfigured()`
// (lib/ai/gateway.ts) e `resolveLanguageModel` a tratam como configuração
// VÁLIDA. Sem ela aqui, a instalação que escolhe OpenRouter — a primeira opção
// que o `install.sh` oferece — gritava no primeiro boot que a IA ia ficar muda,
// e ela não ia. O operador ia atrás de um problema que não existe, ou pior:
// cadastrava uma chave da Anthropic que não precisava, só para calar o aviso.
// O texto era verdadeiro enquanto a Anthropic era a única chave que o
// instalador pedia; o menu novo o tornou falso.
if (!env.AI_GATEWAY_API_KEY && !env.ANTHROPIC_API_KEY && !env.OPENROUTER_API_KEY) {
  console.warn(
    "[env] Nenhuma chave de IA configurada (AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY ou OPENROUTER_API_KEY) — " +
      "o agente vai pular toda resposta com reason='ai_gateway_key_missing'.",
  );
}
if (!env.OPENAI_API_KEY) {
  console.warn(
    "[env] No OPENAI_API_KEY set — RAG embedding unavailable (bot answers without retrieved context) " +
      "AND voice-note transcription is off (the agent will ask leads to resend audio as text).",
  );
}
if (!env.IMPERSONATE_COOKIE_SECRET || env.IMPERSONATE_COOKIE_SECRET.length < 32) {
  console.warn(
    "[env] IMPERSONATE_COOKIE_SECRET not set or shorter than 32 chars — impersonate flow will return 503 at runtime.",
  );
}

export type Env = typeof env;
