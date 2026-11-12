/**
 * AUTORIDADE DE UM TOKEN DE MÓDULO (Spec 33, F3, tarefa 3).
 *
 * Um token de módulo só alcança, em cada organização, as áreas que o pacote DECLAROU **e** a
 * organização CONSENTIU, no modo certo (leitura ou escrita):
 *
 *     autoridade = declarado (manifesto do artefato) ∩ consentido (`consented_areas`) ∩ porta
 *
 * (o papel é aplicado depois por `resolveAuthDual`, que continua exigindo `ensureScope` e
 * `ensureRole`). Nada daqui mora no token e nada é guardado em cache: cada chamada lê o banco,
 * então consentimento retirado, módulo desligado ou instalação removida valem na requisição
 * seguinte.
 *
 * Fora da faixa `host_api` deste CRM (spec 33, F6) o token recusa com `module_incompatible`. A LEITURA DE
 * EVENTOS (`eventos-do-modulo.ts`) NÃO passa por aqui e não é bloqueada por incompatibilidade: a LGPD não
 * pode ficar presa a uma atualização do CRM (decisão D2 do plano p10).
 *
 * LADO SEGURO: qualquer dúvida recusa. Porta sem área, caminho que não se reconhece, linha que
 * não existe, erro de leitura, perfil que não é `connected`: tudo `{ ok: false }`. O módulo
 * nunca ganha poder por omissão.
 *
 * `organization_id` vem da LINHA DO TOKEN (fonte confiável, entregue pelo chamador), e toda
 * leitura filtra `organization_id` à mão porque usa o admin client (que ignora RLS).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  areaDaPorta,
  leituraExigeAreaContatos,
  SEGMENTOS_LITERAIS_CONHECIDOS,
} from "@/lib/auth/portas-de-token/areas";
import { permissaoDaArea } from "@/lib/extensions/areas";
import { checkCompatibility } from "@/lib/extensions/manifest";
import { createAdminClient } from "@/lib/supabase/admin";

export type CodigoDeRecusaDoModulo =
  | "module_area_not_granted"
  | "module_disabled"
  | "module_incompatible"
  | "module_authorization_unavailable";

/** Código de `/api/mcp` e de `contacts/route.ts`, que não aceitam token de módulo de jeito nenhum. */
export const MODULO_NAO_ENTRA_AQUI = "module_token_not_allowed_here";

/** `installationId` sai da LINHA DO TOKEN; o JWT de contexto (F3, tarefa 4) é conferido contra ele. */
export type ResultadoDoModulo =
  | { ok: true; installationId: string; contatoVisivel: boolean }
  | { ok: false; codigo: CodigoDeRecusaDoModulo };

export const MENSAGEM_DA_RECUSA_DO_MODULO: Record<
  CodigoDeRecusaDoModulo | typeof MODULO_NAO_ENTRA_AQUI,
  string
> = {
  module_area_not_granted: "Este módulo não tem permissão para esta área da organização.",
  module_disabled: "Este módulo está desligado, removido ou sem token ativo nesta organização.",
  module_incompatible:
    "Este módulo não é compatível com a versão atual do CRM e está suspenso. Peça ao responsável pela instalação para atualizar o módulo.",
  module_authorization_unavailable:
    "Não foi possível conferir a permissão do módulo agora. Nada foi feito.",
  module_token_not_allowed_here: "Token de módulo não é aceito nesta entrada.",
};

const NEGADO_AREA: ResultadoDoModulo = { ok: false, codigo: "module_area_not_granted" };
const NEGADO_DESLIGADO: ResultadoDoModulo = { ok: false, codigo: "module_disabled" };
const NEGADO_INCOMPATIVEL: ResultadoDoModulo = { ok: false, codigo: "module_incompatible" };
const NEGADO_INDISPONIVEL: ResultadoDoModulo = {
  ok: false,
  codigo: "module_authorization_unavailable",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEGMENTOS = 8;

/**
 * Do caminho REAL da requisição (`/api/v1/pipelines/<uuid>/stages`) ao modelo de porta
 * (`/api/v1/pipelines/[id]/stages`). O primeiro segmento é sempre literal. Nos demais, UUID e
 * número viram `[id]`; palavra conhecida das listas de `areas.ts` fica literal; o resto vira
 * `[id]`. Caminho torto (segmento vazio, `..`, `%`, colchete, barra invertida, longo demais)
 * devolve `null`, e `null` recusa.
 *
 * A rota que quiser dispensar esta dedução passa `portaModelo` a `resolveAuthDual`.
 */
export function modeloDoCaminho(pathname: string): string | null {
  const m = /^\/api\/v1\/(.+?)\/?$/.exec(pathname);
  if (!m) return null;
  const partes = m[1]!.split("/");
  if (partes.length > MAX_SEGMENTOS) return null;
  const saida: string[] = [];
  for (const [i, p] of partes.entries()) {
    if (p === "" || p === "." || p === ".." || /[%\\[\]]/.test(p)) return null;
    if (i === 0) saida.push(p);
    else if (UUID.test(p) || /^\d+$/.test(p)) saida.push("[id]");
    else if (SEGMENTOS_LITERAIS_CONHECIDOS.has(p)) saida.push(p);
    else saida.push("[id]");
  }
  return `/api/v1/${saida.join("/")}`;
}

export interface AutorizarModuloParams {
  /** Da LINHA DO TOKEN. */
  organizationId: string;
  /** `actor.id` do ator `module`: o id da linha em `api_tokens`. A instalação sai daquela linha. */
  tokenId: string;
  metodo: string;
  /** Modelo de porta conhecido da rota (`/api/v1/leads/[id]`). Tem precedência sobre `caminho`. */
  modeloDaPorta?: string;
  /** Caminho real da requisição, de onde o modelo é deduzido quando a rota não o informa. */
  caminho?: string;
  /** Só para teste; o padrão é o admin client. */
  supabase?: SupabaseClient;
}

function um<T>(valor: T | T[] | null | undefined): T | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}

function permissoesDeAreaDoManifesto(manifesto: unknown): { connected: boolean; areas: string[] } {
  if (typeof manifesto !== "object" || manifesto === null) return { connected: false, areas: [] };
  const m = manifesto as { profile?: unknown; permissions?: unknown };
  const lista = Array.isArray(m.permissions) ? m.permissions : [];
  return {
    connected: m.profile === "connected",
    areas: lista.filter((p): p is string => typeof p === "string" && p.startsWith("area.")),
  };
}

/**
 * A faixa `host_api` do pacote contra a versão DESTE CRM (spec 33, F6). Relida a cada chamada, sem cache:
 * quando o CRM sobe de `host_api`, o token do módulo deixa de valer na requisição seguinte, mesmo que o
 * token continue vivo. Manifesto que não se consegue ler (sem faixa numérica, sem lista de permissões)
 * é `ilegivel`, e quem chama recusa: a dúvida nunca dá poder.
 */
function compatibilidadeDoManifesto(manifesto: unknown): "compativel" | "incompativel" | "ilegivel" {
  if (typeof manifesto !== "object" || manifesto === null) return "ilegivel";
  const m = manifesto as { host_api?: { min?: unknown; max?: unknown }; permissions?: unknown };
  const min = m.host_api?.min;
  const max = m.host_api?.max;
  if (typeof min !== "number" || typeof max !== "number") return "ilegivel";
  if (!Array.isArray(m.permissions)) return "ilegivel";
  const r = checkCompatibility({
    host_api: { min, max },
    permissions: m.permissions as never,
    profile: "connected",
  });
  return r.compatible ? "compativel" : "incompativel";
}

export async function autorizarModulo(p: AutorizarModuloParams): Promise<ResultadoDoModulo> {
  try {
    // 1. A porta. Sem modelo ou sem área ⇒ recusa, antes de tocar o banco.
    const modelo = p.modeloDaPorta ?? (p.caminho ? modeloDoCaminho(p.caminho) : null);
    if (!modelo) return NEGADO_AREA;
    const porta = areaDaPorta(modelo, p.metodo);
    if (!porta) return NEGADO_AREA;
    const exigida = permissaoDaArea(porta.area, porta.modo);

    const supabase = p.supabase ?? createAdminClient();

    // 2. A instalação vem da LINHA DO TOKEN (nunca do cliente), e o token tem de estar vivo.
    const { data: token, error: erroToken } = await supabase
      .from("api_tokens")
      .select("extension_installation_id, module_slug, revoked_at")
      .eq("organization_id", p.organizationId)
      .eq("id", p.tokenId)
      .maybeSingle();
    if (erroToken) return NEGADO_INDISPONIVEL;
    if (!token || token.revoked_at || !token.extension_installation_id || !token.module_slug) {
      return NEGADO_DESLIGADO;
    }
    const installationId = token.extension_installation_id as string;

    // 3. Instalação (+ manifesto do artefato) e vínculo com a organização, sem cache.
    const [inst, vinculo] = await Promise.all([
      supabase
        .from("extension_installations")
        .select("publisher, name, disabled_at, removed_at, extension_artifacts!extension_installations_artifact_id_fkey(manifest)")
        .eq("id", installationId)
        .maybeSingle(),
      supabase
        .from("organization_extensions")
        .select("enabled, consented_areas")
        .eq("organization_id", p.organizationId)
        .eq("installation_id", installationId)
        .maybeSingle(),
    ]);
    if (inst.error || vinculo.error) return NEGADO_INDISPONIVEL;
    if (!inst.data || !vinculo.data) return NEGADO_DESLIGADO;
    if (inst.data.disabled_at || inst.data.removed_at || vinculo.data.enabled !== true) {
      return NEGADO_DESLIGADO;
    }
    // O token tem de ser MESMO desta instalação (slug do token = publicador/nome da instalação).
    if (token.module_slug !== `${inst.data.publisher}/${inst.data.name}`) return NEGADO_DESLIGADO;

    const artefato = um(inst.data.extension_artifacts as { manifest?: unknown } | null);
    const { connected, areas: declaradas } = permissoesDeAreaDoManifesto(artefato?.manifest);
    if (!connected) return NEGADO_AREA;
    // Fora da faixa `host_api` deste CRM o módulo está suspenso: código próprio, antes de olhar áreas.
    const compat = compatibilidadeDoManifesto(artefato?.manifest);
    if (compat === "incompativel") return NEGADO_INCOMPATIVEL;
    if (compat === "ilegivel") return NEGADO_INDISPONIVEL;
    const consentidas: unknown = vinculo.data.consented_areas;
    if (!Array.isArray(consentidas)) return NEGADO_AREA;

    // 4. declarado ∩ consentido, no modo da porta.
    if (declaradas.includes(exigida) && consentidas.includes(exigida)) {
      // O módulo enxerga contato (nome, telefone, etiquetas…) DENTRO de conversas, negócios e agenda só se
      // a área `contatos` também foi declarada e consentida, em leitura: o consentimento por área vale para
      // o dado que vem dentro da resposta, e não só para a rota (ADR-0005 D4).
      const contatos = permissaoDaArea("contatos", "leitura");
      const contatoVisivel = declaradas.includes(contatos) && consentidas.includes(contatos);
      // Leitura que embute contato e não passa pelo redator: sem `contatos`, a porta fecha.
      if (!contatoVisivel && leituraExigeAreaContatos(modelo, p.metodo)) return NEGADO_AREA;
      return { ok: true, installationId, contatoVisivel };
    }
    return NEGADO_AREA;
  } catch {
    return NEGADO_INDISPONIVEL;
  }
}
