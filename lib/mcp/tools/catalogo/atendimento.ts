/**
 * Capacidades de ATENDIMENTO — cliente, conversa, mensagem.
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

export const TOOLS_ATENDIMENTO = declararTools([
  {
    name: "crm_search_contacts",
    category: "read",
    rotulo: "Procurar cliente",
    explicacao:
      "Encontra um cliente pelo nome, telefone ou e-mail, para o agente saber com quem está falando antes de responder.",
    oQueToca: "Cadastro de clientes",
    risco: "seguro",
    pacotes: ["atender", "vender"],
  },
  {
    name: "crm_get_contact",
    category: "read",
    rotulo: "Ver ficha do cliente",
    explicacao:
      "Abre a ficha completa de um cliente: dados de contato, histórico e por onde ele chegou até a empresa.",
    oQueToca: "Cadastro de clientes",
    risco: "seguro",
    pacotes: ["atender", "vender"],
  },
  {
    name: "crm_propose_contact_field",
    category: "write",
    // SEM `description` aqui, e não por esquecimento: o catálogo perdeu esse
    // campo no `02d9acea` (eram 51 cópias que ninguém lia). Quem serve a
    // descrição ao cliente MCP é `catalogo-servido.ts:58`, e ele lê
    // `handler.description` — a de `lib/mcp/tools/contacts.ts:135`, que existe e
    // continua valendo. O catálogo responde outra pergunta: o que o HUMANO lê na
    // tela (`rotulo`, `explicacao`, `oQueToca`).
    //
    // Esta linha é o encontro de dois trabalhos que não se viram: a remoção do
    // campo veio pela branch do Índice de Atrito e a ferramenta veio pelo #194.
    // Nenhum dos dois gerou conflito de texto — o `tsc` é que reprovou no merge.
    rotulo: "Anotar dado que o cliente informou",
    explicacao:
      "Quando o cliente diz o e-mail, o nome ou o telefone dele na conversa, guarda essa informação para uma pessoa conferir antes de entrar na ficha.",
    oQueToca: "Cadastro de clientes",
    // `atencao`, não `critico`: nada sai para o cliente e nada entra na ficha
    // por conta dela — o peso mora na confirmação, que é humana. Marcar
    // `critico` aqui faria a tela pedir cerimônia para uma anotação.
    risco: "atencao",
    // ⚠️ FORA de "atender", e a razão é o TETO — não o valor da capacidade.
    //
    // O pacote "Atender" fica perto do teto de 20 (a conta exata está em
    // `vagasExigidasPeloPacote`, `lib/mcp/tools/selecao-por-pacote.ts` — não
    // hardcode o número aqui, ele muda toda vez que uma capacidade entra ou
    // sai do catálogo). Acrescentar esta capacidade ali reduziria ainda mais
    // a folga sem necessidade.
    //
    // Fica em "vender", que tem folga, e continua alcançável em qualquer jornada
    // pelo modo avançado. Quando o teto ou o tamanho do pacote for revisto, esta
    // linha é candidata natural a voltar.
    pacotes: ["vender"],
  },
  {
    name: "crm_list_conversations",
    category: "read",
    rotulo: "Listar conversas",
    explicacao:
      "Mostra as conversas em andamento, quem está cuidando de cada uma e a posição de cada cliente na fila de espera.",
    oQueToca: "Atendimento",
    risco: "seguro",
    pacotes: ["atender", "escalar"],
  },
  {
    name: "crm_get_conversation",
    category: "read",
    rotulo: "Ver uma conversa",
    explicacao:
      "Abre os detalhes de uma conversa: quem está atendendo, marcadores aplicados e há quanto tempo o cliente espera.",
    oQueToca: "Atendimento",
    risco: "seguro",
    pacotes: ["atender", "escalar"],
  },
  {
    name: "crm_get_conversation_history",
    category: "read",
    rotulo: "Ler o histórico da conversa",
    explicacao:
      "Lê as mensagens já trocadas com o cliente, para o agente responder sem pedir que ele repita o que já contou.",
    oQueToca: "Atendimento",
    risco: "seguro",
    pacotes: ["atender"],
  },
  {
    name: "crm_send_whatsapp_message",
    category: "write",
    rotulo: "Enviar mensagem no WhatsApp",
    explicacao:
      "Envia uma mensagem de WhatsApp para o cliente. Ele recebe de verdade, no celular dele, e não dá para desfazer.",
    oQueToca: "Atendimento",
    risco: "critico",
    pacotes: ["atender"],
  },
]);
