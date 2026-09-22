/**
 * POST /api/v1/prospecting/prospects/import-arquivo — ponte do Google Maps Scraper.
 *
 * A tela lê o Export JSON do userscript (Tampermonkey), mapeia para o
 * contrato (`lib/prospeccao/importacao-maps.ts`) e manda os negócios + a
 * categoria da importação. Aqui cai no MESMO dedup/score/insert do tick
 * (`importarNegociosDeArquivo`): arquivo nunca duplica nem furta a fila das
 * buscas — provider `maps_arquivo` tem identidade própria no unique.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { importarNegociosDeArquivo } from "@/lib/prospeccao/motor";
import { arquivoMapsSchema } from "@/lib/schemas/prospeccao";
import type { NegocioDescoberto } from "@/lib/prospeccao/tipos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "business_prospects" });
  if (!authz.ok) return authz.response;

  const parsed = arquivoMapsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Arquivo inválido (categoria + até 500 negócios).", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const brutos: NegocioDescoberto[] = parsed.data.negocios.map((n) => ({
    idExterno: n.idExterno ?? null,
    nome: n.nome,
    categoriaPrincipal: n.categoriaPrincipal ?? null,
    categoriasSecundarias: n.categoriasSecundarias ?? [],
    telefone: n.telefone ?? null,
    website: n.website ?? null,
    email: n.email ?? null,
    endereco: n.endereco ?? null,
    bairro: n.bairro ?? null,
    cidade: n.cidade ?? null,
    estado: n.estado ?? null,
    cep: n.cep ?? null,
    pais: n.pais ?? "BR",
    latitude: n.latitude ?? null,
    longitude: n.longitude ?? null,
    urlExterna: n.urlExterna ?? null,
    nota: n.nota ?? null,
    totalAvaliacoes: n.totalAvaliacoes ?? 0,
    horarioFuncionamento: null,
  }));

  const admin = createAdminClient();
  const resultado = await importarNegociosDeArquivo(admin, authz.org.orgId, parsed.data.categoria, brutos);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "prospect.importado_arquivo",
    resourceType: "business_prospects",
    resourceId: null,
    requestId,
  });

  return ok({ ...resultado, total: brutos.length }, { requestId, status: 201 });
}
