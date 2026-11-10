/**
 * Semente do módulo "Recursos opcionais" (Configurações › Recursos opcionais).
 *
 * A tela só LÊ: os dados que ela mostra são a base + o estado de fábrica. Para
 * ensinar a diferença entre módulo desligado e disponível, liga o módulo
 * Propostas da instalação pela mesma linha que `gravarModulo`
 * (lib/instalacao/modulos.ts) grava. A base devolve a instalação ao estado de
 * fábrica antes de cada lição, então isto roda a cada lição. A chave da empresa
 * (organizations.settings.proposals) fica desligada, como numa instalação
 * recém-liberada.
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
