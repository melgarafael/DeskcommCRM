/**
 * O TETO DE ESPERA das telas de verificação em duas etapas.
 *
 * As duas telas que conferem um código de 6 dígitos — a de entrar
 * (`MfaForm`) e a de ligar a verificação (`MfaEnrollModal`) — chamam Server
 * Actions que falam com o GoTrue duas vezes (desafio e verificação) e ainda
 * gravam auditoria ANTES de responder, nenhuma delas com timeout próprio.
 *
 * `startTransition` com função assíncrona só sai de `isPending` quando a
 * promessa assenta. Sem teto, qualquer um desses passos lento deixava o botão
 * em "Verificando…" para sempre — e, como o campo fica `disabled` enquanto
 * pendente, a pessoa não conseguia nem tentar de novo: a única saída era
 * recarregar a página.
 *
 * O número mora aqui, e não nas duas telas, porque duas cópias de uma constante
 * é a forma garantida de um dia só uma ser atualizada.
 *
 * 20s é folgado para duas idas ao GoTrue numa VPS modesta e curto o bastante
 * para não parecer travamento.
 */
export const TETO_DA_ESPERA_MS = 20_000;

/**
 * `redirect()` numa Server Action sinaliza por EXCEÇÃO, com `digest` começando
 * em "NEXT_REDIRECT" — é assim que o sucesso navega para `/app`. Um `catch` que
 * a tratasse como falha deixaria quem acertou o código preso na tela, lendo
 * "não consegui verificar". Quem captura erro de Server Action precisa deixar
 * esta passar.
 */
export function ehRedirecionamentoDoServidor(erro: unknown): boolean {
  const digest = (erro as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/**
 * A chamada de Server Action com teto — a forma que TODO formulário de
 * autenticação usa.
 *
 * Existe como função, e não como try/catch copiado em cada tela, porque o
 * defeito que ela conserta é de CLASSE: oito formulários de `components/auth/`
 * tinham `startTransition(async () => { await acao() })` sem `catch` e sem
 * limite, e qualquer um deles travava no botão de carregando se a ação
 * demorasse ou lançasse. Guarda copiada é guarda que um dia só metade recebe a
 * correção.
 *
 * Quem chama ainda precisa do `catch`, porque é lá que mora a MENSAGEM de cada
 * tela — e o `catch` precisa deixar passar o redirecionamento do servidor
 * (`ehRedirecionamentoDoServidor`).
 */
export function comTetoDeEspera<T>(promessa: Promise<T>): Promise<T> {
  return Promise.race([
    promessa,
    new Promise<never>((_, rejeita) =>
      setTimeout(() => rejeita(new Error("tempo_esgotado")), TETO_DA_ESPERA_MS),
    ),
  ]);
}
