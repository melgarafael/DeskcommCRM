import { createAdminClient } from "@/lib/supabase/admin";
import { lerLoginCodexRenovandoSeProxima } from "@/lib/ai/credenciais/login-codex";
import { OPENAI_CODEX_MODELS_ENDPOINT } from "@/lib/agent-engine/edge/llm/providers";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";

export interface ModeloDaAssinatura {
  provider: typeof PROVEDOR_POR_ASSINATURA;
  model_id: string;
  display_name: string;
  description: null;
  context_window: null;
  input_price_per_million_cents: null;
  output_price_per_million_cents: null;
  supports_tools: boolean;
  supports_vision: boolean;
  is_default_for_provider: false;
  deprecated_at: null;
}

/**
 * A LISTAGEM FALHOU — E A FALHA AGORA TEM FACE (#2602).
 *
 * Antes, qualquer falha virava `null` (ou `[]` num formato que não
 * conhecíamos) em silêncio: a rota respondia "Conecte a assinatura do ChatGPT"
 * para uma conta que ESTAVA conectada, e `models_available` ficava `null` para
 * sempre — todo "Publicar" respondia `model_not_found` sem que ninguém visse
 * o 403 que causava tudo.
 *
 * O erro carrega o MOTIVO (`http_403`, `formato_de_resposta_desconhecido`,
 * `sem_resposta_do_backend_do_codex`) e o status HTTP quando houver; a rota do
 * editor do agente o repassa ao operador. Em NENHUM caminho de falha o espelho
 * `models_available` é tocado: apagar uma lista válida a partir de uma resposta
 * que não entendemos é como o publish quebra de verdade (#2456).
 */
export class FalhaAoListarModelosDaAssinatura extends Error {
  readonly motivo: string;
  readonly status: number | null;

  constructor(motivo: string, opcoes?: { status?: number; cause?: unknown }) {
    super(`listagem de modelos da assinatura falhou: ${motivo}`, { cause: opcoes?.cause });
    this.name = "FalhaAoListarModelosDaAssinatura";
    this.motivo = motivo;
    this.status = opcoes?.status ?? null;
  }
}

/**
 * A URL da listagem. O `client_version` é o parâmetro que o próprio Codex CLI
 * envia ao backend (`?client_version=0.160.1` na medição da #2602); sem um
 * token real não dá para medir se o backend o exige, então ele só viaja quando
 * `CODEX_CLIENT_VERSION` está declarado — knob de fuga, não default.
 */
function urlDaListagem(): string {
  const cliente = process.env.CODEX_CLIENT_VERSION?.trim();
  return cliente
    ? `${OPENAI_CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(cliente)}`
    : OPENAI_CODEX_MODELS_ENDPOINT;
}

/**
 * Busca os modelos que a conta ChatGPT autorizou a listar, sempre no tenant atual.
 *
 * O destino é o BACKEND DO CODEX (`OPENAI_CODEX_MODELS_ENDPOINT`), não a API
 * pública: medido na #2602 com o mesmo token da assinatura, `/v1/models` na
 * `api.openai.com` devolve 403 `Missing scopes: api.model.read` e o backend do
 * Codex devolve 200 com `{ models: [{ slug, visibility: "list" }] }` — o
 * formato que a interpretação de baixo já conhece.
 *
 * `null` continua significando UMA coisa só: não há conta conectada nesta
 * organização. Tudo mais (rede, HTTP fora de 200, formato desconhecido) é
 * `FalhaAoListarModelosDaAssinatura`, visível para quem chamou.
 */
export async function listarModelosDaAssinatura(orgId: string): Promise<ModeloDaAssinatura[] | null> {
  const admin = createAdminClient();
  const tokens = await lerLoginCodexRenovandoSeProxima({ admin, orgId });
  if (!tokens) return null;

  let response: Response;
  try {
    response = await fetch(urlDaListagem(), {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      cache: "no-store",
    });
  } catch (cause) {
    // Sem resposta não há o que interpretar — e voltar `null` daqui fazia a
    // rota acusar a conta conectada. Erro visível, espelho intocado.
    throw new FalhaAoListarModelosDaAssinatura("sem_resposta_do_backend_do_codex", { cause });
  }
  if (!response.ok) {
    // O 403 MEDIDO da #2602 (endpoint errado) caía exatamente aqui. Ele tinha
    // de aparecer, não virar "Conecte a assinatura" em silêncio.
    throw new FalhaAoListarModelosDaAssinatura(`http_${response.status}`, { status: response.status });
  }

  const body: unknown = await response.json().catch(() => null);
  // Um 200 em formato que não conhecemos não é "a conta não tem modelos":
  // gravar `[]` a partir dele apagaria a lista válida e travaria todo
  // "Publicar" da empresa. Erro visível e o espelho intacto — o `[]` silencioso
  // que existia aqui escondia do operador que nada foi listado (#2456, #2602).
  if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) {
    throw new FalhaAoListarModelosDaAssinatura("formato_de_resposta_desconhecido");
  }
  const rows: unknown[] = body.models;
  const models = rows.flatMap((row: unknown): ModeloDaAssinatura[] => {
    if (!row || typeof row !== "object") return [];
    const model = row as { slug?: unknown; id?: unknown; display_name?: unknown; visibility?: unknown };
    const modelId = typeof model.slug === "string" ? model.slug : typeof model.id === "string" ? model.id : null;
    if (!modelId || model.visibility !== "list") return [];
    return [{
      provider: PROVEDOR_POR_ASSINATURA,
      model_id: modelId,
      display_name: typeof model.display_name === "string" ? model.display_name : modelId,
      description: null,
      context_window: null,
      input_price_per_million_cents: null,
      output_price_per_million_cents: null,
      // O endpoint autenticado só lista modelos liberados para uso de chat; a
      // assinatura os executa pelo mesmo runtime OpenAI com tool calling.
      supports_tools: true,
      supports_vision: true,
      is_default_for_provider: false,
      deprecated_at: null,
    }];
  });

  // Espelho por organização para a validação SQL de publicação dos agentes.
  const { data: credential } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA)
    .eq("is_active", true)
    .maybeSingle();
  if (credential?.id) {
    await admin
      .from("ai_provider_credentials")
      .update({ models_available: models.map((model) => model.model_id) })
      .eq("id", credential.id)
      .eq("organization_id", orgId);
  }
  return models;
}

/**
 * A MESMA listagem para os call sites onde ela ALIMENTA uma tela, não decide
 * uma ação: a tela de Credenciais desenha a lista e o classificador de modelo
 * acrescenta o que a conta tem. Uma falha do backend do Codex ali não pode
 * derrubar a rota inteira — vira `[]` e log com o MESMO motivo que a rota do
 * editor do agente mostra como erro (#2602: visível, ainda que cada chamada
 * decida o que fazer com a visibilidade).
 */
export async function listarModelosDaAssinaturaOuVazio(orgId: string): Promise<ModeloDaAssinatura[]> {
  try {
    return (await listarModelosDaAssinatura(orgId)) ?? [];
  } catch (erro) {
    console.warn(
      "modelos-da-assinatura: listagem falhou",
      erro instanceof FalhaAoListarModelosDaAssinatura ? erro.motivo : erro,
    );
    return [];
  }
}
