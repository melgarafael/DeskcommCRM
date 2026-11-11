/**
 * O relatório do faturamento.
 *
 * ⚠️ A ROTA NÃO SOMA NADA. Quem agrega é `fn_relatorio_financeiro`, no banco, e a
 * razão está escrita no cabeçalho da migration 0244: o PostgREST corta em 1000
 * linhas sem avisar, e somar aqui devolveria um número menor que o verdadeiro,
 * com cara de certo. Nesta mesma base a primeira medição do saldo deu
 * R$ 141.436,00 em vez de R$ 641.103,60.
 *
 * Se um dia alguém quiser "só mais um total", ele entra na função — não num
 * `reduce` deste arquivo.
 *
 * Sessão OU token `dsk_…` (`mcp:read`, viewer+; Spec 33, R3): a organização vem
 * da sessão ou da linha do token.
 *
 * A função é INVOKER, então a RLS continua decidindo o que cada pessoa vê; esta
 * rota resolve a organização do lado confiável (a sessão) e nunca do corpo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

/** Quantos dias um período pode cobrir. */
const JANELA_MAXIMA_DIAS = 400;

const periodoSchema = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inicial inválida."),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data final inválida."),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "reports",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  // Está em PUBLIC_PATHS: o teto do token é a única contagem das chamadas dele.
  const teto = await tetoDeEscritaDoToken(authz, "reports", requestId);
  if (teto) return teto;

  const url = new URL(req.url);
  const hoje = new Date().toISOString().slice(0, 10);
  const primeiroDoMes = `${hoje.slice(0, 7)}-01`;

  const lido = periodoSchema.safeParse({
    de: url.searchParams.get("de") ?? primeiroDoMes,
    ate: url.searchParams.get("ate") ?? hoje,
  });
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "período inválido", 422, {
      requestId,
    });
  }
  if (lido.data.de > lido.data.ate) {
    // Invertido devolveria zero em tudo, e zero lê como "não faturamos nada" —
    // a resposta errada mais convincente que este relatório pode dar.
    return fail("validation_failed", "A data inicial é depois da final.", 422, { requestId });
  }

  const dias =
    (Date.parse(lido.data.ate) - Date.parse(lido.data.de)) / 86_400_000;
  if (dias > JANELA_MAXIMA_DIAS) {
    return fail("validation_failed", "O período não pode passar de 400 dias.", 422, { requestId });
  }

  const supabase = authz.supabase;
  const { data, error } = await supabase.rpc("fn_relatorio_financeiro", {
    p_org: authz.organizationId,
    p_de: lido.data.de,
    p_ate: lido.data.ate,
  });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data, { requestId });
}
