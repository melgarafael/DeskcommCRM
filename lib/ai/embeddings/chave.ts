/**
 * DE ONDE VEM A CHAVE QUE INDEXA E CONSULTA O SEU MATERIAL.
 *
 * ## O defeito que este arquivo existe para acabar
 *
 * `lib/ai/embed.ts` lia `AI_GATEWAY_API_KEY`/`OPENAI_API_KEY` do `process.env` e
 * mais nada. Ou seja: **cadastrar a chave da OpenAI pela tela não habilitava a
 * base de conhecimento.** Só editar o `.env` da instalação habilitava.
 *
 * Isso é pior do que parece, porque o produto PROMETE o contrário em dois
 * lugares que a pessoa lê antes de tentar:
 *
 *  - `lib/ai/pontos/provedores.ts` descreve a OpenAI como *"necessário para
 *    transcrever áudio e **para indexar o seu material**"*;
 *  - o painel `/app/ai/providers` lista `embedding_indexar` e
 *    `embedding_consultar` entre os pontos de IA da organização.
 *
 * Tela que oferece e motor que ignora é o anti-pattern que este repo mais
 * persegue. E o desfecho era mudo: sem chave o worker devolvia
 * `skipped: openai_key_missing`, o drain tratava `skipped` como sucesso, e a
 * linha da fonte continuava dizendo `status='ready'` para sempre.
 *
 * ## A escada, do mais específico ao mais genérico
 *
 *  1. **Binding do ponto** (`ai_purpose_bindings`) — a escolha explícita feita
 *     no painel de provedores. É a superfície que o operador enxerga, então ela
 *     vence.
 *  2. **Credencial OpenAI da organização** (`ai_provider_credentials`, ativa e
 *     validada). É o degrau que faz "cadastrei a chave na tela e funcionou"
 *     virar verdade sem exigir que ninguém entenda o que é um binding.
 *  3. **Gateway da Vercel** (`AI_GATEWAY_API_KEY`) — quando a instalação roteia
 *     tudo por ele.
 *  4. **Chave da instalação** (`OPENAI_API_KEY`) — o que o `install.sh` pede.
 *  5. Nada. E "nada" é uma resposta legítima que o chamador precisa saber
 *     mostrar, não um erro para engolir.
 *
 * A decisão devolve a ORIGEM junto com a chave. Não é enfeite: é o que permite
 * a tela responder *"está usando a chave X **porque**…"* em vez de deixar o dono
 * do negócio adivinhando por que a indexação não anda.
 *
 * ## O modelo NÃO é escolha
 *
 * `text-embedding-3-small`, 1536 dimensões, dos dois lados. Indexação e busca
 * são coordenadas de um mesmo mapa: trocar só um lado não dá erro nenhum — o
 * agente simplesmente para de achar o seu conteúdo. É por isso que o binding
 * aqui governa a CHAVE e não o MODELO, e por isso que a versão de índice grava
 * com que modelo foi calculada (`ai_knowledge_versions.embedding_model`).
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** Os dois pontos de IA que consomem embedding (`lib/ai/pontos/registro.ts`). */
export type PontoDeEmbedding = "embedding_indexar" | "embedding_consultar";

/** Pin de contrato do provedor PADRÃO (OpenAI). Mantido para compatibilidade. */
export const MODELO_DE_EMBEDDING = "openai/text-embedding-3-small";
export const DIMENSOES_DO_EMBEDDING = 1536;

/**
 * O par modelo+dimensão por provedor. A dimensão é 1536 nos dois — o Google vem
 * com `outputDimensionality: 1536` —, então a coluna `ai_chunks.embedding` NÃO
 * muda ao trocar de provedor. Trocar de provedor, porém, EXIGE reindexar: a
 * busca casa o `embedding_model` gravado na versão (migration 0181), e vetores
 * de modelos diferentes não são comparáveis.
 */
export type ProvedorDeEmbedding = "openai" | "google";

export const MODELO_DE_EMBEDDING_POR_PROVEDOR: Record<
  ProvedorDeEmbedding,
  { model: string; dims: number }
> = {
  openai: { model: MODELO_DE_EMBEDDING, dims: DIMENSOES_DO_EMBEDDING },
  google: { model: "google/gemini-embedding-001", dims: 1536 },
};

/** O provedor do embedding é um dos que sabem fazer embedding? */
export function ehProvedorDeEmbedding(p: string): p is ProvedorDeEmbedding {
  return p === "openai" || p === "google";
}

export type OrigemDaChave =
  | "binding_do_ponto"
  | "credencial_da_organizacao"
  | "gateway_da_instalacao"
  | "chave_da_instalacao";

export const EXPLICACAO_DA_ORIGEM: Record<OrigemDaChave, string> = {
  binding_do_ponto: "Escolhida por você no painel de Provedores.",
  credencial_da_organizacao: "Usando a chave OpenAI cadastrada em Credenciais.",
  gateway_da_instalacao: "Usando o gateway de IA configurado nesta instalação.",
  chave_da_instalacao: "Usando a chave que veio na instalação.",
};

export interface ChaveDeEmbedding {
  /** Plaintext. Vive só no escopo de quem chamou — nunca logada nem persistida. */
  apiKey: string | null;
  /** `null` = endpoint oficial do provedor. */
  baseUrl: string | null;
  /** Quando true, a chamada vai pelo gateway (o SDK lê a chave do process.env). */
  viaGateway: boolean;
  origem: OrigemDaChave;
  /** Rótulo da credencial, quando houver — a tela mostra qual chave está valendo. */
  rotulo: string | null;
  /** Incoerências que não impedem a chamada mas alguém precisa ver. */
  avisos: string[];
  /** Provedor de embedding efetivo (decide qual SDK chama). */
  provider: ProvedorDeEmbedding;
  /** Id qualificado do modelo (ex.: `openai/text-embedding-3-small`). */
  model: string;
  /** Dimensão do vetor (contrato da coluna `vector`). */
  dims: number;
}

/**
 * Resolve a chave de embedding da organização, ou `null` quando não há nenhuma.
 *
 * `organizationId` é obrigatório: um resolvedor que aceitasse organização
 * opcional acabaria chamado sem ela justamente no caminho que mais importa,
 * aplicando a configuração de ninguém.
 */
export async function resolverChaveDeEmbedding(
  organizationId: string,
  ponto: PontoDeEmbedding = "embedding_indexar",
): Promise<ChaveDeEmbedding | null> {
  const avisos: string[] = [];

  // 1 · A escolha explícita do painel.
  const binding = await lerBindingDeEmbedding(ponto, organizationId);
  if (binding?.credential_id) {
    const credencial = await decifrarCredencial(binding.credential_id, organizationId);
    if (credencial && ehProvedorDeEmbedding(credencial.provider)) {
      const provider = credencial.provider;
      // O modelo vem do binding SÓ quando ele é um modelo de embedding; senão
      // vale o par do provedor. (Só o par indexador×consulta é que precisa casar;
      // aqui é o id que vai para a proveniência da versão e para a busca.)
      const modeloDoBinding =
        binding.model_id && /embed/i.test(binding.model_id) ? binding.model_id : null;
      const padrao = MODELO_DE_EMBEDDING_POR_PROVEDOR[provider];
      return {
        apiKey: credencial.apiKey,
        baseUrl: binding.base_url,
        viaGateway: false,
        origem: "binding_do_ponto",
        rotulo: credencial.rotulo,
        avisos,
        provider,
        model: modeloDoBinding ?? padrao.model,
        dims: padrao.dims,
      };
    }
    if (credencial && !ehProvedorDeEmbedding(credencial.provider)) {
      avisos.push(
        `A credencial escolhida no painel é do provedor "${credencial.provider}", que não tem ` +
          "endpoint de embeddings. Escolha OpenAI ou Google (Gemini) para a base de conhecimento.",
      );
    } else {
      avisos.push(
        "A chave escolhida no painel de Provedores para este ponto não está utilizável " +
          "(desativada, apagada ou ainda não validada). Seguindo com a próxima chave disponível.",
      );
    }
  }

  // 2 · A credencial OpenAI da organização, sem exigir binding nenhum (legado).
  const daOrg = await credencialOpenAiDaOrganizacao(organizationId);
  if (daOrg) {
    if (daOrg.quantas > 1) {
      avisos.push(
        `Esta organização tem ${daOrg.quantas} chaves OpenAI cadastradas e nenhuma escolhida para ` +
          `a base de conhecimento. Usando "${daOrg.rotulo}" — escolha uma em Provedores para não depender disso.`,
      );
    }
    const padrao = MODELO_DE_EMBEDDING_POR_PROVEDOR.openai;
    return {
      apiKey: daOrg.apiKey,
      baseUrl: null,
      viaGateway: false,
      origem: "credencial_da_organizacao",
      rotulo: daOrg.rotulo,
      avisos,
      provider: "openai",
      model: padrao.model,
      dims: padrao.dims,
    };
  }

  // 3 · O gateway da instalação. A chave não sai daqui: o SDK a lê do process.env.
  if (env.AI_GATEWAY_API_KEY) {
    const padrao = MODELO_DE_EMBEDDING_POR_PROVEDOR.openai;
    return {
      apiKey: null,
      baseUrl: env.AI_GATEWAY_BASE_URL || null,
      viaGateway: true,
      origem: "gateway_da_instalacao",
      rotulo: null,
      avisos,
      provider: "openai",
      model: padrao.model,
      dims: padrao.dims,
    };
  }

  // 4 · A chave que o install.sh pediu.
  if (env.OPENAI_API_KEY) {
    const padrao = MODELO_DE_EMBEDDING_POR_PROVEDOR.openai;
    return {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: null,
      viaGateway: false,
      origem: "chave_da_instalacao",
      rotulo: null,
      avisos,
      provider: "openai",
      model: padrao.model,
      dims: padrao.dims,
    };
  }

  return null;
}

/**
 * Existe chave utilizável para esta organização?
 *
 * Substitui `isEmbeddingProviderConfigured()`, cuja assinatura SEM organização
 * é a raiz do defeito: ela respondia "não" para toda organização que tivesse
 * cadastrado a chave pela tela.
 */
export async function temChaveDeEmbedding(organizationId: string): Promise<boolean> {
  return (await resolverChaveDeEmbedding(organizationId)) !== null;
}

// ---------------------------------------------------------------------------
// Leitura do banco — admin client, filtro de organização SEMPRE programático
// (o service role bypassa RLS; CLAUDE.md, anti-pattern 10).
// ---------------------------------------------------------------------------

interface LinhaDeBinding {
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
}

async function lerBindingDeEmbedding(
  ponto: PontoDeEmbedding,
  organizationId: string,
): Promise<LinhaDeBinding | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_purpose_bindings")
      .select("credential_id, model_id, base_url")
      .eq("organization_id", organizationId)
      .eq("purpose", ponto)
      .eq("is_enabled", true)
      .maybeSingle();
    return (data as LinhaDeBinding | null) ?? null;
  } catch (err) {
    // Tabela ausente (clone sem o baseline aplicado) não pode derrubar a
    // indexação — mas também não pode passar em silêncio.
    logger.warn("[embedding] não consegui ler o binding do ponto", {
      organization_id: organizationId,
      purpose: ponto,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function decifrarCredencial(
  credentialId: string,
  organizationId: string,
): Promise<{ apiKey: string; rotulo: string; provider: string } | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("provider, label, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("id", credentialId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .maybeSingle();
    if (!data) return null;
    return {
      apiKey: decryptKey({
        ciphertext: byteaToBuffer(data.api_key_encrypted),
        iv: byteaToBuffer(data.api_key_iv),
        tag: byteaToBuffer(data.api_key_tag),
      }),
      rotulo: String((data as { label?: string }).label ?? ""),
      provider: String((data as { provider?: string }).provider ?? "openai"),
    };
  } catch {
    // Sem detalhe no log: qualquer eco aqui corre o risco de carregar material
    // da credencial.
    return null;
  }
}

/**
 * A credencial OpenAI ativa e validada da organização.
 *
 * Desempate DETERMINÍSTICO pela mais antiga: com duas chaves e nenhuma escolha,
 * "a mais recente" faria o comportamento mudar sozinho no dia em que alguém
 * cadastrasse outra. A tela evita o caso oferecendo a escolha; aqui o que
 * importa é não variar.
 */
async function credencialOpenAiDaOrganizacao(
  organizationId: string,
): Promise<{ apiKey: string; rotulo: string; quantas: number } | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("id, label, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", "openai")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: true });

    const linhas = (data ?? []) as Array<{
      id: string;
      label: string;
      api_key_encrypted: unknown;
      api_key_iv: unknown;
      api_key_tag: unknown;
    }>;
    const primeira = linhas[0];
    if (!primeira) return null;

    return {
      apiKey: decryptKey({
        ciphertext: byteaToBuffer(primeira.api_key_encrypted),
        iv: byteaToBuffer(primeira.api_key_iv),
        tag: byteaToBuffer(primeira.api_key_tag),
      }),
      rotulo: primeira.label,
      quantas: linhas.length,
    };
  } catch {
    return null;
  }
}
