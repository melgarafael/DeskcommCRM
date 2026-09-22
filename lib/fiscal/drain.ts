import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { destinoAposFalha, eRetentavel } from "./fila";import { FALTA_EMISSOR, provedorStub, resolverProvedor, type ResultadoDeEmissao } from "./provedor";
import { emitirViaSpedNfe } from "./provedor-spednfe";
import { carregarContextoSped } from "./sped-payload";

/**
 * O DRENO FISCAL — processa UM job de emissão até um estado terminal ou o
 * próximo backoff. Chamado pela rota cron (molde do motor de prospecção).
 *
 * Claim condicional (só `pendente` vira `processando`): dois ticks
 * concorrentes não emitem duas vezes — o perdedor encontra o job já
 * processando e devolve sem tocar na nota. Junto com "1 nota viva por
 * pedido", duplo clique e retry cego não duplicam NF.
 */

export interface JobFiscal {
  id: string;
  organization_id: string;
  invoice_id: string;
  tentativas: number;
  max_tentativas: number;
}

export type ResultadoJob =
  | { saidas: "concluido"; destino: string }
  | { saidas: "reagendado"; destino: string }
  | { saidas: "ignorado"; motivo: string };

async function evento(
  admin: SupabaseClient,
  orgId: string,
  invoiceId: string,
  tipo: string,
  extra: { status?: string | null; protocolo?: string | null; mensagem?: string | null; xml?: string | null },
): Promise<void> {
  await admin.from("fiscal_events").insert({
    organization_id: orgId,
    invoice_id: invoiceId,
    tipo,
    status: extra.status ?? null,
    protocolo: extra.protocolo ?? null,
    mensagem: extra.mensagem?.slice(0, 2000) ?? null,
    xml: extra.xml ?? null,
  });
}

export async function processarJob(admin: SupabaseClient, job: JobFiscal): Promise<ResultadoJob> {
  // Claim: só quem tira de `pendente` trabalha.
  const { data: claimed } = await admin
    .from("fiscal_jobs")
    .update({ status: "processando", updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "pendente")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) {
    return { saidas: "ignorado", motivo: "job já reclamado" };
  }

  const { data: notaDb } = await admin
    .from("invoices")
    .select("id, organization_id, order_id, serie, status, provedor, numero")
    .eq("id", job.invoice_id)
    .maybeSingle();
  const nota = notaDb as unknown as {
    id: string;
    organization_id: string;
    order_id: string;
    serie: string;
    status: string;
    provedor: string;
  } | null;
  // Nota saiu de em_emissao no meio do caminho (cancelada pelo usuário):
  // encerra o job sem tocar em nada — história fiscal não se reescreve.
  if (!nota || nota.status !== "em_emissao") {
    await admin.from("fiscal_jobs").update({ status: "concluido", updated_at: new Date().toISOString() }).eq("id", job.id);
    return { saidas: "ignorado", motivo: "nota fora de emissão" };
  }

  const { data: config } = await admin
    .from("fiscal_settings")
    .select("serie, natureza_operacao, cfop_padrao, emitente_documento, provedor")
    .eq("organization_id", nota.organization_id)
    .maybeSingle();
  const cfg = config as unknown as { serie: string; provedor: string } | null;
  const escolha = cfg ? resolverProvedor(cfg) : "stub";

  const { data: pedido } = await admin
    .from("commercial_orders")
    .select("id, numero, cliente_nome, cliente_documento, total_cents, frete_cents")
    .eq("id", nota.order_id)
    .maybeSingle();
  const ped = pedido as unknown as {
    id: string;
    numero: number;
    cliente_nome: string;
    cliente_documento: string | null;
    total_cents: number;
    frete_cents: number;
  } | null;
  if (!ped) {
    await finalizar(admin, job, nota, "erro", "Pedido da nota sumiu.", null);
    return { saidas: "concluido", destino: "erro" };
  }

  let resultado: ResultadoDeEmissao;
  if (escolha === "spednfe") {
    await evento(admin, nota.organization_id, nota.id, "enviada", { status: "em_emissao" });
    const ctx = await carregarContextoSped(nota.organization_id);
    if (!ctx) {
      await finalizar(admin, job, nota, "erro", "Configuração fiscal sumiu no meio da emissão.", null);
      return { saidas: "concluido", destino: "erro" };
    }
    const { data: itensDb } = await admin
      .from("commercial_order_items")
      .select("produto_codigo, produto_nome, quantidade, preco_unit_cents, desconto_pct, product_id")
      .eq("order_id", ped.id)
      .eq("organization_id", nota.organization_id)
      .order("posicao");
    const idsProd = ((itensDb ?? []) as unknown as { product_id: string | null }[])
      .map((i) => i.product_id)
      .filter(Boolean) as string[];
    const fiscais: Record<string, { ncm: string | null; cfop: string | null; unidade: string | null }> = {};
    if (idsProd.length > 0) {
      const { data: prods } = await admin
        .from("catalog_products")
        .select("id, ncm, cfop, unidade")
        .eq("organization_id", nota.organization_id)
        .in("id", idsProd);
      for (const p of ((prods ?? []) as unknown as { id: string; ncm: string | null; cfop: string | null; unidade: string | null }[])) {
        fiscais[p.id] = p;
      }
    }
    const em = ctx.emitente as unknown as Record<string, string | null>;
    resultado = await emitirViaSpedNfe({
      emitente: {
        serie: cfg?.serie ?? nota.serie,
        natureza_operacao: (em.natureza_operacao as string) ?? "",
        cfop_padrao: (em.cfop_padrao as string) ?? "",
        emitente_documento: em.emitente_documento ?? null,
        ie: em.ie ?? null,
        crt: (em.crt as string) ?? "1",
        logradouro: em.logradouro ?? null,
        numero_end: em.numero_end ?? null,
        bairro: em.bairro ?? null,
        municipio: em.municipio ?? null,
        codigo_municipio: em.codigo_municipio ?? null,
        uf: em.uf ?? null,
        cep: em.cep ?? null,
        ambiente: (em.ambiente as string) ?? "homologacao",
        certificado_path: em.certificado_path ?? null,
      },
      senhaCertificado: ctx.senhaCertificado ?? "",
      pedido: { numero: ped.numero, nome: ped.cliente_nome, documento: ped.cliente_documento, frete_cents: ped.frete_cents },
      itens: ((itensDb ?? []) as unknown as {
        produto_codigo: string;
        produto_nome: string;
        quantidade: number;
        preco_unit_cents: number;
        desconto_pct: number;
        product_id: string | null;
      }[]).map((i) => ({
        codigo: i.produto_codigo,
        descricao: i.produto_nome,
        ncm: i.product_id ? (fiscais[i.product_id]?.ncm ?? null) : null,
        cfop: i.product_id ? (fiscais[i.product_id]?.cfop ?? null) : null,
        unidade: i.product_id ? (fiscais[i.product_id]?.unidade ?? null) : null,
        quantidade: i.quantidade,
        preco_cents: i.preco_unit_cents,
        desconto_pct: Number(i.desconto_pct),
      })),
    });
  } else {
    resultado = await provedorStub.emitir({
      order_id: ped.id,
      numero: ped.numero,
      cliente_nome: ped.cliente_nome,
      cliente_documento: ped.cliente_documento,
      total_cents: ped.total_cents,
    });
    // Stub é homologação declarada: volta para pendente com o motivo, em vez
    // de fingir processamento — o drain não anda stub adiante sozinho.
    await admin
      .from("invoices")
      .update({ status: "pendente", erro: FALTA_EMISSOR, updated_at: new Date().toISOString() })
      .eq("id", nota.id);
    await evento(admin, nota.organization_id, nota.id, "erro", { status: "pendente", mensagem: FALTA_EMISSOR });
    await admin.from("fiscal_jobs").update({ status: "concluido", updated_at: new Date().toISOString() }).eq("id", job.id);
    return { saidas: "concluido", destino: "pendente" };
  }

  if (resultado.status === "autorizada") {
    await finalizar(admin, job, nota, "autorizada", resultado.sefaz_xmotivo ?? null, resultado);
    return { saidas: "concluido", destino: "autorizada" };
  }

  // Erro ou denegada: denegada é terminal fiscal; erro decide retry/dead.
  if (resultado.status === "denegada") {
    await finalizar(admin, job, nota, "denegada", resultado.erro ?? resultado.sefaz_xmotivo ?? "Denegada.", resultado);
    return { saidas: "concluido", destino: "denegada" };
  }
  const msg = resultado.erro ?? "Erro sem motivo.";
  const tentativa = job.tentativas + 1;
  if (!eRetentavel(msg)) {
    await finalizar(admin, job, nota, "erro", msg, resultado);
    return { saidas: "concluido", destino: "erro" };
  }
  const { status, esperaMin } = destinoAposFalha(tentativa);
  if (status === "erro") {
    await finalizar(admin, job, nota, "erro", `${msg} (após ${tentativa} tentativas)`, resultado);
    return { saidas: "concluido", destino: "erro" };
  }
  const proxima = new Date(Date.now() + esperaMin * 60000).toISOString();
  await admin
    .from("invoices")
    .update({ erro: msg, updated_at: new Date().toISOString() })
    .eq("id", nota.id);
  await evento(admin, nota.organization_id, nota.id, "retry", { status: "em_emissao", mensagem: `Tentativa ${tentativa}: ${msg}` });
  await admin
    .from("fiscal_jobs")
    .update({ status: "pendente", tentativas: tentativa, proxima_tentativa: proxima, ultimo_erro: msg.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", job.id);
  return { saidas: "reagendado", destino: "em_emissao" };
}

async function finalizar(
  admin: SupabaseClient,
  job: JobFiscal,
  nota: { id: string; organization_id: string },
  status: "autorizada" | "denegada" | "erro" | "cancelada",
  mensagem: string | null,
  resultado: ResultadoDeEmissao | null,
): Promise<void> {
  await admin
    .from("invoices")
    .update({
      status,
      ...(resultado?.numero != null ? { numero: resultado.numero } : {}),
      ...(resultado?.chave_acesso != null ? { chave_acesso: resultado.chave_acesso } : {}),
      ...(resultado?.xml != null ? { xml: resultado.xml } : {}),
      ...(resultado?.protocolo != null ? { protocolo: resultado.protocolo } : {}),
      ...(resultado?.sefaz_cstat != null ? { sefaz_cstat: resultado.sefaz_cstat } : {}),
      ...(resultado?.sefaz_xmotivo != null ? { sefaz_xmotivo: resultado.sefaz_xmotivo } : {}),
      erro: status === "autorizada" ? null : mensagem,
      updated_at: new Date().toISOString(),
    })
    .eq("id", nota.id);
  await evento(admin, nota.organization_id, nota.id, status === "denegada" ? "rejeitada" : status === "autorizada" ? "autorizada" : "erro", {
    status,
    protocolo: resultado?.protocolo ?? null,
    mensagem,
    xml: resultado?.xml ?? null,
  });
  await admin
    .from("fiscal_jobs")
    .update({
      status: "concluido",
      tentativas: job.tentativas + 1,
      ultimo_erro: mensagem?.slice(0, 500) ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
  if (status === "autorizada") {
    await audit({
      organizationId: nota.organization_id,
      action: "invoice.emitted",
      resourceType: "invoices",
      resourceId: nota.id,
    });
  }
}
