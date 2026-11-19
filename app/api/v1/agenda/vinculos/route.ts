import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, { requestId, resource: "agenda", role: "agent", scope: "mcp:read" });
  if (!auth.ok) return auth.response;
  const teto = await tetoDeEscritaDoToken(auth, "agenda_vinculos", requestId); if (teto) return teto;
  const input = z
    .object({ contact_id: z.uuid().optional(), q: z.string().max(100).optional() })
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return fail("validation_failed", "Confira o contato.", 422, { requestId });
  const db = auth.supabase;
  let contacts = db
    .from("contacts")
    .select("id,name,display_name,phone_number")
    .eq("organization_id", auth.organizationId)
    .eq("is_anonymized", false)
    .order("display_name", { nullsFirst: false })
    .order("name")
    .limit(30);
  if (input.data.contact_id) contacts = contacts.eq("id", input.data.contact_id);
  else if (input.data.q) {
    // Vírgulas e parênteses delimitam o DSL do PostgREST, não o nome buscado.
    const termo = input.data.q
      .trim()
      .replace(/[%_\\]/g, "")
      .replace(/[,()]/g, " ");
    contacts = contacts.or(`display_name.ilike.%${termo}%,name.ilike.%${termo}%`);
  }
  const result = await contacts;
  if (result.error)
    return fail("internal_error", "Não foi possível carregar os contatos.", 500, { requestId });
  const conversations =
    input.data.contact_id && result.data.length
      ? await db
          .from("conversations")
          .select("id,created_at,status")
          .eq("organization_id", auth.organizationId)
          .eq("contact_id", input.data.contact_id)
          .eq("is_group", false)
          .order("created_at", { ascending: false })
          .limit(30)
      : { data: [], error: null };
  if (conversations.error)
    return fail("internal_error", "Não foi possível carregar as conversas.", 500, { requestId });
  return ok(
    {
      contacts: result.data.map((contato) => ({ id: contato.id, name: rotuloDoContato(contato) })),
      conversations: conversations.data,
    },
    { requestId },
  );
}
