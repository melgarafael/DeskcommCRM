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
import {
  montarPainelDeVendas,
  type NegocioDaVenda,
  type NegocioDoPainel,
  type VendaRegistradaDoPainel,
} from "@/lib/relatorios/painel-de-vendas";
import { lerPaginado } from "@/lib/supabase/pagina";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
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

  // ─── 1. Negócios ganhos e perdidos fechados na janela ─────────────────────
  const leitura = await lerPaginado<NegocioDoPainel>(async (inicio, fim, contar) => {
    const { data, error, count } = await supabase
      .from("crm_leads")
      .select(
        "id, status, closed_at, value_cents, currency, pipeline_id, tags, contact_id, title, owner_user_id",
        contar ? { count: "exact" } : undefined,
      )
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

  // ─── 2. Vendas registradas com DATA dentro do período ────────────────────
  const registradas = await lerPaginado<VendaRegistradaDoPainel>(async (inicio, fim, contar) => {
    const { data, error, count } = await supabase
      .from("vendas_registradas")
      .select("id, lead_id, contact_id, valor_cents, currency, data, tags, created_by", contar ? { count: "exact" } : undefined)
      .eq("organization_id", org.orgId)
      .gte("data", de)
      .lte("data", ate)
      .order("data", { ascending: false })
      .order("id", { ascending: true })
      .range(inicio, fim);
    return { data: (data ?? []) as VendaRegistradaDoPainel[], error, count: count ?? null };
  });
  if (registradas.erro) return fail("internal_error", registradas.erro, 500, { requestId });

  // ─── 3. O negócio de cada venda registrada (funil, tags, título) ─────────
  const negociosDasVendas = new Map<string, NegocioDaVenda>();
  const idsDosNegocios = [...new Set(registradas.linhas.map((v) => v.lead_id).filter((id): id is string => !!id))];
  for (let i = 0; i < idsDosNegocios.length; i += LOTE) {
    const { data, error } = await supabase
      .from("crm_leads")
      .select("id, pipeline_id, tags, title, contact_id")
      .eq("organization_id", org.orgId)
      .in("id", idsDosNegocios.slice(i, i + LOTE));
    if (error) return fail("internal_error", error.message, 500, { requestId });
    for (const n of (data ?? []) as Array<NegocioDaVenda & { id: string }>) negociosDasVendas.set(n.id, n);
  }

  // ─── 4. Quais negócios GANHOS da janela têm venda registrada (qualquer data) ─
  const comVendaRegistrada = new Set<string>();
  const idsGanhos = leitura.linhas.filter((n) => n.status === "won" && n.id).map((n) => n.id as string);
  for (let i = 0; i < idsGanhos.length; i += LOTE) {
    const { data, error } = await supabase
      .from("vendas_registradas")
      .select("lead_id")
      .eq("organization_id", org.orgId)
      .in("lead_id", idsGanhos.slice(i, i + LOTE));
    if (error) return fail("internal_error", error.message, 500, { requestId });
    for (const linha of (data ?? []) as Array<{ lead_id: string | null }>) {
      if (linha.lead_id) comVendaRegistrada.add(linha.lead_id);
    }
  }

  const painel = montarPainelDeVendas({
    negocios: leitura.linhas,
    janela,
    moedaDaOrganizacao: org.currency?.trim() || MOEDA_PADRAO,
    filtro: {
      pipeline_id: parsed.data.pipeline_id ?? null,
      tag: parsed.data.tag ? normalizarTagDoRelatorio(parsed.data.tag) : null,
    },
    vendasRegistradas: registradas.linhas,
    negociosDasVendas,
    negociosComVendaRegistrada: comVendaRegistrada,
  });

  // ─── 5. Os nomes que a tela escreve: clientes e funis ───────────────────
  const idsDeContato = [
    ...new Set([
      ...painel.lista.map((v) => v.contact_id),
      ...painel.rankings.clientes.map((c) => c.chave),
    ].filter((id): id is string => !!id)),
  ];
  const contatos: Record<string, { display_name: string | null; name: string | null; phone_number: string | null }> = {};
  for (let i = 0; i < idsDeContato.length; i += LOTE) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, display_name, name, phone_number")
      .eq("organization_id", org.orgId)
      .in("id", idsDeContato.slice(i, i + LOTE));
    if (error) return fail("internal_error", error.message, 500, { requestId });
    for (const c of (data ?? []) as Array<{ id: string; display_name: string | null; name: string | null; phone_number: string | null }>) {
      contatos[c.id] = { display_name: c.display_name, name: c.name, phone_number: c.phone_number };
    }
  }
  const idsDeFunil = [
    ...new Set([
      ...painel.opcoes.pipeline_ids,
      ...painel.lista.map((v) => v.pipeline_id),
      ...painel.rankings.funis.map((f) => f.chave),
    ].filter((id): id is string => !!id)),
  ];
  const nomesDosFunis: Record<string, string | null> = {};
  if (idsDeFunil.length > 0) {
    const { data, error } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", org.orgId)
      .in("id", idsDeFunil);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    for (const f of (data ?? []) as Array<{ id: string; name: string | null }>) nomesDosFunis[f.id] = f.name?.trim() || null;
  }

  // ─── 6. O nome de quem vendeu (só membros da empresa; só o nome) ─────────
  const nomesDosVendedores = await nomesDosAtendentes(
    org.orgId,
    painel.lista.map((v) => v.vendedor_user_id),
  );
  const vendedores: Record<string, string | null> = Object.fromEntries(nomesDosVendedores);

  return ok(
    {
      janela,
      ...painel,
      contatos,
      nomes_dos_funis: nomesDosFunis,
      vendedores,
      truncado: leitura.truncado || registradas.truncado,
    },
    { requestId },
  );
}

/** Quantos ids entram em cada `.in(...)`: a URL do PostgREST não cresce sem teto. */
const LOTE = 200;
