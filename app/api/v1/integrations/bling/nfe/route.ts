import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  obterClienteBlingAutenticado,
  obterConfiguracaoBling,
  registrarLogBling,
} from "@/lib/integrations/bling/store";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const emitirNfeSchema = z.object({
  naturezaOperacao: z.string().default("Venda de mercadoria"),
  idPedidoBling: z.number().optional(),
  contato: z.object({
    id: z.number().optional(),
    nome: z.string().min(1),
    numeroDocumento: z.string().optional(), // CPF ou CNPJ
  }),
  itens: z
    .array(
      z.object({
        codigo: z.string().optional(),
        descricao: z.string().min(1),
        quantidade: z.number().min(1),
        valor: z.number().min(0.01),
      }),
    )
    .min(1, "A NF-e exige ao menos um item"),
  transmitirSefaz: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_nfe" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const config = await obterConfiguracaoBling(admin, orgId);
  if (!config || !config.is_enabled || !config.features?.invoice_emission) {
    return fail(
      "validation_failed",
      "A emissão de NF-e no Bling está desativada para esta empresa. Ative-a em Configurações › Bling ERP.",
      400,
      { requestId },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = emitirNfeSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_input", "Dados da nota fiscal inválidos", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { client, error } = await obterClienteBlingAutenticado(admin, orgId);
  if (error || !client) {
    return fail("validation_failed", error || "Cliente Bling indisponível", 400, {
      requestId,
    });
  }

  // 1. Gerar rascunho de NF-e
  const payloadNfe: Record<string, any> = {
    naturezaOperacao: parsed.data.naturezaOperacao,
    contato: parsed.data.contato,
    itens: parsed.data.itens,
  };

  const resNfe = await client.gerarNfe(payloadNfe);

  await registrarLogBling(admin, orgId, {
    operation: "generate_nfe",
    direction: "outbound",
    status: resNfe.ok ? "success" : "failed",
    details: {
      idNotaFiscal: resNfe.idNotaFiscal,
      idPedidoBling: parsed.data.idPedidoBling,
      transmitir: parsed.data.transmitirSefaz,
    },
    error_message: resNfe.ok ? null : (resNfe.error ?? null),
  });

  if (!resNfe.ok || !resNfe.idNotaFiscal) {
    return fail("integration_error", resNfe.error || "Falha ao gerar nota no Bling", 400, {
      requestId,
    });
  }

  // 2. Transmitir para a SEFAZ se solicitado
  let retornoSefaz: any = null;
  if (parsed.data.transmitirSefaz) {
    const resSefaz = await client.transmitirSefaz(resNfe.idNotaFiscal);
    retornoSefaz = resSefaz.data;

    await registrarLogBling(admin, orgId, {
      operation: "transmit_sefaz",
      direction: "outbound",
      status: resSefaz.ok ? "success" : "failed",
      details: { idNotaFiscal: resNfe.idNotaFiscal, retornoSefaz },
      error_message: resSefaz.ok ? null : (resSefaz.error ?? null),
    });
  }

  audit({
    action: "bling.updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "bling_nfe",
    resourceId: String(resNfe.idNotaFiscal),
    requestId,
    metadata: {
      idNotaFiscal: resNfe.idNotaFiscal,
      transmitidoSefaz: parsed.data.transmitirSefaz,
    },
  });

  return ok(
    {
      idNotaFiscal: resNfe.idNotaFiscal,
      transmitidoSefaz: parsed.data.transmitirSefaz,
      dadosSefaz: retornoSefaz,
      mensagem: parsed.data.transmitirSefaz
        ? "Nota Fiscal gerada e enviada para autorização na SEFAZ com sucesso."
        : "Rascunho de Nota Fiscal gerado com sucesso no Bling.",
    },
    { requestId },
  );
}

export async function GET(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bling_nfe" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const chaveAcesso = url.searchParams.get("chaveAcesso");
  if (!chaveAcesso) {
    return fail("invalid_input", "Parâmetro chaveAcesso é obrigatório", 400, { requestId });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const { client, error } = await obterClienteBlingAutenticado(admin, orgId);
  if (error || !client) {
    return fail("validation_failed", error || "Cliente Bling indisponível", 400, {
      requestId,
    });
  }

  const resultado = await client.buscarDanfePdf(chaveAcesso);
  if (!resultado.ok) {
    return fail("integration_error", resultado.error || "Não foi possível obter o DANFE", 400, {
      requestId,
    });
  }

  return ok({ chaveAcesso, danfe: resultado.urlOuPdf }, { requestId });
}
