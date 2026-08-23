import { getAdapter } from "@/lib/channels";
import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const db = createAdminClient();
  const { data: sessao, error } = await db
    .from("channel_sessions")
    .select("organization_id")
    .eq("provider", "meta_cloud")
    .maybeSingle();
  if (error || !sessao) {
    throw new Error(`sem sessão meta_cloud no banco: ${error?.message ?? "nenhuma linha"}`);
  }

  const a = getAdapter("meta_cloud");
  console.info("isConfigured:", a.isConfigured());
  const to = a.resolveRecipient({
    isGroup: false, groupChatId: null, phoneNumber: "+55 31 99896-6398", waIdentity: null,
  });
  console.info("destinatario resolvido:", to);
  try {
    const r = await a.send({
      organizationId: sessao.organization_id,
      sessionRef: "ignorado",
      to: to!,
      kind: "text",
      body: "Teste do adapter oficial do DeskcommCRM.",
    });
    console.info("ENVIADO:", JSON.stringify(r));
  } catch (e) {
    console.info("RECUSADO:", e instanceof Error ? e.message : String(e));
  }
}
void main();
