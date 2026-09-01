import { getAdapter } from "@/lib/channels";
async function main() {
  const a = getAdapter("meta_cloud");
  console.info("isConfigured:", a.isConfigured());
  const to = a.resolveRecipient({
    isGroup: false, groupChatId: null, phoneNumber: "+55 31 99896-6398", waIdentity: null,
  });
  console.info("destinatario resolvido:", to);
  try {
    const r = await a.send({ sessionRef: "ignorado", to: to!, kind: "text", body: "Teste do adapter oficial do SonghaiCRM." });
    console.info("ENVIADO:", JSON.stringify(r));
  } catch (e) {
    console.info("RECUSADO:", e instanceof Error ? e.message : String(e));
  }
}
void main();
