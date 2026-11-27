"use server";

/**
 * Criar e listar ações de conversão direto na conta Google Ads (0436).
 *
 * Criar é uma escrita na conta de anúncios do cliente — mesmo gate da conexão:
 * `admin` da organização, MFA quando houver fator, e auditoria. Listar só lê,
 * mas lê pela credencial da organização, então o gate é o mesmo.
 */
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { VALORES_DE_CATEGORIA } from "@/lib/conversoes/regras-google";
import {
  criarAcaoDeConversao,
  lerConexaoNativaParaDestinoGoogle,
  listarAcoesDeConversao,
  type AcaoDeConversao,
  type FalhaDaApiGoogle,
} from "@/lib/plataformas-de-anuncio/google/api-google-ads";
import { createAdminClient } from "@/lib/supabase/admin";
import { idDaContaGoogle } from "@/lib/plataformas-de-anuncio/google/metadados-da-campanha";

const idOpcional = z
  .union([idDaContaGoogle, z.literal("")])
  .nullish()
  .transform((v) => v || null);
const camposDoDestino = {
  google_customer_id: idOpcional,
  google_login_customer_id: idOpcional,
};
const destinoSchema = z
  .object(camposDoDestino)
  .refine((v) => v.google_customer_id !== null || v.google_login_customer_id === null, {
    message: "A conta gerente só pode acompanhar um destino explícito.",
  });
type DestinoInput = z.input<typeof destinoSchema>;

function destinoDaEntrada(v: z.output<typeof destinoSchema>) {
  return v.google_customer_id
    ? { customerId: v.google_customer_id, loginCustomerId: v.google_login_customer_id }
    : undefined;
}

type ErroDeAcesso =
  "validation_failed" | "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "mfa_required";

export type ResultadoDaAcaoGoogle<T> =
  { ok: true; dados: T } | { ok: false; error: ErroDeAcesso | FalhaDaApiGoogle; detalhe?: string };

async function autorizar(escrita: boolean) {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false as const, error: "unauthenticated" as const };
  if (escrita && supportWriteError(authUser.support))
    return { ok: false as const, error: "forbidden_role" as const };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false as const, error: "forbidden_tenant" as const };
  if (!podeAdministrarEmpresa(authUser, activeOrg))
    return { ok: false as const, error: "forbidden_role" as const };
  if (escrita && (await mfaEmDivida()))
    return { ok: false as const, error: "mfa_required" as const };
  return { ok: true as const, authUser, orgId: activeOrg.orgId };
}

export async function listarAcoesDeConversaoGoogle(
  destino: DestinoInput = {},
): Promise<ResultadoDaAcaoGoogle<AcaoDeConversao[]>> {
  const pedido = destinoSchema.safeParse(destino);
  if (!pedido.success) return { ok: false, error: "validation_failed" };
  const acesso = await autorizar(false);
  if (!acesso.ok) return acesso;
  const conexao = await lerConexaoNativaParaDestinoGoogle(
    createAdminClient(),
    acesso.orgId,
    destinoDaEntrada(pedido.data),
  );
  if (!conexao.ok) return { ok: false, error: conexao.falha, detalhe: conexao.detalhe };
  const acoes = await listarAcoesDeConversao(conexao.dados);
  if (!acoes.ok) return { ok: false, error: acoes.falha, detalhe: acoes.detalhe };
  return { ok: true, dados: acoes.dados };
}

const pedidoSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    categoria: z.enum(VALORES_DE_CATEGORIA),
    incluir_em_conversoes: z.boolean(),
    ...camposDoDestino,
  })
  .refine((v) => v.google_customer_id !== null || v.google_login_customer_id === null);

export async function criarAcaoDeConversaoGoogle(
  input: z.input<typeof pedidoSchema>,
): Promise<ResultadoDaAcaoGoogle<{ id: string; nome: string }>> {
  const pedido = pedidoSchema.safeParse(input);
  if (!pedido.success) return { ok: false, error: "validation_failed" };
  const acesso = await autorizar(true);
  if (!acesso.ok) return acesso;

  const conexao = await lerConexaoNativaParaDestinoGoogle(
    createAdminClient(),
    acesso.orgId,
    destinoDaEntrada(pedido.data),
  );
  if (!conexao.ok) return { ok: false, error: conexao.falha, detalhe: conexao.detalhe };
  const criada = await criarAcaoDeConversao(conexao.dados, {
    nome: pedido.data.nome,
    categoria: pedido.data.categoria,
    incluirEmConversoes: pedido.data.incluir_em_conversoes,
  });
  if (!criada.ok) return { ok: false, error: criada.falha, detalhe: criada.detalhe };

  const hdrs = await headers();
  await audit({
    action: "google_ads_conversion_action.created",
    actorUserId: acesso.authUser.id,
    organizationId: acesso.orgId,
    resourceType: "ad_platform_connections",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: ipDoCliente(hdrs) ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: {
      conversion_action_id: criada.dados.id,
      google_customer_id: conexao.dados.customerId,
      google_login_customer_id: conexao.dados.loginCustomerId,
      categoria: pedido.data.categoria,
      incluir_em_conversoes: pedido.data.incluir_em_conversoes,
    },
  });
  return { ok: true, dados: criada.dados };
}
