/**
 * GET /api/v1/contacts/compare?ids=<uuid>,<uuid> — duas fichas lado a lado (Spec 31, PR A).
 *
 * A tela "Parecidos — confira" precisa das PROVAS antes de juntar ou dispensar: nome,
 * telefones, categoria, endereço, site, redes, Maps, origem, conversas e negócios.
 * Esta rota devolve só isso, e só dessas duas fichas.
 *
 * ─── De quem é cada leitura ─────────────────────────────────────────────────────
 * - A ficha, conversas e negócios: cliente da SESSÃO (cookie). A RLS decide o que a
 *   pessoa enxerga, e o `organization_id` da sessão entra no filtro mesmo assim.
 * - A prospecção: cliente ADMINISTRADOR, porque `prospecting_candidates` só tem grant
 *   para `service_role` (C17 da Spec 31). Não se dá grant novo à tabela. O filtro é
 *   a organização da sessão e só os ids que a leitura da sessão devolveu — nunca um
 *   id que a pessoa não enxerga.
 *
 * Qualquer papel que enxerga contatos pode comparar: é leitura, como a lista de
 * duplicados. Juntar e dispensar têm o gate de gestor nas rotas próprias.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { nomeDoContatoParaComparar } from "@/lib/contacts/duplicados";
import { linksParaExibir } from "@/lib/leads/links-de-contato";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS_DA_FICHA =
  "id, name, display_name, address_book_name, email, phone_number, source, source_metadata, custom_fields, created_at, last_activity_at, is_merged_into, is_anonymized";

/** Exatamente duas fichas, e duas diferentes. UUID sem caixa: a comparação ignora maiúsculas. */
const idsDaComparacao = z
  .array(z.string().uuid())
  .length(2)
  // O `refine` roda mesmo quando o `length(2)` já falhou (problema não fatal no Zod):
  // com um id só, `ids[1]` é `undefined` — por isso o `?.`.
  .refine((ids) => ids[0]?.toLowerCase() !== ids[1]?.toLowerCase(), {
    message: "As duas fichas precisam ser diferentes.",
  });

interface LinhaDaFicha {
  id: string;
  name: string | null;
  display_name: string | null;
  address_book_name: string | null;
  email: string | null;
  phone_number: string | null;
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  custom_fields: Record<string, unknown> | null;
  created_at: string;
  last_activity_at: string | null;
  is_merged_into: string | null;
  is_anonymized: boolean;
}

interface Prospeccao {
  categorias: string[];
  enderecos: string[];
  sites: string[];
  redes: string[];
  emails: string[];
  telefones: string[];
  maps: string[];
}

/** Texto não vazio, aparado — ou `null`. O JSON da prospecção não é confiável por forma. */
function textoDe(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

function listaDe(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.map(textoDe).filter((v): v is string => v !== null);
}

/**
 * Junta os dados que a prospecção achou para a ficha, sem repetir. Uma ficha pode ter
 * mais de um candidato (campanhas diferentes): o que cada um acha entra na mesma lista.
 */
function prospeccaoDe(candidatos: Array<{ contact_id: string; data: unknown }>, contatoId: string): Prospeccao {
  const categorias = new Set<string>();
  const enderecos = new Set<string>();
  const sites = new Set<string>();
  const redes = new Set<string>();
  const emails = new Set<string>();
  const telefones = new Set<string>();
  const maps = new Set<string>();
  for (const candidato of candidatos) {
    if (candidato.contact_id !== contatoId) continue;
    const dado = (candidato.data ?? {}) as Record<string, unknown>;
    const categoria = textoDe(dado.category);
    if (categoria) categorias.add(categoria);
    const endereco = textoDe(dado.address);
    if (endereco) enderecos.add(endereco);
    const site = textoDe(dado.website);
    if (site) sites.add(site);
    for (const rede of listaDe(dado.socials)) redes.add(rede);
    for (const email of listaDe(dado.emails)) emails.add(email);
    const telefone = textoDe(dado.phone);
    if (telefone) telefones.add(telefone);
    const mapa = textoDe(dado.maps_url);
    if (mapa) maps.add(mapa);
  }
  return {
    categorias: [...categorias],
    enderecos: [...enderecos],
    sites: [...sites],
    redes: [...redes],
    emails: [...emails],
    telefones: [...telefones],
    maps: [...maps],
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const user = await loadAuthUser();
  if (!user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const ativa = await orgAtivaDaApi(user, requestId);
  if (!ativa.ok) return ativa.response;
  const org = ativa.org;
  if (!org) {
    return fail("forbidden_tenant", "Organização ativa não resolvida.", 403, { requestId });
  }

  const pedidos = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const validos = idsDaComparacao.safeParse(pedidos);
  if (!validos.success) {
    return fail("validation_error", "Compare exatamente duas fichas diferentes: ?ids=<id>,<id>.", 422, {
      requestId,
    });
  }
  const ids = validos.data.map((id) => id.toLowerCase());

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select(COLUNAS_DA_FICHA)
    .eq("organization_id", org.orgId)
    .in("id", ids);
  if (error) {
    return fail("internal_error", "Não foi possível ler as fichas.", 500, { requestId });
  }

  // Lápide e anonimizada não se comparam: a primeira já virou outra ficha, a segunda
  // não tem mais dado. Contam como não encontradas.
  const lidas = ((data ?? []) as unknown as LinhaDaFicha[]).filter(
    (c) => c.is_merged_into === null && !c.is_anonymized,
  );
  const porId = new Map(lidas.map((c) => [c.id, c] as const));
  const fichas = ids.map((id) => porId.get(id)).filter((c): c is LinhaDaFicha => c !== undefined);
  if (fichas.length < 2) {
    return fail("not_found", "Uma das fichas não está disponível para comparação.", 404, { requestId });
  }

  // Conversas e negócios: contagem exata, filtrada pela organização da sessão.
  const contagens = new Map<string, { conversas: number; negocios: number }>();
  for (const ficha of fichas) {
    const [conversas, negocios] = await Promise.all([
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.orgId)
        .eq("contact_id", ficha.id),
      supabase
        .from("crm_leads")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.orgId)
        .eq("contact_id", ficha.id),
    ]);
    if (conversas.error || negocios.error) {
      return fail("internal_error", "Não foi possível contar conversas e negócios.", 500, { requestId });
    }
    contagens.set(ficha.id, { conversas: conversas.count ?? 0, negocios: negocios.count ?? 0 });
  }

  // Prospecção: o administrador, mas só para os ids que a SESSÃO acabou de ler, e só da
  // organização da sessão. Sem grant novo em `prospecting_candidates` (C17).
  const idsLidos = fichas.map((f) => f.id);
  const { data: candidatos, error: erroDaProspeccao } = await createAdminClient()
    .from("prospecting_candidates")
    .select("contact_id, data")
    .eq("organization_id", org.orgId)
    .in("contact_id", idsLidos);
  if (erroDaProspeccao) {
    return fail("internal_error", "Não foi possível ler os dados da prospecção.", 500, { requestId });
  }
  const achadosDaProspeccao = (candidatos ?? []) as Array<{ contact_id: string; data: unknown }>;

  return ok(
    {
      contatos: fichas.map((ficha) => {
        const contagem = contagens.get(ficha.id) ?? { conversas: 0, negocios: 0 };
        return {
          id: ficha.id,
          nome: nomeDoContatoParaComparar(ficha),
          name: ficha.name,
          display_name: ficha.display_name,
          address_book_name: ficha.address_book_name,
          phone_number: ficha.phone_number,
          email: ficha.email,
          source: ficha.source,
          maps_url: textoDe(ficha.source_metadata?.["maps_url"]),
          created_at: ficha.created_at,
          last_activity_at: ficha.last_activity_at,
          conversas: contagem.conversas,
          negocios: contagem.negocios,
          links: linksParaExibir(ficha.custom_fields),
          prospeccao: prospeccaoDe(achadosDaProspeccao, ficha.id),
        };
      }),
    },
    { requestId },
  );
}
