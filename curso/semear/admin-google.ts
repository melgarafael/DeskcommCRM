/**
 * Semente do módulo Google Agenda (Admin): não cria nada. Ela só GARANTE que a
 * instalação está sem o aplicativo do Google cadastrado, que é o estado que as
 * lições fotografam (campos vazios, "Nunca configurado por aqui.").
 *
 * `platform_google_oauth` não entra no estado de fábrica da base, e uma linha
 * preenchida mudaria as fotos de outros módulos (o quadro "Sincronizar com o
 * Google ainda não está disponível" da Agenda, o Google Agenda dos Recursos
 * opcionais). As lições nunca clicam em "Salvar"; isto é a rede de segurança.
 * Sem DELETE: o `service_role` só tem select/insert/update nessa tabela, então
 * uma linha que exista é esvaziada, nunca apagada.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  const r = await c.db.from("platform_google_oauth").select("client_id, client_secret_encrypted").eq("id", 1).maybeSingle();
  semErro(r, "ler platform_google_oauth");
  const linha = r.data as { client_id: string | null; client_secret_encrypted: string | null } | null;
  if (linha && (linha.client_id || linha.client_secret_encrypted)) {
    semErro(
      await c.db.from("platform_google_oauth").update({ client_id: null, client_secret_encrypted: null }).eq("id", 1),
      "esvaziar platform_google_oauth",
    );
    console.info("admin-google: credencial do Google esvaziada");
  }
  console.info(`admin-google: linha do Google ${linha ? "existe" : "não existe"}`);
}
