/**
 * Os tetos do PLANO DE TAREFAS, num lugar só: o `planoSchema` de
 * `lib/tarefas/plano.ts` recusa por eles e a tela Tarefas › Planos os usa como
 * `maxLength`, contador e mensagem de recusa.
 *
 * Arquivo próprio porque a tela é componente de cliente e `plano.ts` puxa o
 * caminho de gravação das tarefas — importar a constante de lá levaria o
 * módulo de servidor para o navegador.
 *
 * Escritos duas vezes, a tela deixava digitar além do que a rota aceita e a
 * recusa chegava como "Dados inválidos." sem dizer o campo: uma descrição de
 * 301 caracteres não salvava e ninguém sabia por quê.
 */
export const LIMITES_DO_PLANO = {
  nome: 120,
  descricao: 300,
  tituloDoPasso: 200,
  descricaoDoPasso: 1000,
  venceEmDias: 365,
  passos: 30,
  planos: 50,
} as const;
