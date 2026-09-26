/**
 * Capacidades de ORGANIZAR A OPERAÇÃO — a casa onde o atendimento acontece:
 * etapas do funil, marcadores, respostas prontas, entradas automáticas de
 * contatos, regras automáticas e time.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente — `rotulo`,
 * `explicacao` e `oQueToca`. O texto que vai ao MODELO é a `description` do
 * HANDLER (`lib/mcp/tools/<dominio>.ts`), e ela NÃO tem cópia aqui: até
 * 2026-08-07 tinha, ninguém lia essa cópia, e 48 das 51 divergiam do que o
 * modelo realmente recebia. O campo foi removido em vez de sincronizado —
 * duplicata que ninguém lê não é documentação, é armadilha: um script de
 * medição de vazamento chegou a montar o prompt com o texto errado, sob um
 * comentário dizendo "a ferramenta como o modelo a vê".
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 *
 * ⚠️ SOBRE O RISCO `critico` DESTE ARQUIVO. O gate mecânico
 * (`tests/unit/catalogo-tools-leigo-friendly.test.ts`) só sabe conferir que uma
 * tool de leitura não se anuncia perigosa e que uma de escrita não se anuncia
 * inofensiva — ele **não** distingue `atencao` de `critico`. A régua usada aqui é
 * uma pergunta só: **o efeito acontece quando ninguém está olhando?**
 *   - Renomear ou reordenar etapa muda o que o usuário vê na hora e ele desfaz
 *     na tela → `atencao`.
 *   - Ligar/desligar regra automática e ligar/desligar entrada automática mudam
 *     o COMPORTAMENTO DO SISTEMA para todos os eventos futuros, sem ninguém
 *     assistindo, e o efeito sai da empresa (mensagem ao cliente, dado para
 *     fora) → `critico`.
 *   - Arquivar etapa mexe em onde os negócios estão parados → `critico`.
 * Errar para baixo aqui dá ao agente poder que o humano não sabe que concedeu,
 * porque `critico` é exatamente o que `entraPorPacote()` recusa ligar sozinho.
 *
 * ⚠️ AS SEIS ESCRITAS DESTE ARQUIVO SÃO `apenasHumano`, E ISSO É PARIDADE, NÃO
 * TIMIDEZ. A régua do épico para o papel de uma capacidade é o que a ROTA HTTP
 * equivalente exige (ver `tests/unit/capacidade-alcancavel-pelo-agente.test.ts`).
 * As três rotas que estas tools espelham — `pipelines/[id]/stages`,
 * `webhook-sources` e `automation-rules` — exigem `manager`, todas: **nem um
 * atendente humano configura a operação pela tela**. Onde a rota pede `agent` e
 * a tool pedia `manager` havia divergência e ela foi corrigida (`bddeeb6`); aqui
 * não há divergência nenhuma, e baixar para `agent` daria à IA um poder que o
 * produto não dá a uma pessoa com o mesmo papel.
 *
 * A consequência é honesta e tem que ser dita na tela, que é para isso que o
 * campo serve: no pacote "Organizar a operação", o agente **lê tudo e muda
 * nada**. As dez leituras são o que ele de fato ganhou — explicar a operação,
 * diagnosticar a entrada que parou de receber, mostrar a automação que falhou,
 * parar de inventar marcador. As escritas ficam com quem já as tinha.
 *
 * ⚠️ SEM JARGÃO, e a lista proibida do gate inclui "webhook", "pipeline",
 * "stage", "tag" e "lead". Os nomes escolhidos: **funil**, **etapa**,
 * **marcador**, **oportunidade** e **entrada automática de contatos** — este
 * último em lugar de "aviso automático" porque a peça não avisa ninguém, ela
 * RECEBE gente de fora, e um rótulo que descreve errado confunde mais que um
 * termo técnico.
 */
import { declararTools } from "./tipos";

export const TOOLS_OPERACAO = declararTools([
  // ---- funil e etapas ----
  {
    name: "crm_list_stages",
    category: "read",
    rotulo: "Ver as etapas de um funil",
    explicacao:
      "Mostra as colunas de um funil na ordem em que aparecem no quadro, para o agente saber onde pode colocar cada negócio.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["organizar", "vender"],
  },
  {
    name: "crm_create_stage",
    category: "write",
    rotulo: "Criar etapa no funil",
    explicacao:
      "Acrescenta uma coluna nova no fim do funil, quando o jeito de trabalhar da empresa tem um passo que ainda não está no quadro.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
  {
    name: "crm_update_stage",
    category: "write",
    rotulo: "Renomear ou reordenar uma etapa",
    explicacao:
      "Troca o nome de uma coluna do funil, muda o lugar dela na ordem ou define em qual delas o negócio é dado como fechado ou perdido.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
  {
    name: "crm_archive_stage",
    category: "write",
    rotulo: "Arquivar uma etapa do funil",
    explicacao:
      "Tira uma coluna do quadro e leva os negócios que estavam nela para outra coluna que você escolher. O histórico continua guardado.",
    oQueToca: "Funil de vendas",
    risco: "critico",
    pacotes: ["organizar"],
    apenasHumano: true,
  },

  // ---- marcadores ----
  {
    name: "crm_list_tags",
    category: "read",
    rotulo: "Ver os marcadores em uso",
    explicacao:
      "Mostra quais marcadores a empresa já usa e em quantas conversas, para o agente reaproveitar em vez de inventar outro parecido.",
    oQueToca: "Organização da operação",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },

  // ---- respostas prontas ----
  {
    name: "crm_list_message_templates",
    category: "read",
    rotulo: "Ver as respostas prontas",
    explicacao:
      "Lista os textos que a empresa compartilhou com a equipe para responder as situações de sempre, com o atalho de cada um e as variáveis que cada texto usa.",
    oQueToca: "Respostas prontas",
    risco: "seguro",
    pacotes: ["atender", "organizar"],
  },
  {
    name: "crm_render_message_template",
    category: "read",
    rotulo: "Preencher uma resposta pronta",
    explicacao:
      "Pega uma resposta pronta e troca as lacunas pelos dados do cliente e pelos valores que o sistema de fora informar, avisando se sobrou alguma sem preencher. Não envia nada.",
    oQueToca: "Respostas prontas",
    risco: "seguro",
    pacotes: ["atender", "organizar"],
  },

  // ---- entradas automáticas de contatos ----
  {
    name: "crm_list_webhook_sources",
    category: "read",
    rotulo: "Ver as entradas automáticas de contatos",
    explicacao:
      "Mostra por onde chegam sozinhos os contatos vindos do site ou de outro sistema, se cada uma está ligada e quando recebeu pela última vez.",
    oQueToca: "Entrada automática de contatos",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "crm_list_webhook_source_events",
    category: "read",
    rotulo: "Ver o que chegou por uma entrada",
    explicacao:
      "Mostra os últimos contatos que entraram por uma origem e quais informações vieram, para descobrir por que algo não chegou como devia.",
    oQueToca: "Entrada automática de contatos",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "crm_create_webhook_source",
    category: "write",
    rotulo: "Criar uma entrada automática de contatos",
    explicacao:
      "Abre um endereço novo para o site da empresa mandar contatos direto para um funil. A partir daí ele passa a receber gente de fora sozinho.",
    oQueToca: "Entrada automática de contatos",
    risco: "critico",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
  {
    name: "crm_set_webhook_source_active",
    category: "write",
    rotulo: "Ligar ou desligar uma entrada de contatos",
    explicacao:
      "Faz uma origem voltar a receber contatos, ou parar. Desligada, o formulário do seu site continua no ar e ninguém do outro lado é avisado.",
    oQueToca: "Entrada automática de contatos",
    risco: "critico",
    pacotes: ["organizar"],
    apenasHumano: true,
  },

  // ---- regras automáticas ----
  {
    name: "crm_list_automation_rules",
    category: "read",
    rotulo: "Ver as regras automáticas",
    explicacao:
      "Mostra o que a empresa deixou configurado para acontecer sozinho, o que dispara cada regra e se ela está ligada.",
    oQueToca: "Regras automáticas",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "crm_list_automation_runs",
    category: "read",
    rotulo: "Ver o que as regras dispararam",
    explicacao:
      "Mostra o que rodou sozinho nos últimos tempos e o que deu errado, para descobrir o que parou de funcionar sem ninguém perceber.",
    oQueToca: "Regras automáticas",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "crm_set_automation_rule_active",
    category: "write",
    rotulo: "Ligar ou desligar uma regra automática",
    explicacao:
      "Faz uma regra passar a rodar sozinha, sempre que o gatilho dela acontecer, ou parar de rodar. Ligada, ela pode falar com clientes de verdade.",
    oQueToca: "Regras automáticas",
    risco: "critico",
    pacotes: ["organizar"],
    apenasHumano: true,
  },

  // ---- time ----
  {
    name: "crm_list_team_members",
    category: "read",
    rotulo: "Ver quem trabalha na empresa",
    explicacao:
      "Lista as pessoas do time e o que cada uma pode fazer aqui dentro, para o agente saber para quem passar um atendimento.",
    oQueToca: "Time de atendimento",
    risco: "seguro",
    pacotes: ["organizar", "escalar"],
  },
]);
