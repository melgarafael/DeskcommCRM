/**
 * GET /api/v1/contacts/cnpj-lookup?cnpj= — dados da empresa (BrasilAPI).
 *
 * Uso na tela de cadastro: digitou o CNPJ, clicou buscar, o formulário
 * completa sozinho. `agent+` (é apoio à criação, que é agent+).
 * Resposta: contato pré-preenchido + `ja_cadastrado` quando o CNPJ já existe
 * na org (aí a tela oferece abrir a ficha em vez de duplicar).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { buscarCnpj, isValidCnpj, mapearParaContato, normalizarCnpj } from "@/lib/brasil/cnpj";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const cru = req.nextUrl.searchParams.get("cnpj")?.trim() ?? "";
  const digitos = normalizarCnpj(cru);
  if (!digitos || !isValidCnpj(digitos)) {
    return fail("validation_failed", "CNPJ inválido.", 422, { requestId });
  }

  const supabase = await createClient();
  const { data: existente } = await supabase
    .from("contacts")
    .select("id, display_name, name")
    .eq("organization_id", authz.org.orgId)
    .eq("cnpj", digitos)
    .maybeSingle();
  if (existente) {
    return ok(
      {
        ja_cadastrado: true,
        contact_id: (existente as unknown as { id: string }).id,
        nome:
          (existente as unknown as { display_name: string | null; name: string | null }).display_name ??
          (existente as unknown as { name: string | null }).name,
      },
      { requestId },
    );
  }

  const resultado = await buscarCnpj(digitos);
  if (!resultado.ok) {
    const mensagens = {
      cnpj_invalido: "CNPJ inválido.",
      nao_encontrado: "CNPJ não encontrado na Receita.",
      servico_indisponivel: "Receita indisponível agora — preencha à mão e tente depois.",
    } as const;
    return fail("validation_failed", mensagens[resultado.erro], 422, { requestId });
  }

  return ok({ ja_cadastrado: false, ...mapearParaContato(resultado.empresa) }, { requestId });
}
