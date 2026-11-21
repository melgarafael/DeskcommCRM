/**
 * GET /api/v1/reports/painel-de-vendas — os cartões e a série do painel de
 * vendas.
 *
 * A conta e as réguas (o que é venda, valor vendido, ticket médio, conversão e
 * série) estão em `lib/relatorios/painel-de-vendas.ts`, que é o contrato desta
 * rota. Aqui só se lê e se monta.
 *
 * ─── A mesma janela do Faturamento ──────────────────────────────────────────
 *
 * `de`/`ate` são DATAS (AAAA-MM-DD) na parede da organização, com o mesmo
 * padrão (mês corrente), o mesmo teto (`periodoPassaDoTeto`) e a mesma janela
 * semiaberta de `/api/v1/reports/comercial`. O painel e a lista de vendas logo
 * abaixo dele, na mesma tela, respondem ao mesmo período — nunca a dois.
 *
 * ─── Uma consulta ───────────────────────────────────────────────────────────
 *
 * Ganhos E perdidos fechados na janela, numa leitura paginada (`lerPaginado`,
 * teto declarado em `truncado`). Os perdidos entram só para a conversão.
 *
 * ─── SÓ LEITURA, e o escopo é a RLS ─────────────────────────────────────────
 *
 * Client de SESSÃO: `fn_can_view_lead` recorta o que cada pessoa vê (atendente,
 * os próprios negócios; gestor, a organização). O `organization_id` vai
 * explícito na consulta, e a organização vem do cookie validado em
 * `requireRole`, NUNCA da query. Read-only ⇒ sem audit.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { MOEDA_PADRAO } from "@/lib/money";
import {
  JANELA_MAXIMA_DIAS,
  janelaDoRelatorio,
  periodoPadrao,
  periodoPassaDoTeto,
} from "@/lib/relatorios/janela";
import { normalizarTagDoRelatorio } from "@/lib/relatorios/comercial";
import { montarPainelDeVendas, type NegocioDoPainel } from "@/lib/relatorios/painel-de-vendas";
import { lerPaginado } from "@/lib/supabase/pagina";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  de: z.iso.date({ message: "Data inicial inválida." }).optional(),
  ate: z.iso.date({ message: "Data final inválida." }).optional(),
  // O recorte — o MESMO de `/api/v1/reports/comercial`, com a mesma régua:
  // funil inexistente ou de outra organização não é erro, é recorte vazio.
  pipeline_id: z.uuid({ message: "Funil inválido." }).optional(),
  tag: z.string().trim().min(1, { message: "Tag inválida." }).max(100, { message: "Tag inválida." }).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso `viewer`: é leitura, e quem restringe por pessoa é a RLS.
  const authz = await requireRole("viewer", {
    requestId,
    resource: "reports",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    de: url.searchParams.get("de") || undefined,
    ate: url.searchParams.get("ate") || undefined,
    pipeline_id: url.searchParams.get("pipeline_id") || undefined,
    tag: url.searchParams.get("tag") || undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: t(i.message) })),
      requestId,
    });
  }

  const tz = org.timezone ?? "UTC";
  const padrao = periodoPadrao(new Date(), tz);
  const de = parsed.data.de ?? padrao.de;
  const ate = parsed.data.ate ?? padrao.ate;
  if (de > ate) {
    return fail("validation_failed", t("A data inicial é depois da final."), 422, { requestId });
  }
  if (periodoPassaDoTeto(de, ate)) {
    return fail("validation_failed", t("O período é maior do que este relatório cobre."), 422, {
      details: { maximo_dias: JANELA_MAXIMA_DIAS },
      requestId,
    });
  }

  const janela = janelaDoRelatorio(de, ate, tz);
  const supabase = await createClient();

  const leitura = await lerPaginado<NegocioDoPainel>(async (inicio, fim, contar) => {
    const { data, error, count } = await supabase
      .from("crm_leads")
      .select("status, closed_at, value_cents, currency, pipeline_id, tags", contar ? { count: "exact" } : undefined)
      .eq("organization_id", org.orgId)
      .in("status", ["won", "lost"])
      .gte("closed_at", janela.from)
      .lt("closed_at", janela.to)
      .order("closed_at", { ascending: false })
      .order("id", { ascending: true })
      .range(inicio, fim);
    return { data: (data ?? []) as NegocioDoPainel[], error, count: count ?? null };
  });
  if (leitura.erro) {
    // O erro SOBE: engolir transformaria falha de leitura em "não houve venda".
    return fail("internal_error", leitura.erro, 500, { requestId });
  }

  const painel = montarPainelDeVendas({
    negocios: leitura.linhas,
    janela,
    moedaDaOrganizacao: org.currency?.trim() || MOEDA_PADRAO,
    filtro: {
      pipeline_id: parsed.data.pipeline_id ?? null,
      tag: parsed.data.tag ? normalizarTagDoRelatorio(parsed.data.tag) : null,
    },
  });

  return ok({ janela, ...painel, truncado: leitura.truncado }, { requestId });
}
