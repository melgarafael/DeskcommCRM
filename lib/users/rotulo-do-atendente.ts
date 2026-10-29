/**
 * O rótulo de quem atende — UM lugar para as telas que precisam dele (#3023).
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * Membro sem `full_name` no cadastro (service role fora do ar, perfil antigo sem
 * nome, convite nunca completado) aparecia na tela como duas coisas diferentes e
 * ambas erradas: o seletor de transferência montava `Atendente 4fa3a91c` — os
 * oito primeiros dígitos do `user_id` — e a menção do compositor escrevia o
 * mesmo `uuid8`, que ia parar GRAVADO no corpo da nota. O `user_id` é
 * identificador interno: não é nome, muda de instalação para instalação, não
 * ajuda ninguém a reconhecer a pessoa e vaza um pedaço de uuid para dentro de
 * texto que circula (a nota é lida por colegas e notifica quem foi mencionado).
 *
 * ## O que este rótulo é
 *
 * `rotuloDoAtendente` devolve o nome cadastrado quando existe; quando não
 * existe, o MESMO rótulo genérico e estável em qualquer tela e em qualquer
 * render — nunca um pedaço de `user_id`, nunca um dado pessoal. As duas telas
 * que antes inventavam rótulo cada uma do seu jeito (o `ReassignDialog` e o
 * `opcoesDeMencao` do compositor, usado pelo `MentionMenu`) bebem daqui.
 *
 * `full_name` em branco conta como sem nome: `"   "` não é nome de ninguém, e
 * sem o `trim` a lista mostraria uma linha vazia e o `<Select>` do shadcn uma
 * opção em branco.
 *
 * ## O que ele NÃO faz, de propósito
 *
 * Não cai para e-mail (nem para telefone, nem para `user_metadata` inteiro).
 * Seria o único dado que distinguiria dois atendentes sem nome, mas e-mail é
 * dado pessoal e expô-lo numa lista para toda a organização é decisão de LGPD
 * do mantenedor, não de um rótulo de tela: fica pendente de aval (ver a pergunta
 * no corpo do PR). Sem ele, dois membros sem nome mostram a mesma linha — é o
 * custo aceito de não inventar dado pessoal nenhum.
 *
 * LGPD: o rótulo expõe o `full_name` que a própria tela já expunha. Nada mais.
 */

/**
 * A chave i18n do rótulo. Vive aqui, e não na tela, para as duas telas pedirem
 * a MESMA tradução — `lib/i18n/dicionario.ts` já tem esta chave com o espanhol.
 */
export const ROTULO_ATENDENTE_SEM_NOME = "Atendente sem nome";

/** O `t` do `useT()` (`lib/i18n/IdiomaProvider.tsx`): chave → texto no idioma. */
export type Tradutor = (texto: string) => string;

/**
 * O nome do atendente, ou o rótulo único de quem não tem nome (puro, testável).
 *
 * Puro de propósito, e sem I/O: é chamado dentro do `map` de uma lista a cada
 * render, nas duas telas. Todo o resto do custo do nome mora no servidor
 * (`lib/users/nome-do-atendente.ts`, `lib/users/com-nome-do-atendente.ts`) — aqui
 * só se decide o que a tela escreve.
 */
export function rotuloDoAtendente(
  full_name: string | null | undefined,
  t: Tradutor,
): string {
  const nome = full_name?.trim();
  return nome ? nome : t(ROTULO_ATENDENTE_SEM_NOME);
}
