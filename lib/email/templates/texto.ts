/**
 * O preenchimento dos moldes de e-mail: `{chave}` → valor.
 *
 * Os textos vivem no dicionário da interface com espaço reservado (`{marca}`,
 * `{organizacao}`) porque o valor só existe no momento do envio. A ordem
 * importa: TRADUZ primeiro (`traduzir`), PREENCHE depois — assim o espanhol
 * mantém o espaço reservado na posição que a gramática dele pede, e não a que o
 * português usou.
 *
 * Não escapa nada: quem escapa é o molde, no fim (`escapeHtml` sobre o texto já
 * preenchido). Escapar aqui e de novo lá transformaria `&` em `&amp;amp;`.
 */
export function preencher(texto: string, valores: Readonly<Record<string, string>>): string {
  return Object.entries(valores).reduce(
    (acc, [chave, valor]) => acc.split(`{${chave}}`).join(valor),
    texto,
  );
}
