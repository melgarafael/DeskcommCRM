/**
 * QUAIS MÓDULOS CONECTADOS A ORGANIZAÇÃO PODE ABRIR NA TELA AGORA (Spec 33, F4, tarefa 1).
 *
 * Fonte única da rota `/app/m/[modulo]`, do grupo "Módulos" do menu, do ⌘K e do painel lateral.
 * Um módulo só aparece quando TODAS as condições valem agora, lidas do banco a cada chamada
 * (sem cache): perfil `connected`, vínculo da organização `enabled`, instalação sem
 * `disabled_at` e sem `removed_at`, pacote compatível com esta versão do CRM e endereço do
 * serviço (`service_origin`) presente e diferente do endereço do próprio CRM.
 *
 * ONDE MORA `service_origin`: na ENTRADA do catálogo admitido (`extension_catalogs.snapshot`,
 * jsonb), nunca no pacote. A instalação aponta para o catálogo por `catalog_id` e a entrada se
 * acha por publicador + nome + versão (`servicoDoModulo`).
 *
 * LADO SEGURO: qualquer dúvida (erro de leitura, pacote ou catálogo ilegível, origem igual à do
 * CRM) tira o módulo da lista, e erro de leitura devolve `[]`. O CRM segue inteiro.
 *
 * `organizationId` vem da SESSÃO (`requireRole`), nunca do corpo; o admin client ignora RLS,
 * então toda leitura de vínculo filtra `organization_id` à mão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { checkCompatibility, localize, validateCatalogSnapshot } from "./manifest";
import { servicoDoModulo } from "./servico-do-modulo";

export type ModuloNaTela = {
  /** `<publicador>-<nome>`, só `[a-z0-9-]`: cabe na URL `/app/m/<slug>`. */
  slug: string;
  titulo: string;
  icone: string;
  serviceOrigin: string;
  installationId: string;
};

export interface OpcoesModulosNaTela {
  /** Idioma da pessoa (`pt-BR` por padrão). */
  locale?: string;
  /** Só para teste; o padrão é o admin client. */
  supabase?: SupabaseClient;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function um<T>(valor: T | T[] | null | undefined): T | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

/** Origem do CRM; `null` (dúvida) tira todos os módulos da tela. */
function origemDoCrm(): string | null {
  try {
    return new URL(env.NEXT_PUBLIC_APP_URL).origin;
  } catch {
    return null;
  }
}

interface ManifestoLido {
  titulo: string;
  icone: string;
}

function lerManifesto(manifesto: unknown, locale: string): ManifestoLido | null {
  if (typeof manifesto !== "object" || manifesto === null) return null;
  const m = manifesto as {
    profile?: unknown;
    host_api?: { min?: unknown; max?: unknown };
    permissions?: unknown;
    display?: { title?: { "pt-BR"?: unknown; es?: unknown }; icon?: unknown };
  };
  if (m.profile !== "connected") return null;
  const min = m.host_api?.min;
  const max = m.host_api?.max;
  if (typeof min !== "number" || typeof max !== "number") return null;
  if (!Array.isArray(m.permissions)) return null;
  const compativel = checkCompatibility({
    host_api: { min, max },
    permissions: m.permissions as never,
    profile: "connected",
  });
  if (!compativel.compatible) return null;
  const pt = texto(m.display?.title?.["pt-BR"]);
  const icone = texto(m.display?.icon);
  if (!pt || !icone) return null;
  const es = texto(m.display?.title?.es) ?? undefined;
  return { titulo: localize({ "pt-BR": pt, ...(es ? { es } : {}) }, locale).text, icone };
}

export async function modulosNaTela(
  organizationId: string,
  opcoes: OpcoesModulosNaTela = {},
): Promise<ModuloNaTela[]> {
  try {
    if (!UUID.test(organizationId)) return [];
    const crm = origemDoCrm();
    if (!crm) return [];
    const locale = opcoes.locale ?? "pt-BR";
    const supabase = opcoes.supabase ?? createAdminClient();

    // 1. Vínculos ligados DESTA organização (filtro à mão, organização da sessão).
    const vinculos = await supabase
      .from("organization_extensions")
      .select("installation_id")
      .eq("organization_id", organizationId)
      .eq("enabled", true);
    if (vinculos.error) return [];
    const ids = (vinculos.data ?? [])
      .map((v) => (v as { installation_id?: unknown }).installation_id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return [];

    // 2. Instalações vivas, com o manifesto do artefato (FK explícita, como em autorizarModulo).
    const instalacoes = await supabase
      .from("extension_installations")
      .select(
        "id, catalog_id, publisher, name, version, disabled_at, removed_at, extension_artifacts!extension_installations_artifact_id_fkey(manifest)",
      )
      .in("id", ids);
    if (instalacoes.error) return [];
    const vivas = (instalacoes.data ?? []).filter((i) => {
      const r = i as { disabled_at?: unknown; removed_at?: unknown };
      return !r.disabled_at && !r.removed_at;
    });
    if (vivas.length === 0) return [];

    // 3. Catálogos admitidos, onde o endereço do serviço mora.
    const catalogIds = [
      ...new Set(vivas.map((i) => (i as { catalog_id?: unknown }).catalog_id)),
    ].filter((id): id is string => typeof id === "string");
    const catalogos = await supabase
      .from("extension_catalogs")
      .select("id, snapshot")
      .in("id", catalogIds);
    if (catalogos.error) return [];
    const snapshots = new Map<string, ReturnType<typeof validateCatalogSnapshot>>();
    for (const c of catalogos.data ?? []) {
      const linha = c as { id: string; snapshot: unknown };
      try {
        snapshots.set(linha.id, validateCatalogSnapshot(linha.snapshot));
      } catch {
        // catálogo ilegível nesta versão: os módulos dele ficam fora
      }
    }

    const saida: ModuloNaTela[] = [];
    for (const bruta of vivas) {
      const i = bruta as {
        id: string;
        catalog_id: string;
        publisher: string;
        name: string;
        version: string;
        extension_artifacts?: { manifest?: unknown } | Array<{ manifest?: unknown }> | null;
      };
      const manifesto = lerManifesto(um(i.extension_artifacts)?.manifest, locale);
      if (!manifesto) continue;
      const snapshot = snapshots.get(i.catalog_id);
      if (!snapshot) continue;
      const origem = servicoDoModulo(snapshot, i.publisher, i.name, i.version);
      if (!origem || origem === crm) continue;
      const slug = `${i.publisher}-${i.name}`;
      if (!SLUG.test(slug)) continue;
      saida.push({
        slug,
        titulo: manifesto.titulo,
        icone: manifesto.icone,
        serviceOrigin: origem,
        installationId: i.id,
      });
    }

    // Slug repetido (a-b + c contra a + b-c) é ambíguo: nenhum dos dois aparece.
    const contagem = new Map<string, number>();
    for (const m of saida) contagem.set(m.slug, (contagem.get(m.slug) ?? 0) + 1);
    return saida
      .filter((m) => contagem.get(m.slug) === 1)
      .sort((a, b) => a.titulo.localeCompare(b.titulo, locale) || a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
}
