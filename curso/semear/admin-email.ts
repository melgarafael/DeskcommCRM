/**
 * Semente do módulo E-mail (Admin): não cria nada. Ela só GARANTE que a
 * instalação está sem servidor de e-mail próprio gravado, que é o estado que as
 * lições fotografam (campos vazios, "Nenhum caminho de e-mail configurado").
 *
 * `platform_smtp_settings` não entra no estado de fábrica da base, e uma linha
 * preenchida faria os convites de todos os outros módulos tentarem sair por um
 * servidor que não existe. As lições nunca clicam no "Salvar" do servidor; isto
 * é a rede de segurança. Sem DELETE: o `service_role` só tem select/insert/update
 * nessa tabela, então uma linha que exista é esvaziada, nunca apagada.
 *
 * O serviço externo (RESEND_*) mora em `platform_config`, que a base já devolve
 * ao estado de fábrica antes de cada lição.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  const r = await c.db.from("platform_smtp_settings").select("smtp_host, from_email, smtp_username, smtp_password_encrypted, from_name").eq("id", 1).maybeSingle();
  semErro(r, "ler platform_smtp_settings");
  const linha = r.data as Record<string, string | null> | null;
  if (linha && Object.values(linha).some(Boolean)) {
    semErro(
      await c.db.from("platform_smtp_settings").update({
        smtp_host: null, smtp_port: 587, smtp_security: "starttls", smtp_username: null,
        smtp_password_encrypted: null, from_email: null, from_name: null,
      }).eq("id", 1),
      "esvaziar platform_smtp_settings",
    );
    console.info("admin-email: servidor de e-mail esvaziado");
  }
  console.info(`admin-email: linha do servidor ${linha ? "existe" : "não existe"}`);
}
