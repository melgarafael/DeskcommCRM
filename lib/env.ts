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
   * Segredo do DONO DA INSTALAÇÃO para `POST /api/v1/tenants/provision` (um
   * sistema externo cria organizações). Vazio por padrão = a rota não existe
   * (404); com menos de 32 caracteres também fica desligada.
   */
  TENANT_PROVISIONING_SECRET: z.string().optional().default(""),

  // Laboratório local de extensões: origem HTTP exata em 127.0.0.1. O cliente
  // recusa a exceção se a URL do app não for loopback. Vazio mantém HTTPS público.
  EXTENSIONS_LOCAL_CATALOG_ORIGIN: z.string().optional().default(""),

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
  /**
   * Retenção do HISTÓRICO de leads captados (`webhook_lead_captures`).
   *
   * Horizonte muito mais longo que o do arquivo forense acima, e a diferença é
   * de natureza: lá a linha é despejo de depuração, aqui ela É o produto — é o
   * que a aba "Leads recebidos" mostra quando alguém pergunta de qual campanha
   * vieram os clientes que fecharam. Uma linha custa ~1 kB, então 300
   * leads/dia por um ano dão ~110 MB; o ano fiscal cabe.
   *
   * Entra como `z.string()` — e não pelo `diasDeRetencao` acima — porque quem
   * a interpreta é `lib/retencao/politica.ts`, o mesmo módulo da poda da fila e
   * do expurgo da auditoria. Ele resolve lixo para o lado seguro E devolve a
   * frase de aviso, que é o que faz o operador saber que o número dele foi
   * elevado ao piso de 30 dias, em vez de descobrir pela ausência de efeito.
   */
  LEAD_CAPTURE_RETENTION_DAYS: z.string().optional().default(""),

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
   * A conexão de DDL do KIT (install.sh/update.sh/backup.sh), não do app.
   * O `docker-compose.prod.yml` entrega o `.env` inteiro ao app, ao worker e
   * ao voice-agent (`env_file`), e desde o #1680 sobrescreve esta chave com
   * vazio no `environment:` deles — no processo ela chega vazia. A declaração
   * fica porque quem roda fora desse compose (dev local, `next start` à mão)
   * ainda a recebe do `.env`, e uma chave que chega ao processo merece estar no
   * contrato em vez de ser um desconhecido tolerado.
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

  // ─── Chamada de voz WhatsApp (WaCalls, spec 18) ───
  //
  // NUNCA `required()`: o serviço `wacalls` vive num profile do compose que
  // nasce DESLIGADO, então a instalação normal não o tem. Exigir aqui
  // derrubaria o boot de todo self-host que não usa a feature.
  //
  // Vazio = a instalação não oferece a chamada de voz. É essa string vazia que
  // `instalacaoOfereceVoz()` lê para dizer à tela que nenhum clique resolve.
  WACALLS_API_BASE_URL: z.string().optional().default(""),
  // O upstream autenticado NÃO tem modo aberto: sem este Bearer, a API só é
  // alcançável pelo cookie de login do navegador, e um processo
  // server-to-server não tem cookie. URL sem token dá um cliente que constrói e
  // devolve 401 em toda chamada — por isso `getWacallsClient()` exige os dois.
  WACALLS_API_TOKEN: z.string().optional().default(""),

  // ─── Canal Datafy (recorte do #1130) — OPCIONAL, DESLIGADO POR PADRÃO ───
  //
  // Só `true` liga (decisão do dono, doc 54). Vazio = a instalação não oferece o
  // canal: sem aba em Conexões, rota de conexão 404, webhook recusado. Quem lê
  // é `canalGraphParceiroLigado()` em `lib/channels/graph-parceiro/credentials.ts`.
  DATAFY_ENABLED: z.string().optional().default(""),

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
  // Esforço de raciocínio dos modelos da OpenAI (o*, gpt-5*, gpt-6*). `z.string()`
  // e NUNCA `z.enum` (motivo mais abaixo, em AGENT_DISPATCH_CONSUMER): quem valida
  // a grafia é o boot do worker, em `lib/agent-engine/env.ts`.
  OPENAI_REASONING_EFFORT: z.string().optional().default(""),
  // Transcrição de áudio num serviço COMPATÍVEL com o da OpenAI (Groq, um
  // Whisper próprio): a chave vale só para `/audio/transcriptions` — a conversa
  // com o cliente e a leitura de imagem continuam no provedor do ponto.
  // Vazio é ausente, como no resto do arquivo: sem `TRANSCRIPTION_API_KEY` a
  // transcrição usa a `OPENAI_API_KEY` acima, que é o comportamento de sempre.
  // Quem lê é o worker de derivação de mídia (`workers/media-derive-worker.ts`).
  TRANSCRIPTION_API_KEY: z.string().optional().default(""),
  TRANSCRIPTION_BASE_URL: z.string().optional().default(""),
  TRANSCRIPTION_MODEL: z.string().optional().default(""),
  // Idiomas esperados no áudio, ISO-639-1 separados por vírgula ("es" ou
  // "pt,es"). Vazio = o serviço detecta sozinho. Vale com a chave acima E com a
  // da OpenAI da organização — assim como `TRANSCRIPTION_MODEL`. Leitura
  // tolerante em `idiomasDaTranscricao` (grafia errada não derruba o worker).
  TRANSCRIPTION_LANGUAGES: z.string().optional().default(""),
  // Endereço da API do Jev (TypeSafe AI). Vazio é ausente: vale
  // https://api.typesafe.ai. Existe para o dublê do e2e — a CHAVE nunca vem
  // daqui, é por organização (BYOK). Quem lê é `baseDaApiDoJev()`, em
  // lib/ai/decisao/cliente.ts.
  JEV_API_BASE_URL: z.string().optional().default(""),
  // Destinos internos que o DONO DA INSTALAÇÃO autoriza (decisão 22-d, #1004):
  // IPv4 e faixas CIDR IPv4 que a saída pode alcançar mesmo sendo rede interna,
  // e só para destinos que a própria INSTALAÇÃO configura (nunca o endereço que
  // uma organização escolhe). O BANCO ESTÁ ACIMA DISTO: a lista vive em
  // `platform_settings.internal_destinations`, editada em
  // `/admin/destinos-internos`; esta variável é só o PISO, que vale enquanto a
  // tela nunca foi usada. Vazio é ausente: sem ela, nada passa. Quem lê é
  // `lib/automation/destinos-internos-autorizados.ts`.
  IA_DESTINOS_INTERNOS_PERMITIDOS: z.string().optional().default(""),

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

  // As duas chaves do MOTOR que também são comportamento da INSTALAÇÃO (issue
  // #1034): o modo do portão de disclosure do atendimento e a camada semântica
  // de promessa. Existem em `lib/agent-engine/env.ts` (é lá que o worker as
  // lê); entram aqui para a tela de admin poder mostrar o PISO que o `.env`
  // desta instalação declara, em vez de supor o default do produto.
  //
  // `z.string()` cru e NUNCA `z.enum`, pelo mesmo motivo da linha acima: um
  // `z.enum` que lança no import derruba o processo, e derrubar o processo é o
  // oposto do que um kill switch faz. Quem normaliza é o leitor de cada um:
  // `pisoDaInstalacao()`, em lib/instalacao/comportamento-servidor.ts.
  DISCLOSURE_MODE: z.string().optional(),
  PROMISE_SEMANTIC_ENABLED: z.string().optional(),

  // `EVENT_LOG_WORKER_ENABLED` viveu aqui até 2026-08-25 e NUNCA teve leitor: o
  // campo era declarado, documentado no `.env.example` com `false` e lido por
  // ninguém (medido: zero ocorrências fora da própria declaração). Saiu junto
  // com a chegada do laço de verdade (`lib/event-log/drain-loop.ts`), e o ritmo
  // dele agora mora nos `EVENT_LOG_DRAIN_*` de `lib/agent-engine/env.ts` — o
  // schema do processo que roda o laço, e não o do app.
  //
  // Não virou o liga/desliga do laço novo de propósito: o default publicado era
  // `false`, então respeitá-lo faria o conserto não chegar a NENHUMA instalação
  // já existente — que é o item 15 do Definition of Done ("a mudança chega a
  // quem já instalou"). O worker existe para rodar laços; este liga sempre.

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
   * SMTP — o SEGUNDO transporte de e-mail, ao lado da Resend, nunca no lugar
   * dela. Quem já roda com Resend não mexe em nada; quem instala numa VPS e não
   * quer criar conta em serviço externo preenche estas sete e o envio sai pelo
   * servidor dele. Qual dos dois atende cada envio é decidido em
   * `lib/email/roteador.ts` — SMTP quando há SMTP, Resend quando não há.
   *
   * O banco (`platform_smtp_settings`, pela tela /admin/email) PREVALECE sobre
   * estas variáveis; elas existem para provisionar uma VPS sem abrir interface,
   * e são o piso de rollback. Todas `optional().default()`: `.env` antigo não
   * quebra ao atualizar.
   */
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional().default(587),
  SMTP_SECURITY: z.enum(["starttls", "tls", "none"]).optional().default("starttls"),
  SMTP_USERNAME: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  SMTP_FROM_EMAIL: z.string().optional().default(""),
  SMTP_FROM_NAME: z.string().optional().default(""),

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
  /**
   * Conversa da equipe com a IA sobre um caso (migration 0281). `z.string()`
   * pela MESMA razão das duas acima: `lib/env.ts` lança na primeira requisição
   * e o healthcheck é TCP — um `z.coerce.number()` aqui transformaria
   * `CASE_CHAT_RETENTION_DAYS=noventa` no derrubador do produto inteiro, com o
   * contêiner marcado `healthy`. Quem interpreta é `lib/retencao/politica.ts`,
   * onde lixo resolve para o lado seguro e o operador vê o aviso no log.
   */
  CASE_CHAT_RETENTION_DAYS: z.string().optional().default(""),
  /**
   * Passagem do atendimento para uma pessoa (migration 0291). `z.string()` pela
   * MESMA razão das três acima — quem interpreta é `lib/retencao/politica.ts`,
   * onde lixo resolve para o lado seguro e o operador vê o aviso no log, em vez
   * de o contêiner ficar `healthy` respondendo 500 a tudo.
   */
  PASSAGEM_RETENTION_DAYS: z.string().optional().default(""),
  /**
   * Registro de entrega do aviso de caso no WhatsApp da equipe (migration
   * 0292). `z.string()` pela MESMA razão das quatro acima — quem interpreta é
   * `lib/retencao/politica.ts`, onde lixo resolve para o lado seguro e o
   * operador vê o aviso no log, em vez de o contêiner ficar `healthy`
   * respondendo 500 a tudo.
   */
  CASE_ALERT_RETENTION_DAYS: z.string().optional().default(""),
  /**
   * Candidato da prospecção nativa vencido (migration 0408, issue #1313).
   * `z.string()` pela MESMA razão das cinco acima — quem interpreta é
   * `lib/retencao/politica.ts`, onde lixo resolve para o lado seguro e o
   * operador vê o aviso no log, em vez de o contêiner ficar `healthy`
   * respondendo 500 a tudo. Padrão 365, piso 90, decisão do dono (PR #1577).
   */
  PROSPECCAO_RETENTION_DAYS: z.string().optional().default(""),
  /**
   * Observações do Jev (migration 0421): o par Jev × mecanismo de hoje que o
   * cartão compara, sem texto de cliente. `z.string()` pela MESMA razão das
   * irmãs acima — quem interpreta é `lib/retencao/politica.ts`. Padrão 90, piso
   * 30 (a janela da concordância).
   */
  JEV_OBSERVACOES_RETENTION_DAYS: z.string().optional().default(""),
  /**
   * Rascunho sugerido por integração JÁ VENCIDO (`conversation_drafts`,
   * migration 0419, issue #1686). `z.string()` pela MESMA razão das irmãs
   * acima — quem interpreta é `lib/retencao/politica.ts`, onde lixo resolve
   * para o lado seguro. Padrão 30, piso 7, contados do `expires_at` (a linha
   * só responde enquanto a janela dela está aberta).
   */
  DRAFT_RETENTION_DAYS: z.string().optional().default(""),
  /**
   * Candidatos ao golden set (migration 0428, issue #1695): rótulo de near-miss
   * e de divergência, sem texto de cliente. `z.string()` pela MESMA razão das
   * irmãs acima — quem interpreta é `lib/retencao/politica.ts`. Padrão 90, piso
   * 30 (a janela em que um near-miss ainda é curável).
   */
  GOLDEN_CANDIDATES_RETENTION_DAYS: z.string().optional().default(""),

  // LGPD export (S-08.04)
  LGPD_SIGNING_KEY: z.string().optional().default(""),
  LGPD_EXPORT_EXPIRES_HOURS: z.string().optional().default("72"),
  LGPD_DPO_EMAIL: z.string().optional().default(""),

  // Google Agenda — opcional, e é a DECISÃO 3.1 em forma de schema. Sem as
  // duas, o módulo de agenda funciona INTEIRO: some o botão "Conectar Google" e
  // a tela explica em uma linha o que falta e onde obter. É o estado real de um
  // primeiro deploy, e é onde moram os piores bugs de primeira impressão.
  //
  // NÃO há flag de "enabled" de propósito. Estar configurado É ter as duas
  // chaves; uma flag seria um terceiro estado para o operador errar — e
  // `z.enum` sobre valor que ele digita transforma a alavanca em derrubador do
  // app inteiro no dia em que alguém escrever `TRUE`.
  GOOGLE_CALENDAR_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional().default(""),

  // Google Ads — credencial da INSTALAÇÃO, não da organização (migration 0307).
  // O developer token pertence a quem construiu o software, não à conta de
  // anúncios de cada cliente: uma instalação usa o MESMO token pra reportar
  // conversão em contas diferentes, cada uma com seu próprio refresh token
  // (esse sim por organização, em ad_platform_connections). Sem tela de
  // configuração ainda — env-only, como o app OAuth do Google era antes da 0201 —
  // porque só a instalação PRECISA desta credencial existir; cada organização só
  // precisa AUTORIZAR (OAuth), nunca ver nem digitar o developer token.
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional().default(""),
  GOOGLE_ADS_OAUTH_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_ADS_OAUTH_CLIENT_SECRET: z.string().optional().default(""),

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
  /**
   * URL pública opcional para os webhooks da Meta (WhatsApp Cloud API / canais oficiais).
   * Quando definida, é usada no lugar de NEXT_PUBLIC_APP_URL para compor a URL de callback
   * dos webhooks da Meta (#1426), permitindo isolar a interface interna/VPN da URL pública.
   */
  META_WEBHOOK_BASE_URL: z.string().optional().default(""),

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

  /**
   * Com o que a instalação NASCE quanto a cadastro: `aberto` (padrão),
   * `com_aprovacao` ou `so_convite`. Vazio = `aberto`, que é como o produto
   * sempre funcionou.
   *
   * O BANCO ESTÁ ACIMA DISTO. Havendo linha em `platform_settings` — o que
   * acontece assim que alguém usa a tela em `/admin/cadastro` —, é ela que
   * manda. Esta variável responde nas duas situações em que o banco não tem o
   * que dizer: instalação que nunca abriu a tela, e app que subiu e ainda não
   * conseguiu ler o banco. A segunda é o motivo de ela existir: sem um piso
   * declarado, uma instalação deliberadamente fechada abriria nessa janela.
   *
   * `z.string()` e NÃO `z.enum`, pelo mesmo motivo escrito ao lado de
   * `APP_ACCENT_HEX`: um enum lançaria no import do módulo, que no Next é a
   * PRIMEIRA REQUISIÇÃO — e com healthcheck de probe TCP o Docker mostraria
   * `healthy` com 100% das requisições em 500. Valor irreconhecível degrada em
   * `lib/auth/politica-de-cadastro.ts`, com erro no log.
   */
  SIGNUP_MODE: z.string().optional().default(""),

  /**
   * Par VAPID do Web Push. Opcionais: sem elas a bandeja só funciona com a aba
   * viva (Notification API + SW local). Gerar: `npx web-push generate-vapid-keys`.
   */
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
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
    "Variáveis de ambiente inválidas. Veja o erro acima e ajuste o .env da instalação (ou .env.local, em dev).",
  );
}

export const env = parsed.data;

if (env.NODE_ENV === "production") {
  const vercelCron = process.env.CRON_SECRET?.trim();
  if (vercelCron) {
    // Agendador externo que injeta `CRON_SECRET` (é o nome de mercado) chama as
    // rotas com `Bearer $CRON_SECRET`, e `lib/auth/cron-auth.ts` só confere o
    // Bearer contra INTERNAL_CRON_SECRET e INTERNAL_SECRET — sem esta cópia, quem
    // agenda por esse caminho leva 401/403 em toda rodada. O caminho oficial do
    // produto não passa por aqui: o `crond` do serviço `scheduler` manda
    // `Bearer $INTERNAL_SECRET` (`docker/scheduler/entrypoint.sh`). A cópia é
    // vigiada por `tests/unit/cron-routes-scheduled.test.ts`.
    env.INTERNAL_CRON_SECRET = vercelCron;
  }
}

// Este processo só conhece as chaves do AMBIENTE. As credenciais cadastradas em
// IA › Credenciais moram no banco e são resolvidas mais tarde, no contexto da
// organização; por isso ausência aqui nunca pode virar diagnóstico de "IA muda".
// `OPENROUTER_API_KEY` entra na condição porque `resolveLanguageModel`
// (lib/ai/gateway.ts) a trata como configuração válida no ambiente, assim como
// gateway e Anthropic.
// `OPENAI_API_KEY` entra pelo mesmo motivo, com a diferença que o aviso não
// precisa esconder: ela atende os pontos do provedor que a ORGANIZAÇÃO escolheu
// (é o último degrau de `resolverModeloDoPonto`, lib/ai/gateway-binding.ts).
// Sem esta linha, uma instalação que responde pelo OpenAI lia no boot que
// "nenhuma chave de IA" estava configurada — issue #1181.
if (
  !env.AI_GATEWAY_API_KEY &&
  !env.ANTHROPIC_API_KEY &&
  !env.OPENROUTER_API_KEY &&
  !env.OPENAI_API_KEY
) {
  console.warn(
    "[env] Nenhuma chave de IA configurada no ambiente " +
      "(AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY ou OPENAI_API_KEY). " +
      "Isto não prova que o agente está sem credencial: cada organização pode ter uma chave " +
      "cadastrada em IA › Credenciais. A falta real só é conhecida quando a resolução completa " +
      "do turno não encontra chave em nenhum degrau.",
  );
}
// Este aviso ANUNCIAVA UM DESFECHO que o boot não tem como saber, e a correção
// aqui é a mesma que o bloco de cima já pagou uma vez. Ele dizia "RAG embedding
// unavailable" e "voice-note transcription is off" — as duas afirmações são
// falsas numa instalação onde a organização cadastrou a chave PELA TELA:
// o preparo de material resolve a chave por uma escada (ponto de IA →
// credencial da organização → gateway → este env — `lib/ai/embeddings/chave.ts`),
// e a transcrição já caía na credencial da org antes disso
// (`workers/media-derive-worker.ts`).
//
// Quem lê um aviso de boot não consegue conferir o desfecho; ele acredita. E
// acreditar em "está desligado" quando está ligado faz a pessoa ir cadastrar
// uma chave que ela já tem — ou, pior, desistir do recurso. Então o aviso passou
// a dizer só o que ESTE processo sabe: o que a variável é, e o que fazer se não
// houver chave em lugar nenhum.
if (!env.OPENAI_API_KEY) {
  console.warn(
    "[env] OPENAI_API_KEY ausente — ela é o ÚLTIMO degrau da escada de chave da OpenAI " +
      "(preparo de material do acervo e transcrição de áudio). Se alguma organização já " +
      "cadastrou a chave em IA › Credenciais, os dois seguem funcionando por ela; se não " +
      "cadastrou nenhuma, ambos ficam parados até que alguém cadastre — pela tela ou aqui.",
  );
}
if (!env.IMPERSONATE_COOKIE_SECRET || env.IMPERSONATE_COOKIE_SECRET.length < 32) {
  console.warn(
    "[env] IMPERSONATE_COOKIE_SECRET not set or shorter than 32 chars — impersonate flow will return 503 at runtime.",
  );
}

export type Env = typeof env;
