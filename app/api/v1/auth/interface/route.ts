import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { lerInterface } from "@/lib/navigation/interface";
import { ok } from "@/lib/api/wrappers";
export const dynamic = "force-dynamic";
/** Somente contexto próprio. Payload de Realtime invalida, nunca autoriza. */
export async function GET() {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "interface" });
  if (!authz.ok) return authz.response;
  const settings = lerInterface(authz.org.interface_settings).settings;
  const response = ok(
    {
      organization_id: authz.org.orgId,
      // O nome junto do id: é o que o aviso da #2335 mostra na tela — um uuid
      // cru no aviso é exatamente o defeito que o conserto de `no_active_org`
      // descreve em `lib/api/client.ts`.
      organization_name: authz.org.name,
      interface_settings: settings,
      signature: JSON.stringify(settings),
    },
    { requestId },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
