/**
 * As abas de seção que viviam aqui foram removidas: só apareciam para quem já
 * estava dentro de `/app/ai/*`, o que deixava Conhecimento, Credenciais, Uso,
 * Casos e Alertas invisíveis do resto do sistema. Quem faz esse trabalho agora
 * é o hub em `/app/ai`, alcançável pelo sidebar.
 */
/**
 * A superficie clara de toda a area de IA.
 *
 * ── Por que aqui, e nao tela por tela ───────────────────────────────────────
 *
 * Sao VINTE rotas sob `/app/ai`. O pedido nomeou cinco (Agentes, Follow-ups,
 * Roteadores, o hub "Ver tudo em IA" e Evolucao da IA), mas acender so essas
 * deixaria Credenciais, Provedores, Conhecimento, Memoria, Skills, Casos,
 * Alertas, Propostas, Execucoes e Uso escuras ao lado delas — e as dez estao a
 * um clique das cinco, no mesmo hub. Meia area pintada e mais visivel que
 * nenhuma.
 *
 * ── Por que SEM `p-6` ──────────────────────────────────────────────────────
 *
 * `-m-6` cancela o respiro do `<main>` do AppShell para o Paper alcancar a
 * borda; quem o repoe e cada pagina. Dezoito das vinte ja repunham (pela
 * propria pagina ou pelo componente que ela devolve). As duas que faltavam —
 * `followups/[id]` e `followups/enrollments/[id]` — passaram a dizer o `p-6`
 * que ja tinham na pratica, vindo do `<main>`. O pixel e o mesmo de antes.
 *
 * O `min-h-0 flex-1` de dentro fica como estava: e ele que permite as telas de
 * altura cheia (o construtor de fluxo, as listas com rolagem propria)
 * encolherem em vez de empurrar a pagina.
 *
 * ── Por que `min-h` e nao `h` ──────────────────────────────────────────────
 *
 * O `min-h-0 flex-1` logo abaixo PARECE um rolador e nao e: medido no
 * navegador, ele tem `overflow: visible`. Quem rola nas telas de IA e o
 * `<main>`, como no resto do sistema.
 *
 * Com altura travada (`h-`) o Paper ficava do tamanho da janela — 816px — e o
 * conteudo rolava ate 2616px por cima dele: a partir da primeira dobra
 * reaparecia o fundo escuro, que e o mesmo defeito que este trabalho veio
 * consertar, so que por dentro. `min-h` faz o wrapper crescer junto.
 *
 * A altura travada continua certa em UM lugar: o quadro do funil
 * (`app/app/pipelines/[id]/_client.tsx`), que rola na horizontal por dentro e
 * precisa de um pai medido.
 */
export default function AiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-superficie="clara"
      className="-m-6 flex min-h-[calc(100%+3rem)] flex-col bg-bg text-text"
    >
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
