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
  // ── `risco` DESTAS DUAS REAVALIADO (#2158) ────────────────────────────────
  //
  // Medido contra a convenção que JÁ EXISTE, em `RISCOS`
  // (`lib/mcp/tools/pacotes.ts`) — nenhum rótulo novo inventado:
  //
  //   "seguro"   = "Só consulta. O agente apenas lê a informação. Nada muda
  //                no sistema."
  //   "atencao"  = "Altera dados. O agente muda alguma coisa no sistema…"
  //   "critico"  = "Efeito que não dá para desfazer…" — e ainda por cima sai
  //                do pacote (`entraPorPacote`), exigindo marcação humana.
  //
  // As duas são leituras puras: mudá-las para "atencao" seria mentira no outro
  // sentido ("altera dados" — não altera), e "critico" as tiraria do pacote
  // Atender, que existe justamente para o agente saber com quem está falando.
  // O que a issue apontava — o rótulo prometia mais do que o runtime entregava
  // — passou a ser verdade DO LADO DO RUNTIME: em conversa, o escopo do contato
  // do turno alcança a leitura também (#2158, `lib/mcp/tools/contacts.ts`).
  //
  // Fica registrado o limite da convenção: `risco` é POR FERRAMENTA, não por
  // pacote, então não existe "seguro no vender / atencao no atender" para
  // declarar — e a taxa de exposição de dado pessoal (leitura que devolve
  // telefone/e-mail) não tem slot em `RISCOS`. Se um dia tiver, esta dupla é a
  // primeira candidata.
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
    // Ver o bloco acima: mesma leitura, mesma conclusão (#2158).
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
      "Guarda o dado informado para revisão humana. A empresa pode permitir, em Configurações › Distribuição " +
      "de atendimento, preencher telefone vazio ou nome vazio. Nome exige mensagem real do próprio contato " +
      "neste atendimento; nome preexistente diferente e e-mail continuam aguardando confirmação.",
    oQueToca: "Cadastro de clientes",
    // `atencao`, não `critico`: nada sai para o cliente, e os ÚNICOS dados que
    // entram na ficha por conta desta ferramenta são o telefone de um cadastro
    // SEM número (#2593) e o nome de um cadastro SEM nome (#3784) — sozinhos,
    // sem sobrescrever nada, com auditoria e rastro na linha do tempo, E SÓ COM
    // A OPÇÃO DA ORGANIZAÇÃO LIGADA (as duas vêm desligadas). O resto continua
    // esperando a confirmação humana, que é onde o peso mora. Marcar `critico`
    // aqui faria a tela pedir cerimônia para uma anotação.
    risco: "atencao",
    // ⚠️ FORA de "atender", e a razão é o TETO — não o valor da capacidade.
    //
    // O pacote "Atender" exige 18 vagas, quase o teto inteiro por agente.
    // Acrescentar esta capacidade ali empurraria para 19 um pacote que já é o
    // maior — e, somado ao que um agente costuma trazer ligado, é ele que
    // encosta no teto primeiro.
    //
    // ⚠️ A ARITMÉTICA DESTE PARÁGRAFO MUDOU e a decisão não. Ele dizia
    // "18 + 3 = 21 num teto de 20: ligá-lo já era impossível". O teto foi para
    // 25 quando o dono do produto ficou sem como ligar as capacidades de agenda,
    // então 21 hoje CABE — o argumento de impossibilidade venceu. O que sustenta
    // a escolha agora é folga, não bloqueio, e por isso a linha continua sendo
    // candidata a voltar numa revisão dos pacotes.
    //
    // Fica em "vender", que tem folga, e continua alcançável em qualquer jornada
    // pelo modo avançado. Quando o teto ou o tamanho do pacote for revisto, esta
    // linha é candidata natural a voltar.
    pacotes: ["vender"],
  },
  {
    name: "crm_update_contact",
    category: "write",
    // O RÓTULO É A PROMESSA, não a ferramenta: diz o que muda na ficha do
    // cliente e nada sobre MCP, token ou escopo — o gate de catálogo reprova
    // jargão e conta os 60 caracteres.
    rotulo: "Corrigir os dados do cliente",
    explicacao:
      "Atualiza o cadastro do cliente: nome, como prefere ser chamado, e-mail, telefone, nascimento, " +
      "tipo e endereço. Se a integração tiver a permissão de editar cadastro, a correção entra na " +
      "hora; sem ela, fica como proposta esperando alguém confirmar — e só nome, e-mail, telefone e " +
      "nascimento podem entrar assim.",
    oQueToca: "Cadastro de clientes",
    // `atencao`, e não `critico`: não sai mensagem para o cliente, a alteração
    // é auditada com o token que a fez e é reversível pela própria tela (o
    // histórico da ficha guarda o valor anterior). Grava por cima, sim — é o
    // motivo de o escopo ser separado e de a tela de tokens mostrar a linha.
    risco: "atencao",
    // "vender" pela mesma aritmética do `crm_propose_contact_field` logo acima:
    // "atender" é o pacote no teto, e corrigir cadastro não é trabalho de
    // atendimento em curso. Continua alcançável pelo modo avançado.
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
    name: "crm_pause_ai",
    category: "write",
    rotulo: "Pausar a IA nesta conversa",
    explicacao:
      "Desliga o atendimento automático de uma conversa: a IA deixa de responder o cliente até " +
      "alguém retomar. O responsável pela conversa e o dono do negócio não mudam — pausar não " +
      "transfere o atendimento para ninguém.",
    oQueToca: "Atendimento",
    // `atencao`: o efeito é visível para o cliente (ele deixa de ser respondido), mas
    // é reversível num clique e NÃO mexe em dono, negócio nem cadastro.
    risco: "atencao",
    pacotes: ["atender", "escalar"],
  },
  {
    name: "crm_resume_ai",
    category: "write",
    rotulo: "Deixar a IA responder de novo",
    explicacao:
      "Religa o atendimento automático de uma conversa pausada. Se uma pessoa é responsável pela " +
      "conversa, a IA continua sem responder e o retorno avisa — retomar aqui não tira a conversa " +
      "de quem está com ela.",
    oQueToca: "Atendimento",
    risco: "atencao",
    pacotes: ["atender", "escalar"],
  },
  {
    name: "crm_close_conversation",
    category: "write",
    rotulo: "Encerrar a conversa",
    explicacao:
      "Encerra o atendimento de uma conversa, igual ao botão da tela: registra o fim, libera a " +
      "fila e para de contar o tempo de espera. A conversa pode ser reaberta depois, e reabrir é " +
      "uma ferramenta separada.",
    oQueToca: "Atendimento",
    // `atencao`, não `critico`: encerrar é o gesto mais comum do dia e é reversível
    // pela própria ferramenta de reabrir. `critico` seria encerrar SEM poder voltar.
    risco: "atencao",
    pacotes: ["atender", "escalar"],
  },
  {
    name: "crm_reopen_conversation",
    category: "write",
    rotulo: "Reabrir conversa encerrada",
    explicacao:
      "Reabre uma conversa que tinha sido encerrada, igual ao botão da tela. O atendimento volta a " +
      "contar a partir de agora e a conversa volta para a fila de quem estava com ela.",
    oQueToca: "Atendimento",
    risco: "atencao",
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
  {
    name: "crm_start_conversation_and_send",
    category: "write",
    rotulo: "Iniciar conversa com cliente novo e enviar mensagem",
    explicacao:
      "Cria o cadastro do cliente se ele ainda não existir, abre uma conversa nova no número de " +
      "WhatsApp escolhido e manda a primeira mensagem para ele — de verdade, no celular dele.",
    oQueToca: "Atendimento",
    risco: "critico",
    // Nasce para automação externa (ex.: prospecção que acabou de captar um
    // cliente novo), não para o agente conversacional em turno — por isso
    // `apenasHumano` abaixo e o papel mínimo ficam acima do que o agente
    // publicado alcança (ver tests/unit/capacidade-alcancavel-pelo-agente.test.ts).
    pacotes: ["vender"],
    apenasHumano: true,
  },
  {
    name: "crm_create_conversation_draft",
    category: "write",
    rotulo: "Deixar texto sugerido para a pessoa revisar",
    explicacao:
      "Guarda um texto vindo de outro sistema (ERP, formulário) na conversa, para a pessoa que atende revisar e enviar. " +
      "Nada sai para o cliente por conta desta ação: o texto aparece no campo de resposta com o aviso de origem, " +
      "e só o clique de quem atende manda a mensagem.",
    oQueToca: "Atendimento",
    // `atencao`, não `critico`: a ação em si não alcança o cliente — ela prepara
    // uma sugestão que uma pessoa precisa confirmar. O peso do envio continua
    // sendo do `crm_send_whatsapp_message`, que segue `critico`.
    risco: "atencao",
    // "escalar", não "atender": o texto é deixado para uma PESSOA revisar e
    // enviar, que é a jornada "Passar para um humano". E "atender" é o pacote
    // que encosta no teto por agente: cada capacidade a mais ali é uma vaga que
    // o dono precisa liberar para ligar a jornada — o mesmo motivo que tirou
    // `crm_propose_contact_field` daqui. A conta que isso quebra está no e2e
    // `capacidades-do-agente.spec.ts` (comentário de `TOOLS_DO_SEED`).
    pacotes: ["escalar"],
  },
]);
