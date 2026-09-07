import { createClient } from "@/lib/supabase/server";
import { readSupportContext } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
export async function GET() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return fail("unauthenticated", "Entre novamente.", 401);
  const support = await readSupportContext(db);
  return ok({ signature: support ? `${support.id}:${support.access_mode}:${support.status}` : "normal" });
}
