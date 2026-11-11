import type { ExtensionConfiguration } from "./manifest";
import type { PaletaDeTema } from "./tema";

/**
 * O que o cartão da extensão instalada EDITA, e o que ele não pode apagar.
 *
 * ── O defeito que esta função fecha (issue #3792) ───────────────────────────
 *
 * O formulário do cartão conhece dois campos (`density`, `show_description`) e
 * montava o corpo do `PUT /api/v1/extensions/:id/configuration` a partir DELES.
 * Como a rota substitui a configuração inteira (é um PUT), salvar a densidade
 * apagava `configuration.theme` — a paleta que a organização tinha ligado pela
 * API —, e o tema da organização sumia sem aviso nenhum. O mesmo valia para
 * qualquer chave futura que a tela não mostre.
 *
 * ── A REGRA DE MERGE (a mesma que o PR documenta) ───────────────────────────
 *
 * A base é o que já está GRAVADO (`configuracaoGravada`), e o formulário
 * sobrepõe só o que ele edita. Chave que a tela não edita continua com o valor
 * gravado; chave que a tela edita recebe o valor da tela.
 *
 * `theme` é o caso especial que motiva a função, porque pode estar gravado sem
 * a tela mexer nele:
 *
 *   - `edicao.theme === undefined`: a tela NÃO editou o campo (a extensão não
 *     declara tema, ou a pessoa não tocou nele). O valor gravado é PRESERVADO,
 *     inclusive quando o manifesto atual já não oferece a paleta que está lá —
 *     um pacote que perdeu o tema não é motivo para apagar em silêncio a
 *     escolha da organização;
 *   - `edicao.theme.escolha === null`: a pessoa escolheu "Nenhuma (padrão do
 *     produto)". A chave SAI do objeto (o banco não guarda `null` em
 *     `configuration.theme`; desligar é a chave sumir);
 *   - `edicao.theme.escolha` é uma paleta: `theme` grava essa paleta — e só
 *     quando o manifesto declara uma (`paletaOferecida !== null`), porque quem
 *     aplica o tema exige a igualdade com a paleta do manifesto
 *     (`temaAplicavel`, `lib/extensions/tema.ts`): gravar outra seria gravar
 *     uma escolha que o host recusa.
 *
 * Sem efeito colateral: devolve um objeto novo, não toca no que recebeu.
 */
export type EdicaoDoCartao = {
  density: ExtensionConfiguration["density"];
  show_description: boolean;
  /** Ausente = a tela não editou a paleta. `escolha: null` = "Nenhuma". */
  theme?: { escolha: PaletaDeTema | null };
};

export function configuracaoAoSalvar(
  configuracaoGravada: ExtensionConfiguration,
  edicao: EdicaoDoCartao,
  paletaOferecida: PaletaDeTema | null,
): ExtensionConfiguration {
  // O spread é a regra: tudo o que a tela não edita sobrevive ao salvamento.
  const configuracao: ExtensionConfiguration = {
    ...configuracaoGravada,
    density: edicao.density,
    show_description: edicao.show_description,
  };
  if (paletaOferecida === null || edicao.theme === undefined) return configuracao;
  if (edicao.theme.escolha === null) {
    delete configuracao.theme;
    return configuracao;
  }
  configuracao.theme = edicao.theme.escolha;
  return configuracao;
}
