/**
 * AS CHAVES DO CLIMA — o que o worker grava em `messages.metadata` e manda no
 * `ai.sentiment_alert`, num lugar só.
 *
 * O worker escreve; a rota do cartão do Jev lê por caminho jsonb no PostgREST
 * (a concordância); a passagem para humano lê o motor (D11). Com o literal em
 * cada ponta, renomear a chave de um lado deixava os testes dos dois verdes e a
 * concordância do cartão em "nenhuma mensagem comparada" para sempre, sem erro:
 * caminho jsonb ausente volta `null` (anti-pattern 6, `jsonb` sem schema central).
 */
export const CHAVES_DO_CLIMA = {
  /** A nota que decidiu, de 0 (irritado) a 1. */
  nota: "sentiment_score",
  /** Quem mediu a nota que decidiu. */
  motor: "sentiment_engine",
  /** A nota do Jev, também em observação — é o par da concordância. */
  notaDoJev: "sentiment_jev_score",
  /** A versão do Jev que respondeu. */
  modeloDoJev: "sentiment_jev_model",
  /**
   * O limiar COM O QUAL a nota foi cortada naquela decisão — o
   * `config.sentiment_threshold` do agente da conversa (#2216), ou o padrão do
   * produto. A concordância do cartão do Jev lê por aqui (issue #2219): sem
   * esta chave, um agente em 0,1 teria a conta medida contra 0,3. Mensagem
   * gravada antes do #2219 não tem a chave — quem lê cai no padrão.
   */
  limiar: "sentiment_threshold",
} as const;

export type MotorDoClima = "jev" | "llm";
