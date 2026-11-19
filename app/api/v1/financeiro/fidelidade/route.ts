/**
 * A FIDELIDADE — saldo e extrato de um cliente.
 *
 * `loyalty_ledger` existia desde a 0240 e não tinha superfície: o ponto só nascia
 * dentro de `fn_finalizar_comanda`, ninguém conseguia consultar o saldo, e
 * resgatar era impossível. Um programa de fidelidade que não se consulta não é
 * um programa de fidelidade.
 *
 * ⚠️ O SALDO VEM DA FUNÇÃO, e nunca de um `reduce` sobre o extrato. O extrato é
 * paginado (o PostgREST corta em 1000 linhas sem avisar), e somar o que ele
 * devolve daria um saldo menor para justamente o cliente mais antigo — o que
 * mais tem direito a prêmio.
 *
 * ⚠️ NÃO EXISTE "EDITAR MOVIMENTO". Ledger é append-only por desenho: corrigir
 * um lançamento errado é lançar o contrário, com motivo. É o mesmo princípio do
 * estorno, e o que faz o saldo de hoje ser explicável pela lista inteira.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const LIMITE_DO_EXTRATO = 100;

const movimentoSchema = z.object({
  contact_id: z.string().uuid(),
  /**
   * Assinado: ganhar é positivo, resgatar é negativo. Zero é recusado porque um
   * movimento que não move nada só polui o extrato que explica o saldo.
   *
   * Não há guarda contra saldo negativo, e isso é decisão: um resgate maior que
   * o saldo é erro de operação que a pessoa no balcão precisa ver como número
   * negativo para corrigir, não uma recusa que a deixa sem entender o estoque
   * de pontos daquele cliente.
   */
  points: z.number().int().min(-100_000).max(100_000).refine((v) => v !== 0, {
    message: "O movimento precisa somar ou subtrair algum ponto.",
  }),
  reason: z.string().min(3).max(200),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // #1907 — `loyalty_ledger` é tabela do módulo `financeiro`: sem ele instalado a
  // rota não existe (404), mesmo molde das rotas de comandas.
  if (!(await moduloLigado(createAdminClient(), "financeiro"))) {
    return fail("not_found", "Not found", 404, { requestId });
  }
  // Leitura do saldo e do extrato: sessão OU token `mcp:read`.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "financeiro",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "financeiro_fidelidade_saldo", requestId);
  if (teto) return teto;

  const contactId = new URL(req.url).searchParams.get("contact_id");
  if (!contactId) {
    return fail("validation_failed", "Informe o contato.", 422, { requestId });
  }

  const supabase = authz.supabase;

  const { data: saldo, error: erroSaldo } = await supabase.rpc("fn_saldo_de_fidelidade", {
    p_org: authz.organizationId,
    p_contact: contactId,
  });
  if (erroSaldo) return fail("internal_error", erroSaldo.message, 500, { requestId });

  const { data: extrato, error } = await supabase
    .from("loyalty_ledger")
    .select("id, points, reason, sale_id, created_at")
    // #4845 — O EXTRATO É DA MESMA EMPRESA DO SALDO. O saldo vem de
    // `fn_saldo_de_fidelidade`, que recebe `p_org`; o extrato filtrava só por
    // `contact_id` e a RLS de `loyalty_ledger` libera todas as empresas de que a
    // pessoa é membro. Resultado: dois números na mesma resposta falando de
    // empresas diferentes — o saldo da A ao lado do extrato da B. Com este
    // filtro, os dois usam a mesma chave, e o extrato explica o saldo.
    .eq("contact_id", contactId)
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: false })
    .limit(LIMITE_DO_EXTRATO);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ contact_id: contactId, saldo: saldo ?? 0, extrato: extrato ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // #1907 — `loyalty_ledger` é tabela do módulo `financeiro`: sem ele instalado a
  // rota não existe (404), mesmo molde das rotas de comandas.
  if (!(await moduloLigado(createAdminClient(), "financeiro"))) {
    return fail("not_found", "Not found", 404, { requestId });
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = movimentoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const org = authz.org.orgId;

  // #4845 — o contato tem de ser DESTA empresa. A FK só exige que o contato
  // exista; para quem é membro de duas empresas, um `contact_id` da outra passava
  // e o ponto entrava no extrato da empresa ativa descrevendo um cliente que ela
  // não atende — o mesmo desencontro que o GET acima passa a impedir.
  const { data: contato } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", lido.data.contact_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (!contato) {
    // Mesma mensagem do 23503 abaixo: a recusa diz "contato inválido" sem
    // distinguir "não existe" de "é de outra empresa" — não revela existência.
    return fail("validation_failed", "Contato inválido.", 422, { requestId });
  }

  const { data, error } = await supabase
    .from("loyalty_ledger")
    .insert({
      organization_id: org,
      contact_id: lido.data.contact_id,
      points: lido.data.points,
      reason: lido.data.reason,
      created_by_user_id: authz.user.id,
    })
    .select("id, points, reason, created_at")
    .single();

  if (error) {
    if (error.code === "23503") {
      return fail("validation_failed", "Contato inválido.", 422, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  // ⚠️ O MOTIVO NÃO ENTRA NO AUDIT, e aqui a linha é ainda mais direta que no
  // estorno: `resourceId` é o PRÓPRIO contato, então a frase ficaria gravada ao
  // lado do id de quem ela descreve. `lib/audit` grava `metadata` cru em
  // `api_audit_log` — retenção longa e fora do alcance da cascata de
  // anonimização, que não tem GRANT de UPDATE/DELETE nessa tabela nem com a
  // service key. O ledger é a fonte do motivo (`loyalty_ledger.reason`), e lá a
  // LGPD chega; o audit guarda só quantos pontos e que houve justificativa.
  await audit({
    action: lido.data.points > 0 ? "fidelidade.ponto_dado" : "fidelidade.ponto_resgatado",
    resourceType: "contact",
    resourceId: lido.data.contact_id,
    requestId,
    metadata: {
      points: lido.data.points,
      motivo_informado: true,
      motivo_chars: lido.data.reason.length,
    },
  });

  return ok(data, { requestId });
}
