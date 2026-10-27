// Apaga PELA API do Storage os arquivos dos envios de prova (o DELETE em storage.objects
// deixaria o arquivo no disco). Roda DENTRO do contêiner do app, que tem a chave de serviço:
//   docker exec -i deskcommcrm-teste-app-1 node - < envios-apagar-arquivos.mjs <caminhos separados por espaço via ARQUIVOS=...
const caminhos = (process.env.ARQUIVOS ?? "").split(/\s+/).filter(Boolean);
if (caminhos.length === 0) {
  console.log("nada a apagar");
  process.exit(0);
}
const base = (process.env.SUPABASE_SERVER_URL || process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
const r = await fetch(`${base}/storage/v1/object/agencia-envios`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${chave}`, apikey: chave, "Content-Type": "application/json" },
  body: JSON.stringify({ prefixes: caminhos }),
});
console.log("apagados:", r.status, (await r.json()).length ?? "?");
