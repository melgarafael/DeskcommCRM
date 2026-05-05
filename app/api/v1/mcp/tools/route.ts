/**
 * GET /api/v1/mcp/tools
 *
 * Catalogo de tools MCP serializado para a UI consumir (Spec 11 + EPIC-13
 * S-13.03 AC). Usa cookie session (Spec 01 auth dual). Resposta:
 *   { data: { tools: [{ id, description, input_schema, category, requires_role }] } }
 *
 * `input_schema` e o JSON Schema gerado a partir do Zod raw shape.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { allTools } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });

  const tools = allTools.map((t) => ({
    id: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(z.object(t.inputSchema), { target: "openApi3" }),
    category: t.category,
    requires_role: t.requiresRole,
    requires_scope: t.requiresScope,
  }));

  return ok({ tools }, { requestId });
}
