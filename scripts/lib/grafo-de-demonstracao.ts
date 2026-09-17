/**
 * O grafo de follow-up que o seed de demonstração publica.
 *
 * ⚠️ VIVE FORA DO SEEDER DE PROPÓSITO, e a razão é poder ser TESTADO. O seeder
 * chama `main()` no topo do módulo — importá-lo de um teste rodaria o seed
 * contra o banco de quem rodou a suíte. Aqui é só dado, e
 * `tests/unit/grafo-de-demonstracao-e-valido.test.ts` o passa pelo
 * `flowGraphSchema` de verdade.
 *
 * Por que isso merece teste: um grafo que o validador recusa é gravado sem erro
 * (o INSERT só vê `jsonb`) e só falha quando alguém abre o construtor — ou seja,
 * na demonstração, na frente de quem se queria impressionar. O schema é
 * `strictObject` em quase toda parte, então uma chave a mais reprova, e o
 * `waitConfigSchema` tem piso de 300.000 ms que ninguém adivinha.
 */

/** Os ids são nomeados porque as inscrições do seed apontam para eles. */
export const NO_INICIO = "trigger-1";
export const NO_ESPERA = "wait-1";
export const NO_MENSAGEM = "action-1";
export const NO_RESPOSTA = "reply-1";
export const NO_FIM = "end-1";
export const NO_QUIS_SEGUIR = "end-2";

const DIA_MS = 24 * 60 * 60 * 1000;

/** Quanto o nó de espera segura a inscrição antes de mandar a mensagem. */
export const ESPERA_MS = DIA_MS;
/** Quanto o nó de resposta espera o cliente antes de seguir por "sem resposta". */
export const PRAZO_DA_RESPOSTA_MS = 2 * DIA_MS;

/**
 * Início → espera → mensagem → espera a resposta → fim.
 *
 * O nó de resposta NÃO é enfeite: é o único jeito de uma inscrição deste fluxo
 * ficar "Aguardando resposta". O motor só grava `waiting_reply` num nó que
 * espera o cliente (`match_reply`/`ai_classify`); um fluxo que termina na
 * mensagem nunca passa por esse estado, e a primeira versão da demonstração
 * mostrava uma inscrição "aguardando resposta" parada no nó da mensagem — um
 * estado que o motor não produz. Sem IA de propósito: `match_reply` casa texto,
 * e a demonstração não depende de chave de provedor.
 *
 * O resto continua sendo o menor grafo que o validador aceita e o motor sabe
 * percorrer: toda saída do nó de resposta (a declarada, "sem resposta" e a de
 * escape) está ligada, que é o que o publish exige.
 */
export const GRAFO_DE_DEMONSTRACAO = {
  nodes: [
    { id: NO_INICIO, type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: NO_ESPERA,
      type: "wait",
      label: "Espera 1 dia",
      position: { x: 240, y: 0 },
      config: { mode: "fixed", duration_ms: ESPERA_MS },
    },
    {
      id: NO_MENSAGEM,
      type: "action",
      label: "Retoma o contato",
      position: { x: 480, y: 0 },
      config: {
        mode: "text",
        body: "Oi! Passando para saber se você ainda tem interesse. Posso ajudar em algo?",
      },
    },
    {
      id: NO_RESPOSTA,
      type: "match_reply",
      label: "Espera a resposta",
      position: { x: 720, y: 0 },
      config: {
        branches: [{ id: "quer-seguir", label: "Quer seguir", op: "contains", pattern: "sim" }],
        grace_timeout_ms: PRAZO_DA_RESPOSTA_MS,
      },
    },
    {
      id: NO_FIM,
      type: "end",
      label: "Encerra",
      position: { x: 960, y: 120 },
      config: { outcome: "exhausted" },
    },
    {
      id: NO_QUIS_SEGUIR,
      type: "end",
      label: "Encerra: quis seguir",
      position: { x: 960, y: -120 },
      config: { outcome: "converted" },
    },
  ],
  edges: [
    { id: "e1", source: NO_INICIO, target: NO_ESPERA, priority: 0, condition: { type: "always" } },
    { id: "e2", source: NO_ESPERA, target: NO_MENSAGEM, priority: 0, condition: { type: "always" } },
    { id: "e3", source: NO_MENSAGEM, target: NO_RESPOSTA, priority: 0, condition: { type: "always" } },
    {
      id: "e4",
      source: NO_RESPOSTA,
      target: NO_QUIS_SEGUIR,
      priority: 0,
      condition: { type: "branch", branch_id: "quer-seguir" },
    },
    {
      id: "e5",
      source: NO_RESPOSTA,
      target: NO_FIM,
      priority: 0,
      condition: { type: "branch", branch_id: "no_reply" },
    },
    // Respondeu, mas não "sim": a saída de escape que o publish exige vai para o mesmo fim.
    { id: "e6", source: NO_RESPOSTA, target: NO_FIM, priority: 0, condition: { type: "always" } },
  ],
};
