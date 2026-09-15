/**
 * Capacidades de AGENDA — consultar horário e marcar compromisso.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente. O texto que vai ao
 * MODELO é a `description` do handler (`lib/mcp/tools/agendamento.ts`), e ela
 * NÃO tem cópia aqui — duplicata que ninguém lê não é documentação, é armadilha.
 *
 * ⚠️ O VOCABULÁRIO DO DONO DA CLÍNICA NÃO É O NOSSO. Aqui não entram "slot",
 * "agendamento" no sentido de linha de banco, nem "appointment": o gate
 * `tests/unit/catalogo-tools-leigo-friendly.test.ts` reprova jargão, e a pessoa
 * que lê esta tela diz CONSULTA, SESSÃO e HORÁRIO. As palavras de wire ficam
 * só no `name`, que é contrato e não texto.
 *
 * ⚠️ O PLAYBOOK `agendamento` CITA ESTES QUATRO NOMES AO CONVERSADOR — e a doutrina
 * do repo diz que a cura do vazamento é o Conversador NUNCA TER VISTO o vocabulário
 * (`lib/agent-engine/agent/entrega-de-capacidade.ts:7`, `operator-turn.ts:5`: "a separação
 * é por AUSÊNCIA"). Aqui a mitigação é por REDAÇÃO, que é filtro. A tensão é real e fica
 * escrita, não resolvida — quem reabrir decide com ela à vista.
 *
 * O CENÁRIO CONCRETO, para não ficar em abstração: o playbook é injetado no
 * `inbound_turn` (`lib/agent-engine/agent/inbound-turn.ts:1617`), por GATILHO, não sempre.
 * O turno monta as tools MCP **habilitadas na tela** (idem:2415). Se um tenant habilitar a
 * família de agenda apenas em `operator_tool_ids`, o Conversador lê quatro nomes que não
 * pode chamar. Três desfechos, e cada um tem ONDE ser observado:
 *
 *   (a) repete o nome ao cliente ...... `internal_vocabulary` no before-send. Medido no
 *       HEAD, não deduzido: as tools de agenda são pegas pela lista derivada do
 *       `TOOL_CATALOG` E pela regra snake_case — que pega até nome INVENTADO. O veto
 *       volta ao modelo como erro instrutivo. Remedir:
 *
 *         pnpm exec tsx -e 'import("@/lib/agent-engine/guardrails/vazamento-interno")
 *           .then(({detectarVazamentoInterno:d})=>{
 *             console.log(d("vou usar crm_book_appointment"), d("quinta as 14h, pode ser?"))})'
 *
 *       O segundo argumento é o CONTROLE: se ele também acusar, o detector está gritando
 *       com tudo e o primeiro resultado não prova nada.
 *
 *   (b) tenta CHAMAR tool ausente ..... não é vazamento, é erro de tool call, e aparece no
 *       log de invocação do run.
 *
 *   (c) promete a capacidade sem tê-la . NÃO é do before-send, e esta linha já afirmou o
 *       contrário: dizia "os gates promise/semantic_promise da mesma cadeia", e os dois são
 *       de outra categoria. Medido, com controle positivo para provar que as funções estão
 *       vivas:
 *
 *         "vou verificar a agenda e já te confirmo"  -> detectHumanPromise=false, promise=[]
 *         "vou verificar com a EQUIPE e te confirmo" -> detectHumanPromise=TRUE   (controle+)
 *         "consigo fazer por R$ 200 à vista"         -> promise=["price"]         (controle+)
 *         "quinta às 14h, pode ser?"                 -> ambos false               (controle-)
 *
 *       `human-promise` exige ALVO HUMANO (verificar COM alguém) e `promise/engine` só
 *       conhece preço/desconto/parcelas. O semântico também não é a rede: a instrução dele
 *       exclui em letra "próximos passos vagos SEM compromisso concreto".
 *
 *       A rede que existe é a do OPERADOR, e ela é DECLARATIVA — não detectiva. A instrução
 *       da declaração do turno (`lib/agent-engine/agent/declaracao.ts:99`) manda declarar
 *       "tudo que você prometeu a ela — INCLUSIVE 'vou verificar e te aviso'", que é a frase
 *       exata deste caso, e `promessasEmAberto` faz o Operador apurar se alguém assumiu.
 *
 *       ⚠️ NÃO LEIA ISSO COMO COBERTURA — e esta linha já errou DUAS vezes na direção
 *       otimista, o que é o próprio aviso. Primeiro disse "e ela é boa"; depois disse que os
 *       três estados de declaração eram "indistinguíveis", lendo `promessasEmAberto` (uma
 *       linha, que de fato não consulta `nada_a_declarar`) e concluindo sobre a CADEIA. Quem
 *       consulta está noutro arquivo. Seguida até onde o efeito acontece:
 *
 *         nada_a_declarar: true  -> `decidirSeRoda` (operator-turn.ts:233) CURTO-CIRCUITA:
 *                                   o Operador NÃO RODA. Pior dos três, e exige um ato
 *                                   deliberado do modelo — a declaração falsa DESLIGA a rede.
 *         declaração AUSENTE     -> o Operador RODA, por desenho escrito (idem:25: "ausente
 *                                   significa que NINGUÉM avaliou"). Age com o contexto que
 *                                   tem — sem saber que houve promessa.
 *         promessas: []          -> roda, e não acha o que cobrar.
 *         declaração INVÁLIDA    -> quarto caminho, e ele NÃO é alcançável por dado novo —
 *                                   esta linha já disse que era "o mais silencioso", e isso
 *                                   estava errado na direção pessimista. `parseCheckpointText`
 *                                   (`inbound-turn.ts`) LANÇA quando o shape reprova ("run
 *                                   re-tentado pela fila"), com o MESMO `declaracaoDoTurnoSchema`
 *                                   que o Operador revalida. O que não passa nunca é
 *                                   persistido; o `safeParse` de lá é defesa em profundidade,
 *                                   não tratamento de caso que acontece.
 *                                   O gatilho real é DADO LEGADO: checkpoint gravado antes de
 *                                   o schema mudar passa a reprovar depois — e aí sim vira
 *                                   `declaracao: null` em silêncio. Não é risco de runtime, é
 *                                   detector de migração mal feita, o que é um argumento
 *                                   melhor para o campo de estado do que o que tínhamos.
 *
 *       ⚠️ E O SINAL NÃO ESTÁ ONDE EU DISSE. Esta linha já ofereceu `declaracao_ausente` como
 *       endereço de observação; ele existe UMA vez, dentro de um `log.info` — e o cabeçalho
 *       de `registrarDesfecho`, vinte linhas abaixo, escreve contra isso: "log de worker em
 *       VPS não é superfície de nada, e este produto é instalado por quem nunca vai abrir um
 *       contêiner". O `event_log`, que é emitido SEMPRE, NÃO carrega esse campo. Ele separa
 *       dois dos quatro estados (`porque: 'declaracao_vazia'` denuncia o `nada_a_declarar`, e
 *       `houve_checkpoint: false` denuncia o turno que morreu antes de fechar) e colapsa os
 *       outros dois. (Achado do Arquiteto; a régua é do próprio módulo.)
 *
 *       ⚠️ MAS "RODA" NÃO É "COBRE A PROMESSA", e é aqui que a cadeia termina:
 *       `apurarComRetorno` (idem:510) abre com `if (promessasDeclaradas === 0) return null`.
 *       Nos TRÊS estados a contagem é zero, então em nenhum deles a apuração de dono
 *       acontece e nenhum aviso de promessa-sem-dono é aberto. O que difere entre os três é
 *       se o Operador AGE, não se a promessa é COBRADA.
 *
 *       E o corpo enviado nunca é consultado por gate nenhum:
 *       `grep nada_a_declarar lib/agent-engine/guardrails/` devolve ZERO.
 *
 *       E o limite está escrito no próprio `operator-turn.ts`: a apuração diz se alguém ficou
 *       RESPONSÁVEL, não se a promessa foi cumprida — "agendar um retorno não é cumprir".
 *
 *       O conserto seria barato e SEM LLM (proposta do Arquiteto, não implementada): quando a
 *       declaração vem sem promessa, varrer o corpo enviado por marcador de promessa de
 *       MÁQUINA ("te confirmo", "te aviso", "já te falo", "volto com"). É o motor do
 *       `detectHumanPromise` com o outro vocabulário — o dele exige alvo humano, e é por isso
 *       que não pega este caso. Divergência entre o dito e o declarado é sinal, e os dois
 *       lados já estão na mesma transação.
 *
 * ⚠️ O QUE NINGUÉM MEDIU AINDA: como o modelo se comporta, de fato, num tenant com a
 * família só no Operador. Há lugar de observação — `before_send_traces` é durável e
 * exportável por run, então olhar não precisa ser síncrono com o evento. Isso é trabalho
 * ADIADO com endereço, não risco sem instrumento: quem quiser fechar, olha o traço do
 * primeiro tenant nessa configuração. (Achado do Arquiteto; a ressalva mora aqui, e não no
 * briefing da entrega, porque briefing morre com a entrega e este arquivo não.)
 *
 * ⚠️ PACOTE: `vender`, e a razão é ARITMÉTICA antes de ser semântica.
 *
 * `atender` seria a primeira escolha — marcar consulta é o desfecho de um
 * atendimento. Mas ele já está com 18 capacidades, quase todo o teto POR AGENTE
 * (`TETO_TOOLS_POR_AGENTE`), e a família de agenda são CINCO: consultar,
 * listar, marcar, remarcar e desmarcar. Em `atender` cabe UMA — e uma família
 * partida entre dois pacotes é pior que ela inteira no pacote vizinho, porque o
 * dono liga "Atender" e ganha metade da agenda sem saber qual metade.
 *
 * `vender` tem folga para as cinco. E é defensável sem apelar para o número: numa
 * clínica, marcar consulta É a conversão — é o "ganho" do funil, não uma resposta
 * a mais na conversa.
 *
 * ⚠️ NÃO CRAVO O NÚMERO AQUI, e a razão é que ele já me pegou uma vez: a versão
 * anterior deste comentário dizia "vender tem 11 (11+5=16)" e estava errada — eram
 * 12 antes desta tool, 13 depois. O erro não foi de leitura, foi de INSTRUMENTO:
 * medi com regex sobre o texto do catálogo, com janela de 900 caracteres entre
 * `name:` e `pacotes:`, e `crm_propose_contact_field` tem 1930. A janela truncou
 * em silêncio e o script não tinha como avisar.
 *
 * Quem for reabrir a decisão de pacote mede pelo OBJETO, não pelo texto:
 *
 *   pnpm exec tsx -e 'import("@/lib/mcp/tools/catalogo").then(({TOOL_CATALOG})=>{
 *     const p={}; for(const t of TOOL_CATALOG) for(const b of t.pacotes) p[b]=(p[b]??0)+1;
 *     console.log(p, "total:", TOOL_CATALOG.length)})'
 *
 * O total serve de controle: se a soma dos pacotes não fizer sentido contra
 * `TOOL_CATALOG.length`, o instrumento está perdendo entrada.
 *
 * Medido: acrescentar esta capacidade a `atender` levaria o pacote a 19 e
 * quebraria `tests/e2e/capacidades-do-agente.spec.ts` em DOIS pontos — a
 * asserção de "falta 1 vaga" (viraria 2) e a de que liberar UMA vaga basta para
 * ligar o pacote (não bastaria). Isso não é motivo para escolher `vender`, mas é
 * o custo que a escolha por `atender` teria, e ele está aqui para quem reabrir.
 *
 * **Decisão de pacote PRÓPRIO (`agendar`) segue pendente com o maestro** — foi
 * levantada em `CONTRATO-MCP-agenda.md` §7 antes de existir código. `vender` é o
 * lar que não estoura nada hoje e não parte a família.
 */
import { declararTools } from "./tipos";

export const TOOLS_AGENDAMENTO = declararTools([
  {
    // A PRIMEIRA da lista porque é o primeiro passo do fluxo — e porque a
    // ausência dela era o defeito. As outras quatro exigem o identificador do
    // tipo de atendimento, e nenhuma capacidade do catálogo dizia quais existem:
    // o agente chutava o nome e ouvia "não existe atendimento chamado assim".
    name: "crm_list_event_types",
    category: "read",
    rotulo: "Ver o que a empresa atende",
    explicacao:
      "Mostra os tipos de atendimento que dá para marcar, quanto cada um dura e como é feito, para o atendente de IA falar do que existe de verdade.",
    oQueToca: "Agenda da equipe",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_find_free_slots",
    category: "read",
    rotulo: "Ver horários livres na agenda",
    explicacao:
      "Mostra os horários em que um atendente pode receber, já descontando as folgas dele, o que ele tem marcado e os compromissos da agenda pessoal.",
    oQueToca: "Agenda da equipe",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_list_appointments",
    category: "read",
    rotulo: "Ver os compromissos marcados",
    explicacao:
      "Lista os compromissos com hora marcada de um cliente ou de um dia, com a situação de cada um: marcado, realizado ou desmarcado.",
    oQueToca: "Agenda da equipe",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_find_and_book_appointment",
    category: "write",
    rotulo: "Ver se o horário está livre e já marcar",
    explicacao:
      "Confere o horário que o cliente pediu e, se estiver livre, já reserva na mesma conversa — em vez de só consultar e depender de uma segunda decisão para marcar.",
    oQueToca: "Agenda da equipe",
    // `atencao`, igual a `crm_book_appointment`: o que ela faz a mais é a
    // consulta, e o efeito que persiste é o mesmo marcar — que se desfaz.
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_book_appointment",
    category: "write",
    rotulo: "Marcar consulta ou sessão",
    explicacao:
      "Reserva um horário do atendente para receber o cliente. A pessoa passa a contar com esse horário, então não é um registro interno.",
    oQueToca: "Agenda da equipe",
    // `atencao` e não `critico`: marcar errado se desfaz — remarca ou desmarca.
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_reschedule_appointment",
    category: "write",
    rotulo: "Remarcar um compromisso",
    explicacao:
      "Move um compromisso já marcado para outro horário, mantendo o mesmo cliente e o mesmo tipo de atendimento.",
    oQueToca: "Agenda da equipe",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_confirm_appointment",
    category: "write",
    rotulo: "Confirmar um horário combinado",
    explicacao:
      "Confirma o horário que estava esperando a resposta da pessoa, para a equipe saber que ela vem mesmo.",
    oQueToca: "Agenda da equipe",
    // `atencao` e não `critico`: confirmar errado se desfaz — remarca ou desmarca.
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_set_appointment_outcome",
    category: "write",
    rotulo: "Registrar se a pessoa veio ou faltou",
    explicacao:
      "Anota o que aconteceu num horário que já passou: a pessoa foi atendida, ou não apareceu.",
    oQueToca: "Agenda da equipe",
    // `atencao`: registrar falta devolve o horário para outra pessoa, mas o
    // sistema recusa fazer isso antes da hora — a guarda mora no handler.
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_cancel_appointment",
    category: "write",
    rotulo: "Desmarcar um compromisso",
    explicacao:
      "Desmarca um horário combinado e devolve esse horário para outra pessoa poder pegar, o que não dá para desfazer.",
    oQueToca: "Agenda da equipe",
    // ⚠️ `critico` INVERTE a intuição, e a régua do repo decide sozinha: crítico é
    // "efeito que não dá para desfazer". Marcar errado se desfaz; CANCELAR não —
    // o horário volta ao pool e some em segundos. Consequência deliberada: crítico
    // nunca entra por pacote, então a IA marca assim que o pacote é ligado e só
    // desmarca se o dono ligar explicitamente. Falha fechado no lado certo.
    risco: "critico",
    pacotes: ["vender"],
  },
]);
