/**
 * As regras de automação e o histórico que o seed de demonstração grava.
 *
 * ⚠️ VIVE FORA DO SEEDER PELO MESMO MOTIVO DO GRAFO (`grafo-de-demonstracao.ts`):
 * o seeder roda `main()` ao ser importado, e aqui é só dado. É o que deixa
 * `tests/unit/automacoes-de-demonstracao-sao-coerentes.test.ts` passar cada regra
 * pelo `createAutomationRuleSchema` e cada condição pelo `evaluateConditions` de
 * verdade — `automation_rules.conditions` é `jsonb`, e o banco aceita uma
 * condição que o motor nunca casa.
 *
 * Foi o defeito da primeira versão: `field: "direction"` numa regra de
 * `message.received`. O motor avalia contra `{ event: payload, contact?, lead? }`
 * (`buildContext` em `lib/automation/engine.ts`), então o caminho certo seria
 * `event.direction` — e mesmo corrigido não serviria: o gatilho só é emitido para
 * mensagem de entrada (`fn_emit_message_event`), a condição seria sempre verdade,
 * e a ação `assign_owner` exige um LEAD no contexto, que evento de mensagem não
 * hidrata. A regra passaria a disparar em toda mensagem e falhar em todas.
 */

export interface CondicaoDeDemonstracao {
  field: string;
  op: "eq" | "neq" | "contains";
  value: string;
}

export interface AcaoDeDemonstracao {
  type: string;
  config: Record<string, unknown>;
}

export interface RegraDeDemonstracao {
  name: string;
  trigger_event: string;
  conditions: CondicaoDeDemonstracao[];
  actions: AcaoDeDemonstracao[];
}

export const REGRA_VIP = "Lead VIP ganha prioridade e cai com o gerente";
export const REGRA_ORCAMENTO = "Quem pede orçamento ganha etiqueta";
export const REGRA_ANIVERSARIO = "Aniversariante volta para o começo do funil";

/**
 * As regras usam só vocabulário REAL: `trigger_event` de
 * `ENTIDADE_ESPERADA_POR_GATILHO`, `actions` do `actionSchema`, e campos de
 * condição da lista curada do `RuleEditor` para o gatilho — assim a aba Regras
 * mostra o filtro no seletor, e não como campo avançado.
 */
export function regrasDeDemonstracao(alvo: {
  pipelineId: string | null;
  stageId: string | null;
  managerId: string;
}): RegraDeDemonstracao[] {
  const regras: RegraDeDemonstracao[] = [
    {
      // `lead.created` hidrata o lead no contexto, que é o que `assign_owner`
      // exige. A condição evita que a regra reatribua TODO lead novo da
      // organização de teste — só o que já nasce com a etiqueta.
      name: REGRA_VIP,
      trigger_event: "lead.created",
      conditions: [{ field: "lead.tags", op: "contains", value: "vip" }],
      actions: [
        { type: "add_tag", config: { tags: ["prioridade"] } },
        { type: "assign_owner", config: { user_id: alvo.managerId } },
      ],
    },
    {
      // Em mensagem o contexto tem o CONTATO (nunca o lead), e `add_tag` cai no
      // contato quando não há lead. Condição de verdade, com o campo curado do
      // gatilho: a aba Regras precisa mostrar como um filtro se parece.
      name: REGRA_ORCAMENTO,
      trigger_event: "message.received",
      conditions: [{ field: "event.body_preview", op: "contains", value: "orçamento" }],
      actions: [{ type: "add_tag", config: { tags: ["pediu-orçamento"] } }],
    },
  ];

  // Só entra se o pipeline do CRM Vivo existir: uma ação apontando para um
  // estágio inexistente é uma regra que falha em toda execução, e uma demo que
  // nasce quebrada é pior que uma demo incompleta.
  if (alvo.pipelineId && alvo.stageId) {
    regras.push({
      name: REGRA_ANIVERSARIO,
      trigger_event: "contact.birthday",
      conditions: [],
      actions: [
        { type: "create_or_move_lead", config: { pipeline_id: alvo.pipelineId, stage_id: alvo.stageId } },
      ],
    });
  }
  return regras;
}

export interface ResultadoDeAcao {
  type: string;
  status: "success" | "failed" | "skipped";
  detail?: Record<string, unknown>;
  error?: string;
}

/**
 * O que o motor ENCONTROU quando aquela execução rodou. Não vai para o banco: é
 * a história que justifica a linha, e é contra ela que o teste roda o motor.
 */
export interface MundoDaExecucao {
  /** `lead.created`: as etiquetas do lead quando o motor montou o contexto. */
  lead?: { tags: string[] };
  /** `message.received`: o texto da mensagem, que o gatilho grava em `body_preview`. */
  mensagem?: string;
  /** O gerente da ação `assign_owner` ainda era membro ativo da organização. */
  gerenteNaOrganizacao: boolean;
  /** O que a ESCRITA no banco devolveu, quando não foi aceita. */
  escritaFalhou?: string;
}

export interface ExecucaoDeDemonstracao {
  regra: string;
  status: "success" | "partial" | "failed";
  actions_result: ResultadoDeAcao[];
  horasAtras: number;
  mundo: MundoDaExecucao;
}

/**
 * Os TRÊS desfechos da aba Atividade, cada um POSSÍVEL: a condição da regra casa
 * com o mundo daquela execução, e o `actions_result` é o que as ações de verdade
 * devolvem nesse mundo (`lib/automation/actions/add-tag.ts`, `assign-owner.ts`).
 * A coluna `error` da execução fica vazia porque o motor nunca a preenche.
 *
 *   success — regra VIP: etiqueta entrou, lead foi para o gerente;
 *   partial — regra VIP: etiqueta entrou, mas o gerente escolhido saiu da
 *             organização (`user_not_in_org`);
 *   failed  — regra de orçamento: a mensagem pedia orçamento e o contexto tinha
 *             o contato, mas a escrita da etiqueta caiu no transporte — a
 *             mensagem é a que o cliente do Supabase devolve quando o `fetch`
 *             falha.
 *
 * ⚠️ O `failed` NÃO pode ser da regra VIP. A versão anterior o punha lá com as
 * duas ações puladas "porque o lead foi apagado" — mas sem lead a condição
 * `lead.tags contém vip` é falsa (`lib/automation/conditions.ts`) e o motor
 * filtra a regra ANTES de executar (`runAutomationForEvent`): essa linha nunca
 * existiria. Com o lead VIP presente, `add_tag` só deixa de ser feito se a
 * escrita falhar; aí o `assign_owner`, que consulta e escreve no mesmo banco, ou
 * dá certo (`partial`) ou cai na mesma queda — e nesse caso relata
 * `user_not_in_org`, porque trata a consulta de membro que FALHOU como membro
 * ausente. Uma demonstração não deve ensinar esse motivo errado. Regra de uma
 * ação só não tem o problema.
 */
export function historicoDeDemonstracao(managerId: string): ExecucaoDeDemonstracao[] {
  return [
    {
      regra: REGRA_VIP,
      status: "success",
      actions_result: [
        { type: "add_tag", status: "success", detail: { added: ["prioridade"] } },
        { type: "assign_owner", status: "success", detail: { user_id: managerId } },
      ],
      horasAtras: 2,
      mundo: { lead: { tags: ["vip"] }, gerenteNaOrganizacao: true },
    },
    {
      regra: REGRA_VIP,
      status: "partial",
      actions_result: [
        { type: "add_tag", status: "success", detail: { added: ["prioridade"] } },
        { type: "assign_owner", status: "failed", error: "user_not_in_org" },
      ],
      horasAtras: 6,
      mundo: { lead: { tags: ["vip"] }, gerenteNaOrganizacao: false },
    },
    {
      regra: REGRA_ORCAMENTO,
      status: "failed",
      actions_result: [{ type: "add_tag", status: "failed", error: "TypeError: fetch failed" }],
      horasAtras: 24,
      mundo: {
        mensagem: "Boa tarde! Queria um orçamento para um evento de 20 pessoas",
        gerenteNaOrganizacao: true,
        escritaFalhou: "TypeError: fetch failed",
      },
    },
  ];
}
