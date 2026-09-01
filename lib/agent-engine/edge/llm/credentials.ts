/**
 * Config LLM por org, pós-fusão (PORT-NOTES): a credencial BYOK vive em
 * `ai_provider_credentials` do CRM (AES-256-GCM via lib/crypto/aes_gcm — colunas
 * api_key_encrypted/api_key_iv/api_key_tag) e os knobs de modelo/params vivem em
 * `organizations.settings->'llm'`. Sem BYOK, o fallback é a chave de plataforma
 * do env (ANTHROPIC_API_KEY ou OPENAI_API_KEY, conforme o provider). O plaintext da chave
 * existe apenas em memória do processo no instante da chamada; nunca em log.
 *
 * O TETO **não** mora mais no jsonb: desde a migration 0159 ele é
 * `ai_budgets` (teto, modo, carência, limiar), lido aqui pelo mesmo round-trip
 * via `left join`. Era o defeito de origem — a tela editava `ai_budgets` e o
 * enforcement lia `settings.llm.monthly_budget_cents`, então quem preenchia a
 * tela acreditava estar protegido e não estava.
 *
 * A config é lida do DB A CADA chamada (resolveOrgLlmConfig) — trocar modelo/
 * provider/teto é UPDATE na config, sem restart nem deploy.
 */
import type pg from 'pg';
import { z } from 'zod';

import { byteaToBuffer, decryptKey } from '@/lib/crypto/aes_gcm';
import {
  LIMIAR_PADRAO_PCT,
  normalizarChaveDeOrcamento,
  normalizarModoDeOrcamento,
  type ChaveDeOrcamento,
  type ModoDeOrcamento,
} from './orcamento';
import type { CacheTtl } from './stable-prefix';

/** Config da camada LLM montada do env validado (padrão crmEdgeConfigFromEnv). */
export interface LlmEdgeConfig {
  /** chave de plataforma (fallback quando a org não tem BYOK). Opcional no boot. */
  anthropicApiKey?: string;
  /**
   * Mesma ideia para OpenAI. Existia só a da Anthropic, e isso quebrava a
   * transcrição de áudio: o Whisper é da OpenAI, mas a org que usa Anthropic
   * como provedor de chat não tem credencial OpenAI cadastrada — e o
   * instalador coleta OPENAI_API_KEY justamente para isso. Sem este fallback
   * a chave do instalador não chegava a lugar nenhum.
   */
  openaiApiKey?: string;
  /**
   * Mesma ideia para a OpenRouter — e o buraco era pior, porque o instalador
   * passou a OFERECER OpenRouter como primeira opção. Quem escolhia e não
   * cadastrava chave da Anthropic tinha `LlmNotConfiguredError` em tudo que
   * passa por este seam, com a mensagem de erro mandando cadastrar justamente
   * as duas chaves que ele decidiu não usar. Na derivação de mídia o desfecho
   * era mudo: 5 tentativas, `media_derived_status='failed'`, zero avisos.
   */
  openrouterApiKey?: string;
  /**
   * TTL do prefixo estável de cache (knob LLM_CACHE_TTL). Opcional para quem
   * monta a config na mão (testes) — o seam aplica a doutrina '1h' quando ausente.
   */
  cacheTtl?: CacheTtl;
  /**
   * `AI_BUDGET_ENFORCEMENT` já normalizado — o kill switch do operador da
   * instalação. Ausente = `'on'`, e `'on'` NÃO LIGA NADA: significa apenas
   * "respeite o que cada organização escolheu". A chave só sabe AFROUXAR.
   *
   * Vive aqui, e não lida de `process.env` dentro do seam, porque a camada tem
   * um dono de env por processo: o app (`lib/env.ts`) e o worker
   * (`lib/agent-engine/env.ts`) montam esta config, e `loadEnv` do worker
   * REMOVE o que o schema dele não declara. Uma leitura direta de
   * `process.env` aqui pareceria funcionar no app e sumiria no worker — que é
   * exatamente onde a IA gasta.
   */
  budgetEnforcement?: ChaveDeOrcamento;
}

/**
 * ⚠️ `OPENAI_API_KEY` entra aqui, e não entrava antes — o campo `openaiApiKey`
 * existia no tipo e era lido em `resolveOrgLlmConfig`, mas NENHUM caminho do
 * agente o preenchia (só o worker de transcrição de áudio montava a config na
 * mão). O efeito: numa instalação com a chave da OpenAI no `.env`, um agente com
 * modelo OpenAI caía em `LlmNotConfiguredError` — a chave estava lá, coletada
 * pelo instalador, e o turno morria como se não estivesse. Um campo declarado que
 * ninguém preenche é pior que um campo ausente: faz quem lê o código concluir que
 * o caminho existe.
 */
export function llmEdgeConfigFromEnv(env: {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  LLM_CACHE_TTL?: string;
  AI_BUDGET_ENFORCEMENT?: string;
}): LlmEdgeConfig {
  const ttl = env.LLM_CACHE_TTL ?? '1h';
  if (ttl !== '5m' && ttl !== '1h') {
    throw new Error("LLM_CACHE_TTL inválido — use '5m' ou '1h' (default 1h)");
  }
  return {
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
    ...(env.OPENROUTER_API_KEY ? { openrouterApiKey: env.OPENROUTER_API_KEY } : {}),
    cacheTtl: ttl,
    // Sem `if` de valor vazio, ao contrário das chaves acima: aqui o ausente
    // TEM um significado ('on'), e o normalizador é quem o dá. Um campo
    // opcional que some faria o seam ter de repetir o default, e dois defaults
    // é como um dos dois fica para trás.
    budgetEnforcement: normalizarChaveDeOrcamento(env.AI_BUDGET_ENFORCEMENT),
  };
}

/** Org sem credencial LLM utilizável — erro tipado, mensagem sem valores (credencial fora). */
export class LlmNotConfiguredError extends Error {
  override readonly name = 'llm_not_configured';
  constructor() {
    super(
      'org sem credencial LLM utilizável — cadastre uma chave BYOK ativa/validada em ai_provider_credentials ou defina ANTHROPIC_API_KEY / OPENAI_API_KEY (fallback de plataforma, conforme o provider do modelo)',
    );
  }
}

/**
 * O teto da organização, como o resolvedor o leu. É o ESTADO, nunca a decisão:
 * quem decide é `decidirOrcamento` (`./orcamento.ts`), e quem lhe entrega os
 * números é o statement do gate — não este objeto.
 *
 * ⚠️ ESTES VALORES SERVEM SÓ AO ATALHO DE CUSTO. O gate os usa para uma única
 * pergunta ("vale a pena ir ao banco?") e depois relê tudo dentro de
 * `SQL_ORCAMENTO`, que enxerga um snapshot atômico junto com os inserts.
 * Decidir sobre a cópia daqui seria decidir sobre um número mais velho que o
 * aviso que ele mesmo abriria.
 */
export interface OrcamentoDaOrg {
  modo: ModoDeOrcamento;
  /** `ai_budgets.monthly_limit_cents` — centavo de DÓLAR (ver `pricing.ts`). */
  tetoCents: number;
  efetivoEm: Date | null;
  limiarPct: number;
}

export interface OrgLlmConfig {
  provider: string;
  /** plaintext decifrado — existe só em memória, jamais logado/persistido */
  apiKey: string;
  defaultModel: string | null;
  params: Record<string, unknown>;
  enabledModels: string[];
  orcamento: OrcamentoDaOrg;
  /**
   * `null` = a leitura do orçamento foi normal. Não-nulo = a causa, já pronta
   * para log, de o resolvedor ter caído na query legada.
   *
   * UM campo e não um par `boolean` + `string`: dois campos que só fazem
   * sentido juntos são dois campos que podem discordar. Não-nulo já significa
   * "indisponível", e ainda carrega o PORQUÊ — que é o que separa falhar
   * ABERTO na informação de falhar em silêncio.
   */
  orcamentoIndisponivelPorque: string | null;
}

// Leitura DEFENSIVA de organizations.settings->'llm' (jsonb livre): campo com
// shape errado cai no default, nunca derruba o turno.
//
// `monthly_budget_cents` SAIU daqui (migration 0159): o teto deixou de morar
// num escalar de jsonb livre lido por dois `.catch()` — onde valor com forma
// errada virava `null` e `null` era ilimitado, isto é, o campo que protegia
// falhava ABERTO por construção — e passou a morar em `ai_budgets`, com CHECK,
// tela, RLS e auditoria. Os demais `.catch()` ficam: são a defesa certa para o
// que continua sendo jsonb livre.
const llmSettingsSchema = z
  .object({
    provider: z.string().min(1).catch('anthropic'),
    default_model: z.string().min(1).nullable().catch(null),
    params: z.record(z.string(), z.unknown()).catch({}),
    enabled_models: z.array(z.string()).catch([]),
  })
  .passthrough()
  .catch({
    provider: 'anthropic',
    default_model: null,
    params: {},
    enabled_models: [],
  });

/**
 * A leitura em UMA ida ao banco: os knobs de jsonb e o teto, `left join` na PK
 * de uma tabela de uma linha por organização — o mesmo round-trip que a query
 * anterior fazia sozinha.
 *
 * `left join` e nunca `join`: NENHUM gatilho de `organizations` semeia
 * `ai_budgets` (os produtores são o gatilho de `llm_calls`, os dois backfills
 * do baseline e o PATCH da tela). Um `join` faria organização sem linha
 * desaparecer da consulta e o resolvedor concluir "organização inexistente" —
 * derrubando toda chamada de IA dela.
 */
const SQL_CONFIG_COM_ORCAMENTO = `
  select o.settings->'llm'            as llm,
         b.monthly_limit_cents        as teto,
         b.enforcement_mode           as modo,
         b.enforcement_effective_at   as efetivo_em,
         b.alarm_threshold_pct        as limiar_pct
    from organizations o
    left join ai_budgets b on b.organization_id = o.id
   where o.id = $1`;

/** A query de antes da 0159 — a rede quando o schema do clone está atrasado. */
const SQL_CONFIG_LEGADO = `select settings->'llm' as llm from organizations where id = $1`;

interface LinhaDeConfig {
  llm: unknown;
  teto?: number | string | null;
  modo?: string | null;
  efetivo_em?: Date | null;
  limiar_pct?: number | string | null;
}

const ORCAMENTO_DESLIGADO: OrcamentoDaOrg = {
  modo: 'off',
  tetoCents: 0,
  efetivoEm: null,
  limiarPct: LIMIAR_PADRAO_PCT,
};

/**
 * O erro do Postgres em uma linha, para log. Leva o SQLSTATE porque é ele que
 * separa "o clone não aplicou o apêndice" (`42703`) de "o banco caiu" — e a
 * frase tranquilizadora ("orçamento indisponível") sem a causa manda a próxima
 * pessoa investigar do zero.
 */
function causaDoBanco(err: unknown): string {
  const codigo = (err as { code?: unknown } | null)?.code;
  const texto = err instanceof Error ? err.message : String(err);
  return `${typeof codigo === 'string' ? codigo : 'sem_sqlstate'}: ${texto}`.slice(0, 300);
}

/**
 * Resolve a config LLM da org: knobs de organizations.settings->'llm' + credencial
 * BYOK mais recente ativa/validada de ai_provider_credentials (decifrada com
 * aes_gcm). Sem BYOK → fallback cfg.anthropicApiKey (só anthropic). Sem nada →
 * LlmNotConfiguredError. Chamada a cada run — troca de config vale no run seguinte.
 */
/**
 * Override por-turno vindo da versão PUBLICADA do agente (Fase 2B): a tela
 * escolhe provider e credencial ESPECÍFICA; sem override, vale a config da org
 * (settings.llm + credencial mais recente do provider).
 */
export interface LlmResolveOverride {
  provider?: string;
  credentialId?: string | null;
}

export async function resolveOrgLlmConfig(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  organizationId: string,
  override?: LlmResolveOverride,
): Promise<OrgLlmConfig> {
  // ⚠️ O RESOLVEDOR NUNCA LANÇA POR SCHEMA DESATUALIZADO.
  //
  // `self-host-kit/update.sh` aplica o baseline com `|| true` e SEM
  // `ON_ERROR_STOP`, e só depois sobe a imagem nova. Um apêndice parcialmente
  // aplicado deixa a imagem nova consultando uma coluna que não existe — e um
  // throw aqui derrubaria TODA chamada de LLM de TODA organização daquele
  // clone, que é pior do que o estrangulamento que este trabalho existe para
  // evitar. É a mesma lei que o CLAUDE.md já escreve para a marca
  // ("Resolvedor NUNCA lança"), aplicada onde ela também vale.
  //
  // Uma query no caminho feliz; duas só no caminho quebrado. E a queda é
  // ABERTA NA AÇÃO (modo 'off' ⇒ ninguém é bloqueado por um erro de leitura) e
  // ABERTA NA INFORMAÇÃO (`orcamentoIndisponivelPorque` carrega a causa até o
  // log do seam) — nunca a frase tranquilizadora sozinha.
  let rows: LinhaDeConfig[];
  let orcamentoIndisponivelPorque: string | null = null;
  try {
    ({ rows } = await db.query<LinhaDeConfig>(SQL_CONFIG_COM_ORCAMENTO, [organizationId]));
  } catch (err) {
    orcamentoIndisponivelPorque = causaDoBanco(err);
    ({ rows } = await db.query<LinhaDeConfig>(SQL_CONFIG_LEGADO, [organizationId]));
  }
  if (rows.length === 0) {
    throw new Error('organização inexistente ao resolver config LLM');
  }
  const linha = rows[0];
  const settings = llmSettingsSchema.parse(linha?.llm ?? {});
  const provider = override?.provider ?? settings.provider;

  // Organização sem linha em `ai_budgets` cai aqui com tudo nulo, e o
  // normalizador resolve `modo` para 'off'. NULO É SEMPRE A RESPOSTA MAIS
  // FROUXA — em toda coluna, em todo caminho deste arquivo.
  const orcamento: OrcamentoDaOrg =
    orcamentoIndisponivelPorque !== null
      ? ORCAMENTO_DESLIGADO
      : {
          modo: normalizarModoDeOrcamento(linha?.modo),
          tetoCents: Number(linha?.teto ?? 0),
          efetivoEm: linha?.efetivo_em ?? null,
          limiarPct: Number(linha?.limiar_pct ?? LIMIAR_PADRAO_PCT),
        };

  // Credencial: a ESCOLHIDA na versão publicada quando houver (ainda exigindo
  // ativa+validada — publish valida, mas a credencial pode ser revogada depois);
  // senão a mais recente ativa/validada do provider. Sempre escopada pela org.
  const { rows: credRows } = override?.credentialId
    ? await db.query<{
        api_key_encrypted: unknown;
        api_key_iv: unknown;
        api_key_tag: unknown;
      }>(
        `select api_key_encrypted, api_key_iv, api_key_tag
         from ai_provider_credentials
         where organization_id = $1 and id = $2
           and is_active and validated_at is not null
         limit 1`,
        [organizationId, override.credentialId],
      )
    : await db.query<{
        api_key_encrypted: unknown;
        api_key_iv: unknown;
        api_key_tag: unknown;
      }>(
        `select api_key_encrypted, api_key_iv, api_key_tag
         from ai_provider_credentials
         where organization_id = $1 and provider = $2
           and is_active and validated_at is not null
         order by created_at desc
         limit 1`,
        [organizationId, provider],
      );

  let apiKey: string;
  const cred = credRows[0];
  if (cred !== undefined) {
    apiKey = decryptKey({
      ciphertext: byteaToBuffer(cred.api_key_encrypted),
      iv: byteaToBuffer(cred.api_key_iv),
      tag: byteaToBuffer(cred.api_key_tag),
    });
  } else if (provider === 'anthropic' && cfg.anthropicApiKey) {
    apiKey = cfg.anthropicApiKey;
  } else if (provider === 'openai' && cfg.openaiApiKey) {
    apiKey = cfg.openaiApiKey;
  } else if (provider === 'openrouter' && cfg.openrouterApiKey) {
    apiKey = cfg.openrouterApiKey;
  } else {
    throw new LlmNotConfiguredError();
  }

  return {
    provider,
    apiKey,
    defaultModel: settings.default_model ?? null,
    params: settings.params,
    enabledModels: settings.enabled_models,
    orcamento,
    orcamentoIndisponivelPorque,
  };
}
