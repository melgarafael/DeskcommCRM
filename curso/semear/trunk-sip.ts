/**
 * Semente do módulo "Trunk SIP": a tela começa como numa instalação fresca,
 * sem provedor cadastrado. As lições cadastram um pela própria tela (o Salvar
 * real, que cifra a senha); aqui só apagamos a linha que uma rodada anterior
 * deixou. Uma linha por organização (organization_id é a chave primária).
 */
import { type Contexto, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  semErro(await c.db.from("voip_trunk_settings").delete().eq("organization_id", c.org), "limpar trunk SIP");
}
