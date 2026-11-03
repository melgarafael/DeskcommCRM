/**
 * A régua da OPÇÃO DO CAMPO no SERVIDOR (#3508) — a tradução do veredito puro
 * (`lib/leads/campos-pesquisaveis`) para o que as rotas fazem com ele.
 *
 * ─── Por que um módulo, e não três linhas em cada handler ──────────────────
 *
 * Três caminhos de escrita perguntam a mesma coisa (API REST, as tools MCP
 * `crm_create_lead`/`crm_update_lead`, e a captação por webhook), e dois deles
 * escrevem de verdade: `createLeadHandler` e `updateLeadHandler`. A decisão de
 * "recusa ou grava o cru" NÃO pode ser reescrita em cada um: um `catch` que
 * engole a recusa num deles é exatamente o defeito que a #3508 fecha por outro
 * lado.
 *
 * ─── A política, em uma frase ─────────────────────────────────────────────
 *
 * O que casa vira o `value` da opção em QUALQUER caminho. O que não casa:
 *
 *   - API e MCP → 422 `custom_field_value_not_in_list`, com o campo e o valor
 *     recusado em `details.recusas`, e NADA é gravado;
 *   - captação por webhook → entra como veio (`manterForaDaLista`), porque
 *     recusar perderia o lead do formulário — a mesma decisão do #2295 e do
 *     #2730, e a razão de a opção existir.
 *
 * Quem decide é o CHAMADOR (a rota de captação passa a opção; nenhuma outra
 * passa), e não o `ctx.actor`: `webhook_source` também é o ator da automação
 * `create_or_move_lead` e da prospecção, que continuam na régua.
 */
import { ApiError } from "@/lib/api/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  canonizarCamposDoFunil,
  type RecusaDeOpcao,
} from "@/lib/leads/campos-pesquisaveis";
import { defsDoPadraoDoFunil } from "@/lib/leads/padrao-do-campo";

/**
 * A frase da recusa. O campo e o valor que não casaram vão colados nela em
 * `erroForaDaLista`: a frase é a chave traduzível, e o dado do tenant não é —
 * mas quem escreve por tool recebe só a mensagem (ver o comentário lá).
 */
export const MENSAGEM_DE_FORA_DA_LISTA =
  "O valor não é uma das opções cadastradas neste campo.";

/** 422: o valor não é nenhuma das opções do campo de seleção do funil. */
export function erroForaDaLista(
  recusas: readonly RecusaDeOpcao[],
  requestId: string,
  idioma: Idioma = "pt-BR",
): ApiError {
  // A frase é a chave traduzível; o CAMPO e o VALOR vão colados nela porque
  // quem escreve por tool (o agente de IA) recebe só a mensagem — `details` não
  // atravessa o servidor MCP (`lib/mcp/server.ts` devolve `err.message`). Sem
  // isto o modelo leria "o valor não é uma opção" sem saber de que campo.
  const primeira = recusas[0];
  const onde = primeira ? ` Campo "${primeira.campo}", valor "${primeira.valor}".` : "";
  return new ApiError(
    422,
    "custom_field_value_not_in_list",
    { recusas },
    requestId,
    `${traduzir(MENSAGEM_DE_FORA_DA_LISTA, idioma)}${onde}`,
  );
}

/**
 * Julga o que a escrita vai gravar e devolve SÓ o que muda, já canônico.
 *
 * `settings` é o do funil de DESTINO (o `settingsDoFunil` de sempre), e a
 * leitura é fail-open como as outras réguas: funil ilegível não tem definição,
 * não tem opção, e a escrita segue como hoje — a régua só manda no que ela
 * consegue ler.
 *
 * `aJulgar` é o RECORTE a julgar, não o `custom_fields` inteiro: na edição é o
 * que mudou contra o gravado (a ficha manda o formulário todo, e um valor
 * antigo fora da lista não pode barrar a troca de outro campo), e no clone é o
 * que difere do negócio de origem.
 *
 * Lança quando há recusa e o chamador não abriu a exceção da captação. Quem
 * chama aplica `mudados` por cima do `custom_fields` inteiro: o que não está
 * aqui nem foi tocado.
 */
export function canonizaOpcoesDoFunil(
  settings: unknown,
  aJulgar: Record<string, unknown> | undefined | null,
  ctx: { requestId: string; idioma?: Idioma },
  opcoes: { manterForaDaLista?: boolean } = {},
): { mudados: Record<string, unknown>; recusas: RecusaDeOpcao[] } {
  if (!aJulgar || Object.keys(aJulgar).length === 0) return { mudados: {}, recusas: [] };

  const { mudados, recusas } = canonizarCamposDoFunil(
    defsDoPadraoDoFunil(settings, "negocio"),
    aJulgar,
  );

  if (recusas.length > 0 && opcoes.manterForaDaLista !== true) {
    throw erroForaDaLista(recusas, ctx.requestId, ctx.idioma ?? "pt-BR");
  }

  // `mudados` e `recusas` vêm disjuntos (o recusado nunca é canônico), então o
  // que se aplica aqui é só o que casou; o resto continua como veio.
  return { mudados, recusas };
}
