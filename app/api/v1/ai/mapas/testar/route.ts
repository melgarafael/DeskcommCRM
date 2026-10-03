import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * "Testar" a chave de Mapas: geocodifica um ponto público fixo (`PONTO_DE_TESTE`) e
 * diz o que o Google respondeu. Com `api_key` no corpo, testa ESSA chave antes de
 * gravar; sem ela, testa a gravada.
 *
 * Existe porque os dois erros mais comuns de quem cria a chave — a Geocoding API
 * não habilitada no projeto, e a restrição de IP que não inclui o servidor —
 * só aparecem numa chamada de verdade (medido em 28/09/2026: "This API is not
 * activated on your API project"). Sem este botão, a chave errada ficaria
 * gravada e o pino seguiria sem endereço, sem ninguém saber por quê.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { chaveDeMapasSchema, lerChaveDeMapas, testarChaveDeMapas } from "@/lib/mapas/credencial";
import { PONTO_DE_TESTE, textoDoEnderecoAproximado } from "@/lib/mapas/geocodificacao";
import { createAdminClient } from "@/lib/supabase/admin";

const postSchema = z.object({ api_key: chaveDeMapasSchema.optional() }).strict();

export async function POST(req: NextRequest): Promise<Response> {
  // Não grava nada, mas gasta a cota da chave da organização: suporte temporário
  // não dispara chamada paga em nome dela.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_maps" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let bruto: unknown = {};
  try {
    const texto = await req.text();
    if (texto.trim()) bruto = JSON.parse(texto);
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = postSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Essa não parece uma chave do Google: confira se copiou a chave inteira."), 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const chave = parsed.data.api_key ?? (await lerChaveDeMapas(admin, authz.org.orgId));
  if (!chave) {
    return fail("validation_failed", t("Cole uma chave para testar, ou grave uma antes."), 422, { requestId });
  }

  const r = await testarChaveDeMapas(admin, authz.org.orgId, chave, PONTO_DE_TESTE);
  if (r.ok) {
    return ok({ ok: true, endereco: textoDoEnderecoAproximado(r.endereco) }, { requestId });
  }
  return ok({ ok: false, motivo: r.motivo, detalhe: r.detalhe ?? null }, { requestId });
}
