/**
 * Quando uma capacidade SAI do Conversador (spec 16, passo 6).
 *
 * ═══ A CURA, E POR QUE ELA VEM POR ÚLTIMO ═══
 *
 * O gate de vazamento (passo 1) é rede: ele barra o vocabulário interno na saída
 * e devolve ao modelo um erro de ensino. A CURA é o Conversador nunca ter visto
 * esse vocabulário — e isso só acontece tirando as ferramentas de escrita dele,
 * porque foi pelo NOME delas que o vazamento voltou depois de a descrição ser
 * limpa (`crm_list_webhook_sources`, medido). Nome de ferramenta é contrato de
 * wire e não se renomeia; só se fecha não mostrando.
 *
 * O sinal de sucesso do passo 6 é o vazamento medido em 30% ir a zero **por
 * ausência, não por filtro**.
 *
 * ═══ A REGRA QUE IMPEDE O BURACO ═══
 *
 * Uma capacidade só muda de dono **quando o novo dono existe**. Concretamente:
 * a ferramenta nativa sai do Conversador apenas se o Operador estiver ligado
 * E tiver, marcado na tela, um equivalente que faça a mesma coisa.
 *
 * Sem essa condição, ligar o Operador e esquecer de marcar `crm_move_lead_stage`
 * faria o funil parar de andar — em silêncio, que é o modo de falha que este
 * épico inteiro existe para combater. Tirar a capacidade de um lado sem
 * garantir o outro não é separar papéis: é perder a capacidade.
 *
 * ═══ O QUE NÃO SAI, E POR QUÊ (medido) ═══
 *
 * `save_lead_note`, `open_human_case` e `provide_case_update` **não têm
 * equivalente no catálogo MCP** — verificado contra `TOOL_CATALOG`. Tirá-las
 * deixaria a capacidade órfã, então elas ficam com o Conversador até que alguém
 * as exponha no catálogo. A dívida está declarada, não escondida.
 *
 * `request_human_handoff` fica de propósito, e não por falta de equivalente: ela
 * existe no catálogo, mas está em `BLOCKED_TOOL_IDS` porque a variante do
 * catálogo NÃO silencia o harness. Além disso, passar a conversa para uma pessoa
 * é decisão sobre a CONVERSA, com efeito imediato — adiá-la para o turno
 * seguinte deixaria o assistente respondendo depois de o lead pedir um humano,
 * num caminho que a Meta fiscaliza.
 */
import { catalogEntry } from '@/lib/mcp/tools/catalogo';
import { PREFIXO_TOOL_ID_MCP_EXTERNO, lerToolIdRemoto } from '@/lib/mcp/servidor-externo/ids';

/**
 * Ferramenta nativa do Conversador → as do catálogo que fazem a mesma coisa.
 *
 * Só entra aqui o que TEM equivalente. A ausência de uma entrada é a afirmação
 * de que aquela capacidade não pode mudar de dono ainda — e é por isso que a
 * tabela é o lugar certo para essa decisão morar: acrescentar uma linha é a
 * mesma ação de decidir que o Operador passou a cobri-la.
 */
export const EQUIVALENTE_NO_OPERADOR: Readonly<Record<string, readonly string[]>> = {
  update_lead_state: ['crm_move_lead_stage', 'crm_update_lead'],
  schedule_followup: ['crm_schedule_followup'],
};

/**
 * Ferramentas do CATÁLOGO que servem para cuidar da operação, não para conversar
 * com um cliente.
 *
 * ═══ POR QUE ESTA LISTA EXISTE, com número ═══
 *
 * Medido em 2026-08-06 (RELATORIO-passo6.md), ferramentas EXECUTADAS contra
 * dados reais, controle calibrado em 30,0%:
 *
 *   com todas as capacidades ......... 3/10 = 30,0%
 *   sem estas sete ................... 1/10 = 10,0%
 *
 * Os dois vazamentos que sumiram vinham do DADO que elas devolvem —
 * `unsafe_url:https_required` e `admin`/`manager` + UUIDs. Não do nome nem da
 * descrição: do resultado. É a porta 3, a que "não mostrar a ferramenta" só
 * fecha tirando a ferramenta.
 *
 * ═══ O QUE NÃO ENTRA, E POR QUÊ ═══
 *
 * `crm_list_pipelines`, `crm_list_stages` e `crm_list_tags` FICAM com o
 * Conversador: saber em que etapa o lead está é contexto de CONVERSA. Tirá-las
 * deixaria o agente respondendo sem saber onde a pessoa está no funil — trocaria
 * um vazamento por um atendimento pior, que é um mau negócio.
 */
export const CAPACIDADES_DE_OPERACAO: readonly string[] = [
  'crm_list_webhook_sources',
  'crm_list_webhook_source_events',
  'crm_list_automation_rules',
  'crm_list_automation_runs',
  'crm_set_automation_rule_active',
  'crm_list_team_members',
  'crm_list_message_templates',
];

/**
 * As ferramentas de CATÁLOGO que saem do Conversador neste turno.
 *
 * Aqui não há mapa de equivalência: é a MESMA ferramenta mudando de dono. A
 * condição continua sendo a mesma do resto do módulo — só sai se o Operador
 * estiver ligado e a tiver marcada, para que a capacidade nunca fique órfã.
 */
export function catalogoEntregueAoOperador(input: {
  operadorLigado: boolean;
  ferramentasDoOperador: readonly string[];
  ferramentasDoConversador: readonly string[];
}): string[] {
  if (!input.operadorLigado) return [];
  const doOperador = new Set(input.ferramentasDoOperador);
  return input.ferramentasDoConversador.filter(
    (t) => CAPACIDADES_DE_OPERACAO.includes(t) && doOperador.has(t),
  );
}

/**
 * As ferramentas nativas que o Conversador PERDE neste turno.
 *
 * Devolve vazio quando o papel está desligado — o comportamento de hoje, e o que
 * mantém intacto todo self-hoster que não ligou nada (`operator_enabled` nasce
 * `false`).
 */
export function capacidadesEntreguesAoOperador(input: {
  operadorLigado: boolean;
  ferramentasDoOperador: readonly string[];
}): string[] {
  if (!input.operadorLigado) return [];
  const doOperador = new Set(input.ferramentasDoOperador);
  return Object.entries(EQUIVALENTE_NO_OPERADOR)
    .filter(([, equivalentes]) => equivalentes.some((e) => doOperador.has(e)))
    .map(([nativa]) => nativa);
}

/**
 * Ferramentas que o Operador NUNCA recebe, marcadas ou não.
 *
 * ═══ POR QUE A PROPOSTA ESTÁ AQUI, medido em operação em 2026-09-27 ═══
 *
 * O rascunho de proposta nascia na primeira mensagem do cliente ("oi, preciso
 * de um site"), antes de qualquer briefing. Quem chamava não era o
 * Conversador — o log do worker mostrou o Operador chamando
 * `crm_draft_proposal` em TODOS os quatro turnos da conversa. Ele não tem como
 * acertar o momento: não lê o prompt do agente (onde mora o roteiro "colete o
 * briefing antes"), não lê a conversa (só o resumo de intenções do turno), e o
 * system dele manda "abrir o que precisa ser aberto". "O cliente quer um site"
 * vira rascunho vazio — e, como o negócio só aceita UM rascunho aberto, o
 * rascunho vazio trava o bom que viria depois.
 *
 * Decidir QUANDO a conversa já sustenta uma proposta é do papel que conversa.
 * A chave `proposal_ai_draft_enabled` acrescentava a ferramenta aos dois papéis;
 * a partir daqui ela vale só para o Conversador.
 *
 * `crm_preparar_proposta` vai junto na mesma lista: é a primeira metade da
 * mesma decisão (levantar o que perguntar), e o Operador não tem a conversa
 * para perguntar nada.
 */
export const FORA_DO_OPERADOR: readonly string[] = ['crm_draft_proposal', 'crm_preparar_proposta'];

/**
 * Retorno agendado: o catálogo os marca `atencao` ("agendar não fala com ninguém
 * agora"), mas cada um é a decisão de falar com o cliente DEPOIS — e o fluxo
 * configurado tem envios próprios de texto fixo (`lib/followup/engine.ts`).
 * Não há marca no catálogo para "agenda uma saída", por isso a lista explícita.
 */
const RETORNO_QUE_FALA_COM_O_CLIENTE: readonly string[] = [
  'crm_schedule_followup',
  'crm_enroll_followup_flow',
];

/**
 * A ferramenta faz algo SAIR sem aprovação humana? Lê as marcas que já existem:
 * remota é escrita salvo marca `leitura` no id (`lib/mcp/servidor-externo/ids.ts`);
 * do catálogo, `risco: 'critico'` ("sai do sistema ou não volta atrás — como
 * falar com o cliente de verdade", `pacotes.ts`) e o retorno agendado acima.
 * Id que não se reconhece conta como saída: falha fechado.
 */
export function saiSemAprovacao(id: string): boolean {
  if (id.startsWith(PREFIXO_TOOL_ID_MCP_EXTERNO)) return lerToolIdRemoto(id)?.leitura !== true;
  const entrada = catalogEntry(id);
  return (
    entrada === undefined ||
    entrada.risco === 'critico' ||
    RETORNO_QUE_FALA_COM_O_CLIENTE.includes(id)
  );
}

/**
 * A configuração com que a MÃO do Operador é montada: a lista dele
 * (`operator_tool_ids`) no lugar da do Conversador, sem o que é
 * `FORA_DO_OPERADOR`, e sem o acréscimo automático da proposta.
 *
 * `proposalAiDraftEnabled: false` não é redundante com o filtro: a chave manda
 * nos dois sentidos em `pickToolsFromMcp` — com ela ligada, a ferramenta é
 * ACRESCENTADA mesmo fora da lista. O filtro sozinho não bastaria.
 *
 * MODO ASSISTIDO: nada sai para o cliente sem aprovação, nem pelo Operador. A
 * lista dele é configurável, então a regra mora aqui, e não no prompt nem na
 * tela: sem `saiSemAprovacao`, independente do que foi marcado.
 */
export function maoDoOperador<
  T extends { operatorToolIds: readonly string[]; operationMode?: 'automatic' | 'assisted' },
>(cfg: T): T & { toolIds: string[]; proposalAiDraftEnabled: false } {
  const assistido = cfg.operationMode === 'assisted';
  return {
    ...cfg,
    toolIds: cfg.operatorToolIds.filter(
      (t) => !FORA_DO_OPERADOR.includes(t) && !(assistido && saiSemAprovacao(t)),
    ),
    proposalAiDraftEnabled: false,
  };
}
