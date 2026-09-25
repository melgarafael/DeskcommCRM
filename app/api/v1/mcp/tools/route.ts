/**
 * GET /api/v1/mcp/tools
 *
 * Catalogo de tools MCP serializado para a UI consumir (Spec 11 + EPIC-13
 * S-13.03 AC). Usa cookie session (Spec 01 auth dual). Resposta:
 *   { data: { tools: [{ id, description, input_schema, category, requires_role,
 *                       rotulo, explicacao, o_que_toca, risco, pacotes }] } }
 *
 * `input_schema` e o JSON Schema gerado a partir do Zod raw shape.
 *
 * DUAS AUDIENCIAS NA MESMA RESPOSTA: `description` e `input_schema` sao do
 * MODELO; `rotulo`/`explicacao`/`o_que_toca`/`risco`/`pacotes` sao do HUMANO
 * que configura o agente. A juncao das duas metades (e a recusa em servir uma
 * capacidade sem a metade do humano) vive em `catalogo-servido.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG, deModuloDesligado } from "@/lib/mcp/tools/catalog";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { juntarCatalogoComHandlers } from "@/lib/mcp/tools/catalogo-servido";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });

  let servidas;
  try {
    servidas = juntarCatalogoComHandlers(allTools, TOOL_CATALOG);
  } catch (err) {
    // Erro de programação, não estado do usuário: servir a capacidade sem
    // rótulo empurraria o defeito para a tela do dono da clínica.
    return fail(
      "internal_error",
      err instanceof Error ? err.message : "Catálogo de capacidades inconsistente.",
      500,
      { requestId },
    );
  }

  // Módulo opcional desligado na instalação: a capacidade não existe aqui, e a
  // tela não a oferece para marcar (doc 37).
  const ligados = await modulosLigados(createAdminClient());
  const schemaPorNome = new Map(allTools.map((t) => [t.name, t.inputSchema]));
  const tools = servidas.filter((c) => !deModuloDesligado(c.id, ligados)).map((capacidade) => ({
    ...capacidade,
    input_schema: z.toJSONSchema(z.object(schemaPorNome.get(capacidade.id) ?? {}), {
      target: "openapi-3.0",
    }),
  }));

  return ok({ tools }, { requestId });
}
