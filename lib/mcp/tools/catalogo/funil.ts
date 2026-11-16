/**
 * Capacidades de FUNIL — oportunidades de venda e as etapas por onde passam.
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
 */
import { declararTools } from "./tipos";

export const TOOLS_FUNIL = declararTools([
  {
    name: "crm_list_leads",
    category: "read",
    rotulo: "Listar oportunidades do funil",
    explicacao:
      "Lista as oportunidades de venda de um funil, com a etapa em que cada uma está e quem é o responsável por ela.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_get_lead",
    category: "read",
    rotulo: "Ver uma oportunidade",
    explicacao:
      "Abre os detalhes de uma oportunidade de venda: etapa atual, responsável, marcadores e valor do negócio.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_list_lead_attachments",
    category: "read",
    rotulo: "Listar os documentos do negócio",
    explicacao:
      "Mostra os arquivos que a equipe anexou numa oportunidade — nome, tamanho e data —, para a IA saber o que já está guardado ali antes de pedir o documento de novo ao cliente.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    // `reter`, e NÃO `vender` (#4544). Duas capacidades novas no pacote default
    // do onboarding empurravam o `evoluir` — o segundo pacote que cabe no teto —
    // de 27 para 29 e obrigavam a subir `TETO_TOOLS_POR_AGENTE`, número que o
    // #4534 também move. Aqui elas ficam ao lado de
    // `crm_propose_lead_fields_from_document`, que é o consumidor do id que esta
    // ferramenta devolve: a leitura do documento e a proposta de campos para o
    // card são a MESMA jornada. Medido: com elas em `reter`, o onboarding segue
    // em 22 e o `evoluir` volta a exigir 27.
    pacotes: ["reter"],
  },
  {
    name: "crm_get_lead_attachment",
    category: "read",
    rotulo: "Ler o conteúdo de um documento do negócio",
    explicacao:
      "Lê o texto de um arquivo anexado à oportunidade (por exemplo a apólice do seguro ou o voucher da viagem), para a IA encontrar ali dados como número da apólice, localizador e hotel sem pedir tudo de novo ao cliente. Imagem não é lida.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    // Mesma jornada do `crm_list_lead_attachments` (ver o comentário acima): a
    // dupla mora em `reter`, com o `crm_propose_lead_fields_from_document`.
    pacotes: ["reter"],
  },
  {
    name: "crm_list_pipelines",
    category: "read",
    rotulo: "Listar funis",
    explicacao:
      "Mostra os funis de venda existentes e suas etapas, para o agente saber onde pode colocar uma oportunidade.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender", "organizar"],
  },
  {
    name: "crm_get_pipeline_forecast",
    category: "read",
    rotulo: "Ver a previsão do funil",
    explicacao:
      "Mostra quanto deve entrar e quando: os negócios abertos por moeda e por mês, com a chance de fechamento que cada etapa tem — e com o valor único (setup) e a recorrência nova (mensalidade) em parcelas SEPARADAS, nunca somadas. À parte, o que ainda não tem data nem chance definida.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    // Leitura GERENCIAL (quanto entra e quando), não passo de venda: o agente
    // que atende não precisa dela para mover o cliente, e no pacote padrão do
    // onboarding ela ocupava a vaga que deixa uma segunda jornada caber no teto
    // (tests/unit/pacote-reserva-vaga-da-critica.test.ts).
    pacotes: ["organizar"],
  },
  {
    name: "crm_create_lead",
    category: "write",
    rotulo: "Criar oportunidade no funil",
    explicacao:
      "Registra uma nova oportunidade de venda no funil, para que o interesse demonstrado pelo cliente não se perca.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_update_lead",
    category: "write",
    rotulo: "Atualizar uma oportunidade",
    explicacao:
      "Altera dados de uma oportunidade de venda: valor do negócio, responsável e informações colhidas na conversa.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_move_lead_stage",
    category: "write",
    rotulo: "Mover oportunidade de etapa",
    explicacao:
      "Move a oportunidade para outra etapa do funil, registrando o avanço da negociação ou a perda do negócio.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_retomar_lead",
    category: "write",
    rotulo: "Retomar negócio encerrado como novo",
    explicacao:
      "Abre uma nova tentativa para um negócio perdido ou ganho, no mesmo funil e com o mesmo contato, sem alterar o negócio original.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    // "reter", como `crm_propose_reactivation`: é o cliente que voltou depois
    // de uma perda. Em "vender" ela entraria no agente que nasce no onboarding
    // e estouraria o teto dos outros pacotes (pacote-reserva-vaga-da-critica).
    pacotes: ["reter"],
  },
  {
    name: "crm_propose_lead_fields_from_document",
    category: "write",
    rotulo: "Propor dados de um documento para o card",
    explicacao:
      "Separa, de um documento que o agente leu (voucher, bilhete, apólice), os valores dos campos do card do negócio como PROPOSTAS — nada é gravado sem que uma pessoa confirme campo a campo, com o trecho do documento à vista.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    // Pós-venda (o funil "Experiência do Cliente" da issue): quem atende depois
    // da compra é o agente de retenção, não o de aquisição — em "vender" ela
    // entraria no agente que nasce no onboarding (pacote-reserva-vaga-da-critica).
    pacotes: ["reter"],
  },
]);
