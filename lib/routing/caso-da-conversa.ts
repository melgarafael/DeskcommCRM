/**
 * O CASO DA CONVERSA E A FILA DE ROTEAMENTO (issue #3717) — a regra pura.
 *
 * ## O defeito que isto fecha
 *
 * `trg_agent_case_opened` (`supabase/migrations/..._0148_caso_anuncia_no_barramento.sql:91-94`)
 * anuncia `ai.case_opened` quando um caso nasce em `awaiting_human`/`awaiting_lead`,
 * mas **a conversa continua com o status que já tinha** (`open`, `pending`,
 * `ai_handling`). Nada nesse caminho toca `conversations.status` nem
 * `assigned_to_user_id` — e `lib/followup/gatilho-caso.ts:29-44` documenta por
 * escrito que abrir caso NÃO cala o agente: a IA segue respondendo e pode
 * resolver o assunto sem que ninguém feche o caso.
 *
 * A elegibilidade de roteamento, por sua vez, só olhava para
 * `conversations` (`fn_wake_channel_routing`,
 * `..._0228_roteamento_por_canal_e_reservas.sql:76-81`:
 * `status in ('open','pending','claimed','ai_handling') and assigned_to_user_id is null`)
 * — e `lib/routing/decide.ts` / `lib/routing/eligibles.ts` **nunca** leram
 * `agent_cases`. Resultado: uma conversa cujo caso já não pede mais ninguém
 * (a bola está com o cliente, ou o caso já foi concluído sem que a conversa
 * saísse do pool) é reenfileirada a cada `fn_wake_channel_routing` — inclusive
 * pelo gatilho `trg_routing_availability_changed` — e horas depois o rodízio a
 * entrega a uma pessoa que não tem nada a fazer nela.
 *
 * ## A pergunta que a fila precisa fazer antes de sortear
 *
 * Não é "esta conversa tem caso?", é "**o caso desta conversa pede uma pessoa
 * agora?**". O vocabulário de `agent_cases.status`
 * (`supabase/migrations/..._0066_human_cases.sql:9`) tem cinco valores, e a
 * doutrina do repo já os separa em dois campos — não é leitura nova, é a mesma
 * de `lib/agent-engine/agent/operator-turn.ts:676-682`
 * ("`awaiting_human` e `escalated` são os estados em que a pergunta está com a
 * equipe; `awaiting_lead` já voltou para o cliente, e resolvido/cancelado não é
 * dono de nada") e a mesma da tela (`lib/ai/case-copy.ts:86`: em
 * `awaiting_lead` o "Aguardando o cliente responder — a IA avisa você quando
 * tiver a informação"):
 *
 *   | status            | de quem é a bola        | rotear? |
 *   |-------------------|-------------------------|---------|
 *   | `awaiting_human`  | da equipe               | SIM     |
 *   | `escalated`       | da equipe (foi adiante)| SIM     |
 *   | `awaiting_lead`   | do cliente              | NÃO     |
 *   | `resolved`        | de ninguém              | NÃO     |
 *   | `cancelled`       | de ninguém              | NÃO     |
 *
 * Ou seja: `awaiting_lead` significa que um HUMANO já pediu algo ao cliente
 * (`markAwaitingLead`) e está esperando a resposta — entregar a conversa a
 * outro atendente pelo rodízio nesse instante não acelera nada e ainda cria a
 * impressão de que alguém assumiu. E um caso terminal (`resolved`/`cancelled`)
 * é o desfecho que a issue descreve como "a IA já resolveu o assunto": se a
 * conversa ficou `open` porque ninguém a fechou, isso não a torna trabalho de
 * alguém.
 *
 * ## O corte temporal dos casos terminais, e por que ele existe
 *
 * Um caso `resolved` de ontem não pode calar a fila para sempre. Se o cliente
 * **voltou a falar depois** do encerramento (`conversations.last_inbound_at`
 * maior que `agent_cases.closed_at`), o assunto é outro: a fila volta a valer
 * como sempre valeu, e a IA que responder pode abrir um caso novo. Sem esse
 * corte, o cliente que escreve "e o boleto?" dois dias depois de um chamado
 * concluído nunca chegaria a um humano.
 *
 * ## O que esta regra NÃO resolve (declarado, não escondido)
 *
 * O caso `awaiting_human` que a IA resolveu na conversa **sem fechar o caso**
 * continua roteável. E deve: `awaiting_human` é, por definição, "a pergunta
 * está com a equipe", e não existe dado que diga "a IA já respondeu o
 * suficiente" — o mesmo motivo pelo qual a issue registra a opção (a) (algo
 * fechar/reaveriguar `agent_cases` quando a IA segue respondendo) como decisão
 * de produto, não de código. Esta fatia é a opção (b).
 *
 * ## O mesmo corte vale para `awaiting_lead`
 *
 * `awaiting_lead` só sai desse estado por `provideCaseUpdate`, que é uma
 * ferramenta do MODELO — e nenhum gatilho de `agent_cases` pede roteamento. Com
 * o agente pausado, ou com um modelo que não chama a ferramenta, o caso ficaria
 * `awaiting_lead` para sempre e a conversa, fora do rodízio para sempre, mesmo
 * com o cliente já tendo respondido. Por isso o pedido ao cliente só cala a
 * fila até o cliente falar: se `last_inbound_at` é maior que
 * `agent_cases.updated_at` (o instante da transição — a tabela não tem gatilho
 * de `updated_at`, e os dois escritores de `awaiting_lead`, `markAwaitingLead` e
 * `fn_responder_caso_por_whatsapp` no `baseline.sql`, gravam `updated_at = now()`), a
 * fila volta a valer.
 *
 * Nada aqui olha o relógio do processo: as duas datas comparadas vêm do banco.
 * Puro de propósito — quem lê o banco é `lib/routing/worker.ts`.
 */

/** O que o worker precisa saber do caso mais recente da conversa. */
export interface CasoDaConversa {
  status: string;
  /** `agent_cases.closed_at`; só os terminais o preenchem. */
  encerradoEm: string | null;
  /** `agent_cases.updated_at`; para `awaiting_lead`, o instante do pedido ao cliente. */
  atualizadoEm?: string | null;
}

/**
 * Por que o caso tira esta conversa da fila. Os dois valores são também o
 * `reason` do `skip` em `decideRouting` e o que vai para o `metadata` do
 * evento — distinguir `awaiting_lead` de "já concluído" é o que permite
 * responder depois "por que esta conversa não foi distribuída?".
 */
export type MotivoDoCaso = "caso_aguardando_cliente" | "caso_encerrado";

/** A pergunta está com a EQUIPE. */
const PEDE_PESSOA = new Set(["awaiting_human", "escalated"]);
/** A pergunta está com o CLIENTE: um humano já perguntou algo e espera. */
const AGUARDANDO_CLIENTE = new Set(["awaiting_lead"]);
/** Terminais: não é dono de nada. */
const ENCERRADOS = new Set(["resolved", "cancelled"]);

function instante(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `null` = a fila pode seguir (o caso pede uma pessoa, ou não há caso, ou o
 * status é desconhecido). Um `MotivoDoCaso` = NÃO rotule esta conversa.
 *
 * Status fora do vocabulário conhecido falham ABERTOS (`null`): um clone com
 * engine mais novo pode gravar um estado que este build não conhece, e parar a
 * distribuição de uma org inteira por causa disso é pior do que distribuir uma
 * conversa a mais — a mesma escolha de `operator-turn.ts:686` ("na dúvida o
 * aviso sai, que é o erro barato").
 */
export function motivoParaNaoRotear(
  caso: CasoDaConversa | null | undefined,
  ultimaEntradaDoCliente: string | null | undefined,
): MotivoDoCaso | null {
  if (!caso) return null;
  if (PEDE_PESSOA.has(caso.status)) return null;
  const falouEm = instante(ultimaEntradaDoCliente);
  // Só cala a fila se o cliente NÃO falou depois do marco do caso.
  const falouDepois = (marco: string | null | undefined): boolean => {
    const desde = instante(marco);
    return desde !== null && falouEm !== null && falouEm > desde;
  };
  if (AGUARDANDO_CLIENTE.has(caso.status)) {
    return falouDepois(caso.atualizadoEm) ? null : "caso_aguardando_cliente";
  }
  if (!ENCERRADOS.has(caso.status)) return null;
  return falouDepois(caso.encerradoEm) ? null : "caso_encerrado";
}
