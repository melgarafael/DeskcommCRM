/**
 * GET  /api/v1/fiscal-entradas — entradas da organização ativa.
 * POST /api/v1/fiscal-entradas — sincroniza com a SEFAZ (distribuição DF-e).
 *
 * A sincronização é UMA rodada curta (o sidecar faz até 3 consultas): o
 * cursor (ultNSU) mora em `fiscal_entrada_cursor` e cada clique continua
 * de onde parou — nunca do zero, para a SEFAZ não bloquear o CNPJ (656).
 * Resumo vira linha `nova`; XML completo só chega depois de manifestar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { buscarNaSefaz, type ContextoEntrada, type DocumentoSefaz } from "@/lib/fiscal/entrada";
import { carregarContextoSped } from "@/lib/fiscal/sped-payload";
import { resolverProvedor } from "@/lib/fiscal/provedor";
import {
  COLUNAS_DA_ENTRADA,
  STATUS_DA_ENTRADA,
} from "@/lib/schemas/fiscal-entrada";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "fiscal-entradas" });
  if (!authz.ok) return authz.response;

  const status = req.nextUrl.searchParams.get("status")?.trim() ?? "";
  const supabase = await createClient();
  let q = supabase
    .from("fiscal_entradas")
    .select(COLUNAS_DA_ENTRADA)
    .eq("organization_id", authz.org.orgId);

  if (status !== "" && (STATUS_DA_ENTRADA as readonly string[]).includes(status)) {
    q = q.eq("status", status);
  }

  const { data, error } = await q.order("dh_emi", { ascending: false, nullsFirst: false }).limit(200);
  if (error) return fail("internal_error", "Erro ao listar as entradas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

function soDigitos(v: string | null): string {
  return (v ?? "").replace(/\D/g, "");
}

export async function POST(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "fiscal-entradas" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();

  const { data: cfgRaw } = await supabase
    .from("fiscal_settings")
    .select("provedor")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const cfg = cfgRaw as unknown as { provedor?: string | null } | null;
  if (resolverProvedor({ provedor: cfg?.provedor ?? null }) !== "spednfe") {
    return fail(
      "validation_failed",
      "Sem emissor fiscal com certificado (Notas → Configuração fiscal, provedor sped-nfe). Sem ele, não há como falar com a SEFAZ.",
      422,
      { requestId },
    );
  }

  const ctx = await carregarContextoSped(authz.org.orgId);
  const cnpj = soDigitos(ctx?.emitente.emitente_documento ?? null);
  if (!ctx || cnpj === "" || !ctx.emitente.uf || !ctx.emitente.certificado_path || !ctx.senhaCertificado) {
    return fail(
      "validation_failed",
      "Faltam CNPJ, UF, certificado (.pfx) ou senha na configuração fiscal.",
      422,
      { requestId },
    );
  }
  const entrada: ContextoEntrada = {
    ambiente: ctx.emitente.ambiente,
    cnpj,
    razao: ctx.emitente.emitente_documento ?? cnpj,
    ie: ctx.emitente.ie ?? "",
    uf: ctx.emitente.uf,
    certificadoPath: ctx.emitente.certificado_path,
    senhaCertificado: ctx.senhaCertificado,
  };

  const { data: cursor } = await supabase
    .from("fiscal_entrada_cursor")
    .select("ult_nsu")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const de = (cursor as unknown as { ult_nsu?: number | string } | null)?.ult_nsu ?? 0;

  const resultado = await buscarNaSefaz(entrada, Number(de));
  if (!resultado.ok) {
    return fail("upstream_unavailable", resultado.erro ?? "SEFAZ inalcançável.", 502, { requestId });
  }

  let novas = 0;
  let atualizadas = 0;
  const candidatas = resultado.documentos.filter(
    (d) => (d.tipo === "resumo" || d.tipo === "completa") && /^\d{44}$/.test(d.chave),
  );
  if (candidatas.length > 0) {
    const chaves = candidatas.map((d) => d.chave);
    const { data: existentes } = await supabase
      .from("fiscal_entradas")
      .select("chave, xml")
      .eq("organization_id", authz.org.orgId)
      .in("chave", chaves);
    const mapa = new Map(
      ((existentes ?? []) as unknown as { chave: string; xml: string | null }[]).map((e) => [e.chave, e]),
    );
    for (const d of candidatas) {
      const atual = mapa.get(d.chave);
      if (!atual) {
        const { error } = await supabase.from("fiscal_entradas").insert(linhaDe(d, authz.org.orgId, authz.user.id));
        if (!error) novas++;
      } else if (!atual.xml && d.tipo === "completa" && d.xml) {
        // O resumo virou XML completo (manifestou entre uma sincronização e
        // outra): promove a linha, sem duplicar.
        const { error } = await supabase
          .from("fiscal_entradas")
          .update({
            xml: d.xml,
            itens_json: d.itens,
            cobranca_json: d.cobranca,
            numero: d.numero,
            serie: d.serie,
            dh_emi: d.dh_emi,
            valor_total_cents: d.valor_cents,
            status: "manifestada",
          })
          .eq("organization_id", authz.org.orgId)
          .eq("chave", d.chave);
        if (!error) atualizadas++;
      }
    }
  }

  await supabase.from("fiscal_entrada_cursor").upsert(
    { organization_id: authz.org.orgId, ult_nsu: resultado.ultNSU, atualizado_em: new Date().toISOString() },
    { onConflict: "organization_id" },
  );

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal_entrada.sincronizada",
    resourceType: "fiscal_entradas",
    resourceId: authz.org.orgId,
    requestId,
  });

  return ok(
    {
      novas,
      atualizadas,
      ultNSU: resultado.ultNSU,
      maxNSU: resultado.maxNSU,
      aviso: resultado.aviso,
      cstat: resultado.cstat,
    },
    { requestId },
  );
}

function linhaDe(d: DocumentoSefaz, organizationId: string, userId: string): Record<string, unknown> {
  return {
    organization_id: organizationId,
    chave: d.chave,
    nsu: Number(d.nsu) || 0,
    emitente_cnpj: d.emitente_cnpj,
    emitente_nome: d.emitente_nome || "Emitente desconhecido",
    emitente_ie: d.emitente_ie || null,
    numero: d.numero,
    serie: d.serie,
    dh_emi: d.dh_emi,
    valor_total_cents: d.valor_cents,
    xml: d.xml,
    itens_json: d.itens,
    cobranca_json: d.cobranca,
    status: d.tipo === "completa" ? "manifestada" : "nova",
    created_by: userId,
  };
}
