/**
 * Semente do módulo "Propostas" (Configurações › Propostas).
 *
 * A tela só existe com o recurso opcional Propostas ligado NA INSTALAÇÃO
 * (`/admin/sistema`), e a base devolve a instalação ao estado de fábrica antes
 * de cada lição — então ligamos aqui, pela mesma linha que `gravarModulo`
 * (lib/instalacao/modulos.ts) grava. A chave da EMPRESA (organizations.settings
 * .proposals) fica desligada, como numa instalação recém-liberada: é ela que as
 * lições ensinam a ligar pela tela.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  const { db, pessoa } = c;
  semErro(
    await db.from("platform_config").upsert(
      { chave: "MODULO_PROPOSTAS", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena },
      { onConflict: "chave" },
    ),
    "ligar o módulo Propostas",
  );
}
