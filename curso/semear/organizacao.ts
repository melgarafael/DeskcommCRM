/**
 * Semente do módulo Organização: só o CNPJ da Clínica Bem Viver, para o
 * formulário não aparecer com o documento em branco. O resto da tela (nomes,
 * fuso, idioma, retenção, encarregado) já vem da base.
 *
 * Idempotente: um UPDATE na própria organização. O CNPJ volta ao estado de
 * fábrica na base antes de cada lição (está em DA_ORGANIZACAO).
 */
import { type Contexto, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  semErro(
    await c.db.from("organizations").update({ cnpj: "41.287.556/0001-30", dpo_email: null, privacy_policy_url: null }).eq("id", c.org),
    "CNPJ da clínica",
  );
}
