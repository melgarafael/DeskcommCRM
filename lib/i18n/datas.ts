import { es, ptBR } from "date-fns/locale";
import type { Locale } from "date-fns";

import { IDIOMA_PADRAO, type Idioma } from "./idiomas";
import { idiomaVisivelPorCodigo } from "./registro";

/**
 * A DATA no idioma de quem está lendo.
 *
 * ─── O buraco que este arquivo fecha ───────────────────────────────────────
 *
 * A tradução de TEXTO ficou completa antes desta camada existir, e o resultado
 * era uma tela meio traduzida de um jeito que só se vê olhando: rótulo,
 * cabeçalho e botão em espanhol, com "quinta-feira, 3 de março" no meio. Pior
 * que o português inteiro, porque parece bug em vez de parecer decisão.
 *
 * A causa era mecânica: `locale: ptBR` estava escrito à mão em 38 arquivos,
 * importado direto do `date-fns/locale`. Nenhum deles perguntava quem estava
 * lendo — não havia a quem perguntar.
 *
 * ─── Por que um mapa, e não o código do idioma direto ──────────────────────
 *
 * O `date-fns` não aceita a string `"es"`: ele quer o OBJETO `Locale`, com as
 * tabelas de mês, dia e distância. E o nosso código de idioma (`pt-BR`, `es`)
 * não casa um-para-um com o nome do módulo dele. Um mapa explícito torna a
 * correspondência visível e obriga quem acrescentar um idioma a decidir a
 * dupla — em vez de descobrir em produção que a data caiu no inglês.
 *
 * ─── O fallback é o padrão do produto, nunca o inglês ──────────────────────
 *
 * Idioma desconhecido devolve português, que é o comportamento de antes desta
 * camada. `date-fns` sem `locale` cai no inglês, e uma tela em espanhol com
 * "Thursday" é o pior dos três mundos.
 */
const LOCALE_DE_DATA: Record<Idioma, Locale> = {
  "pt-BR": ptBR,
  es,
};

/** O `Locale` do date-fns para quem está lendo. */
export function localeDeData(idioma: Idioma): Locale {
  return LOCALE_DE_DATA[idioma] ?? LOCALE_DE_DATA[IDIOMA_PADRAO];
}

/**
 * A etiqueta BCP-47 para as APIs nativas (`Intl`, `toLocaleString`).
 *
 * ⚠️ `es` e não `es-ES`, e a escolha é medida: o público desta tradução é a
 * AMÉRICA LATINA, e `es-ES` traria convenções da Espanha. Com `es` puro, o
 * navegador resolve pela região de quem lê — que é exatamente o que se quer
 * numa instalação que pode estar na Colômbia, no México ou na Argentina.
 *
 * Número não muda de forma entre `pt-BR` e `es` (ambos usam ponto para milhar
 * e vírgula para decimal), então passar por aqui não altera o que já aparece —
 * o ganho é não haver um segundo lugar onde o idioma está escrito à mão.
 */
export function tagDeIdioma(idioma: Idioma): string {
  return idiomaVisivelPorCodigo(idioma).tagBcp47;
}
