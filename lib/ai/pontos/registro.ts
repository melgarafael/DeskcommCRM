/**
 * OS PONTOS DO SISTEMA QUE USAM IA — a lista única.
 *
 * ## Por que este arquivo existe
 *
 * O DeskcommCRM chama modelo de linguagem em 23 lugares. Até aqui, QUAL modelo
 * cada um usava estava espalhado por três pilhas que não se falavam
 * (`runModelCall` com BYOK por org, `lib/ai/gateway.ts` por variável de
 * ambiente, `lib/ai/runtime/agent.ts` com um terceiro `switch`) e por sete
 * variáveis de ambiente. Não havia lugar nenhum onde a pergunta "quem usa IA
 * aqui, e com qual chave?" tivesse resposta.
 *
 * A consequência não era teórica. Três casos medidos neste repo:
 *
 *  - Um tenant com Anthropic como padrão e um agente publicado em OpenAI
 *    mandava `gpt-5-mini` para o endpoint da Anthropic; o turno inteiro morria
 *    antes de o agente responder, e a tela não mostrava nada
 *    (`lib/agent-engine/agent/aux-model-args.ts`).
 *  - A transcrição de áudio recebia a chave da Anthropic — o Whisper é da
 *    OpenAI — e recusava toda tentativa, com a chave certa no `.env`
 *    (`workers/media-derive-worker.ts`).
 *  - A descrição de imagem usa o modelo de conversa da organização; se ele não
 *    enxerga imagem, a descrição volta vazia e ninguém é avisado
 *    (`workers/media-derive-worker.ts`).
 *
 * Os três têm a mesma forma: uma escolha de modelo feita longe de quem sofre a
 * consequência, sem superfície para configurar e sem rastro para diagnosticar.
 *
 * ## O que este registro é (e o que não é)
 *
 * É a fonte de verdade de QUAIS pontos existem, o que cada um faz em português
 * de gente, e QUE CAPACIDADE o modelo escolhido precisa ter. Não é onde a
 * escolha mora: a escolha é por organização e vive no banco
 * (`ai_purpose_bindings`). Este arquivo é o catálogo contra o qual essa escolha
 * é validada.
 *
 * Ele alimenta três consumidores: a tela de provedores (`/app/ai/providers`), a
 * tela de execuções (`/app/ai/runs`) e a validação de compatibilidade que
 * impede escolher um modelo sem ferramentas para o ponto que precisa delas.
 *
 * ## A regra que o mantém honesto
 *
 * `tests/unit/pontos-de-ia-completude.test.ts` varre o código e reprova nos
 * dois sentidos: ponto que o código chama e não está aqui (ponto oculto, o
 * problema original), e ponto que está aqui e nenhum código chama (botão que
 * não controla nada, que é pior — gasta a confiança do operador numa tela que
 * mente). Ao adicionar uma chamada de modelo nova, este arquivo entra no mesmo
 * commit.
 *
 * ## Granularidade: por que um ponto por chamada, e não por grupo
 *
 * A tela agrupa por papel para não assustar quem não é engenheiro, mas o
 * registro — e o binding no banco — é por PONTO. Isso não é rigor gratuito: o
 * roteiro do produto prevê modelos locais, e um modelo local pequeno só é
 * confiável quando é especialista em uma tarefa só. Agrupar no armazenamento
 * fecharia essa porta; agrupar só na exibição a mantém aberta.
 */

/** O papel que o ponto cumpre — é como a tela agrupa, para quem não é engenheiro. */
export type PapelDeIa =
  | "atender"
  | "entender"
  | "proteger"
  | "lembrar"
  | "perceber"
  | "melhorar";

export const PAPEIS: Record<PapelDeIa, { rotulo: string; explicacao: string }> = {
  atender: {
    rotulo: "Atender o cliente",
    explicacao: "Escrever o que o cliente lê e agir no funil durante a conversa.",
  },
  entender: {
    rotulo: "Entender a conversa",
    explicacao: "Ler o que chegou e decidir o que aquilo significa para o negócio.",
  },
  proteger: {
    rotulo: "Proteger a operação",
    explicacao: "Barrar manipulação e promessa que a empresa não pode cumprir.",
  },
  lembrar: {
    rotulo: "Lembrar e buscar",
    explicacao: "Guardar o essencial da conversa e achar o material certo do seu negócio.",
  },
  perceber: {
    rotulo: "Ver e ouvir",
    explicacao: "Transformar áudio, imagem e vídeo do cliente em texto que o agente entende.",
  },
  melhorar: {
    rotulo: "Melhorar e testar",
    explicacao: "Avaliar o próprio desempenho e conferir se a configuração está de pé.",
  },
};

/**
 * O que o modelo escolhido precisa saber fazer. Campo ausente = não exige.
 *
 * É o que transforma o painel de "lista de nomes bonitos" em guarda real: o
 * catálogo da OpenRouter declara `tools` em `supported_parameters` e as
 * modalidades em `architecture.input_modalities`, então a compatibilidade é
 * checada com dado do provedor, não com uma tabela nossa que envelhece.
 */
export interface CapacidadeExigida {
  /** Chamar ferramentas. Sem isso o ponto não cria lead nem move o funil. */
  tools?: boolean;
  /** Ler imagem. */
  imagem?: boolean;
  /** Transcrever áudio. */
  audio?: boolean;
  /** É embedding, e o vetor precisa ter exatamente esta dimensão. */
  embeddingDims?: number;
}

/**
 * Onde o ponto grava telemetria hoje. `nenhum` é dívida — ver Frente 2.
 *
 * `ai_invocations` NÃO está aqui de propósito: a migration 0130 a depreciou e
 * `lib/ai/log-invocation.ts` passou a gravar em `llm_calls`. Enquanto o valor
 * existia no tipo, três pontos continuaram declarando-o e o registro — o
 * artefato que existe para responder "quem usa IA aqui, e onde isso fica
 * registrado" — apontava para uma tabela que ninguém mais escreve. Tirá-lo do
 * union é o que faz o `tsc` reprovar a volta, em vez de depender de alguém
 * reparar.
 */
export type DestinoDeTelemetria =
  | "llm_calls"
  | "ai_agent_runs"
  | "nenhum";

export interface PontoDeIa {
  /** Casa com o `purpose` passado ao seam, ou com o id do ponto fora dele. */
  id: string;
  /** Nome curto na tela. */
  rotulo: string;
  /** O que faz, para quem não é engenheiro. */
  oQueFaz: string;
  papel: PapelDeIa;
  exige: CapacidadeExigida;
  /** Arquivo que emite a chamada — auditável pelo teste de completude. */
  emissor: string;
  /**
   * O que o USUÁRIO vê quando este ponto falha. É a coluna que faz a tela de
   * execuções responder "por que falhou" a quem não lê mensagem de erro —
   * escrita em consequência de negócio, nunca em jargão.
   */
  sintomaDeFalha: string;
  /**
   * Ponto que NÃO aceita troca de modelo, com a razão por escrito. A tela
   * mostra o cadeado junto da razão: sem ela, o operador conclui que o produto
   * é limitado, em vez de entender que a troca quebraria algo em silêncio.
   */
  /**
   * Ponto que o produto resolve sozinho — a escolha do painel não se aplica.
   * `usa` diz o que ele de fato chama: sem isso a tela caía na cadeia de
   * resolução dos pontos de conversa e anunciava um modelo de chat num ponto
   * que fala com a API de transcrição.
   */
  fixo?: { razao: string; usa?: { provider: string; modelId: string } };
  registraEm: DestinoDeTelemetria;
}

export const PONTOS_DE_IA: readonly PontoDeIa[] = [
  // ─────────────────────────── Atender o cliente ───────────────────────────
  {
    id: "agent_turn",
    rotulo: "Responder o cliente",
    oQueFaz:
      "Escreve a resposta que o cliente lê no WhatsApp, consultando o material do seu negócio e usando as ferramentas do CRM.",
    papel: "atender",
    exige: { tools: true, imagem: true },
    emissor: "lib/agent-engine/agent/inbound-turn.ts",
    sintomaDeFalha:
      "O cliente manda mensagem e ninguém responde. A conversa fica parada na Caixa de entrada sem aviso.",
    registraEm: "llm_calls",
  },
  {
    id: "operator_turn",
    rotulo: "Trabalhar o funil",
    oQueFaz:
      "Cria o lead, move de etapa e registra o que ficou combinado, enquanto a conversa acontece.",
    papel: "atender",
    exige: { tools: true },
    emissor: "lib/agent-engine/agent/operator-turn.ts",
    sintomaDeFalha:
      "O cliente é atendido normalmente, mas nada aparece no funil — nenhum lead criado, nenhuma etapa movida.",
    registraEm: "llm_calls",
  },
  {
    id: "automation_ai_message",
    rotulo: "Abordar quem preencheu o formulário",
    oQueFaz:
      "Escreve a primeira mensagem para quem acabou de preencher um formulário, usando os campos que a pessoa respondeu e a orientação que você deu na automação.",
    papel: "atender",
    // Sem tools: o texto vem e quem envia é a automação, com janela de horário
    // e opt-out. Dar `send_message` ao modelo faria dele o remetente.
    exige: {},
    emissor: "lib/agent-engine/agent/abordagem-de-formulario.ts",
    sintomaDeFalha:
      "O lead entra pelo formulário, a automação roda, e a mensagem de abordagem nunca é escrita — o contato fica no funil sem ninguém falar com ele.",
    registraEm: "llm_calls",
  },
  {
    id: "draft_suggestion",
    rotulo: "Sugerir resposta ao atendente",
    oQueFaz:
      "Escreve um rascunho de resposta para o atendente humano revisar antes de enviar.",
    papel: "atender",
    exige: {},
    emissor: "lib/agent-engine/agent/draft-reply.ts",
    sintomaDeFalha:
      "O botão de sugerir resposta não traz nada, e o atendente escreve do zero sem saber por quê.",
    registraEm: "llm_calls",
  },
  {
    id: "bot_respond",
    rotulo: "Responder (motor antigo)",
    oQueFaz:
      "Caminho de resposta anterior ao motor de agentes atual, mantido para instalações que ainda o usam.",
    papel: "atender",
    exige: {},
    emissor: "workers/ai-response-worker.ts",
    sintomaDeFalha:
      "Nas instalações que ainda dependem dele, o cliente fica sem resposta e a conversa não avança.",
    registraEm: "llm_calls",
  },

  // ────────────────────────── Entender a conversa ──────────────────────────
  {
    id: "intent_router",
    rotulo: "Escolher qual agente atende",
    oQueFaz:
      "Lê a mensagem que chegou e decide qual dos seus agentes deve pegar aquela conversa.",
    papel: "entender",
    exige: {},
    emissor: "lib/agent-engine/agent/intent-classifier.ts",
    sintomaDeFalha:
      "A conversa cai sempre no mesmo agente, ou em nenhum — como se os roteadores que você configurou não existissem.",
    registraEm: "llm_calls",
  },
  {
    id: "stage_classifier",
    rotulo: "Identificar a etapa do lead",
    oQueFaz:
      "Lê a conversa e sugere em que etapa do funil aquele cliente está de verdade.",
    papel: "entender",
    exige: {},
    emissor: "lib/agent-engine/agent/stage-classifier.ts",
    sintomaDeFalha:
      "Os leads param de andar sozinhos pelo funil e ficam todos na etapa em que entraram.",
    registraEm: "llm_calls",
  },
  {
    id: "sentiment_classify",
    rotulo: "Medir o clima da conversa",
    oQueFaz:
      "Avalia se o cliente está satisfeito ou irritado, para escalar ao humano antes de perder a venda.",
    papel: "entender",
    exige: {},
    emissor: "workers/ai-sentiment-worker.ts",
    sintomaDeFalha:
      "Cliente irritado não é mais escalado para um humano, e a insatisfação só aparece quando ele já sumiu.",
    registraEm: "llm_calls",
  },
  {
    id: "followup_classify",
    rotulo: "Ler a resposta ao follow-up",
    oQueFaz:
      "Entende se o cliente aceitou, recusou ou pediu para falar depois, e encaminha o fluxo conforme isso.",
    papel: "entender",
    exige: {},
    emissor: "lib/agent-engine/agent/followup-flow-classify.ts",
    sintomaDeFalha:
      "O follow-up trava no mesmo passo: o cliente respondeu, mas o fluxo não segue para lugar nenhum.",
    registraEm: "llm_calls",
  },
  {
    id: "followup_decide_timing",
    rotulo: "Escolher a hora do follow-up",
    oQueFaz: "Decide o melhor momento para retomar uma conversa que esfriou.",
    papel: "entender",
    exige: {},
    emissor: "lib/agent-engine/agent/followup-flow-classify.ts",
    sintomaDeFalha:
      "As retomadas saem todas no mesmo horário fixo, sem respeitar o ritmo de cada cliente.",
    registraEm: "llm_calls",
  },

  // ────────────────────────── Proteger a operação ──────────────────────────
  {
    id: "jailbreak_detect",
    rotulo: "Barrar tentativa de manipulação",
    oQueFaz:
      "Percebe quando alguém tenta enganar o agente para ele fugir das suas regras.",
    papel: "proteger",
    exige: {},
    emissor: "lib/agent-engine/guardrails/jailbreak/classifier.ts",
    sintomaDeFalha:
      "O agente passa a aceitar instruções de estranhos e pode falar em nome da empresa coisas que você nunca autorizou.",
    registraEm: "llm_calls",
  },
  {
    id: "promise_semantic",
    rotulo: "Impedir promessa que não se cumpre",
    oQueFaz:
      "Confere se a resposta promete prazo, desconto ou condição que a empresa não pode honrar.",
    papel: "proteger",
    exige: {},
    emissor: "lib/agent-engine/guardrails/promise/semantic.ts",
    sintomaDeFalha:
      "O agente promete ao cliente coisas que a operação não entrega, e a cobrança chega depois.",
    registraEm: "llm_calls",
  },

  // ─────────────────────────── Lembrar e buscar ────────────────────────────
  {
    id: "compaction",
    rotulo: "Resumir a conversa longa",
    oQueFaz:
      "Condensa uma conversa comprida no essencial, para o agente não perder o fio nem encarecer cada resposta.",
    papel: "lembrar",
    exige: {},
    emissor: "lib/agent-engine/agent/compaction.ts",
    sintomaDeFalha:
      "Em conversas longas o agente esquece o que já foi combinado e começa a repetir perguntas.",
    registraEm: "llm_calls",
  },
  {
    id: "flush",
    rotulo: "Guardar o combinado",
    oQueFaz:
      "Extrai da conversa os compromissos, objeções e dados do cliente antes de fechar o atendimento.",
    papel: "lembrar",
    exige: {},
    emissor: "lib/agent-engine/agent/compaction.ts",
    sintomaDeFalha:
      "O que foi combinado com o cliente não fica registrado, e o próximo atendimento começa do zero.",
    registraEm: "llm_calls",
  },
  {
    id: "checkpoint",
    rotulo: "Fechar o atendimento",
    oQueFaz:
      "Escreve o resumo de encerramento do turno, que o próximo atendimento lê ao abrir.",
    papel: "lembrar",
    exige: {},
    emissor: "lib/agent-engine/agent/inbound-turn.ts",
    sintomaDeFalha:
      "Cada retomada de conversa parece a primeira: o agente não sabe o que aconteceu antes.",
    registraEm: "llm_calls",
  },
  {
    id: "embedding_indexar",
    rotulo: "Indexar o seu material",
    oQueFaz:
      "Prepara os documentos do seu negócio para que o agente consiga encontrá-los na hora de responder.",
    papel: "lembrar",
    exige: { embeddingDims: 1536 },
    emissor: "lib/ai/embed.ts",
    fixo: {
      razao:
        "O material indexado e a busca precisam usar exatamente o mesmo modelo — são coordenadas de um mesmo mapa. Trocar só um dos lados não dá erro: o agente simplesmente para de achar o seu conteúdo, sem avisar. Para mudar de modelo aqui é preciso reindexar tudo de uma vez.",
    },
    sintomaDeFalha:
      "Você sobe um documento e ele nunca fica pronto para uso; o agente responde sem conhecer o seu material.",
    // `nenhum`, e não `llm_calls`: `lib/ai/embed.ts` não chama `logInvocation`
    // nem passa pelo seam — não há uma linha de telemetria para este ponto em
    // lugar nenhum. Declarar a tabela certa seria mentir sobre uma cobertura
    // que não existe; a dívida fica visível com o nome dela.
    registraEm: "nenhum",
  },
  {
    id: "embedding_consultar",
    rotulo: "Buscar no seu material",
    oQueFaz:
      "Encontra, entre os seus documentos, os trechos que respondem à pergunta do cliente.",
    papel: "lembrar",
    exige: { embeddingDims: 1536 },
    emissor: "lib/agent-engine/edge/llm/embed.ts",
    fixo: {
      razao:
        "Precisa usar o mesmo modelo com que o material foi indexado. Se divergir, a busca continua funcionando e devolve resultados errados — falha silenciosa, e por isso a troca é feita junto com a reindexação, não aqui.",
    },
    sintomaDeFalha:
      "O agente responde de forma genérica, ignorando o que está escrito nos seus documentos.",
    registraEm: "nenhum",
  },

  // ───────────────────────────── Ver e ouvir ───────────────────────────────
  {
    id: "transcricao_de_audio",
    rotulo: "Ouvir o áudio do cliente",
    oQueFaz: "Transforma o áudio que o cliente mandou em texto que o agente lê.",
    papel: "perceber",
    exige: { audio: true },
    emissor: "lib/messaging/media/transcription.ts",
    fixo: {
      razao:
        "Usa o padrão de transcrição da OpenAI, que é o formato que os serviços do mercado implementam. Aceita apontar para outro serviço compatível — inclusive um rodando na sua própria máquina — mas exige uma chave desse serviço, separada da chave do modelo de conversa.",
      // ⚠️ O QUE ELE USA DE VERDADE, e por que precisa estar escrito aqui.
      //
      // A tela mostrava `claude-sonnet-5` neste ponto, com "usando o padrão da
      // organização" — porque um ponto `fixo` percorria a mesma cadeia de
      // resolução dos pontos de conversa e caía no último degrau. O texto ao
      // lado dizia "usa o padrão de transcrição da OpenAI", então a mesma tela
      // afirmava duas coisas incompatíveis sobre o mesmo ponto.
      //
      // Um modelo de conversa NÃO transcreve áudio. Anunciar um ali é dizer a
      // quem opera que o áudio está sendo ouvido pelo modelo errado — e mandá-lo
      // caçar um problema que não existe, ou trocar um modelo que não é o que
      // faz o trabalho. `lib/messaging/media/transcription.ts` manda para
      // `/v1/audio/transcriptions` com `whisper-1`.
      usa: { provider: "openai", modelId: "whisper-1" },
    },
    sintomaDeFalha:
      "O cliente manda áudio e o agente responde como se não tivesse recebido nada.",
    registraEm: "nenhum",
  },
  {
    id: "visao_de_imagem",
    rotulo: "Ver a imagem do cliente",
    oQueFaz:
      "Descreve a foto, o print ou o comprovante que o cliente enviou, para o agente saber do que se trata.",
    papel: "perceber",
    exige: { imagem: true },
    emissor: "workers/media-derive-worker.ts",
    sintomaDeFalha:
      "O cliente manda uma foto do produto ou um comprovante e o agente age como se a imagem não existisse.",
    registraEm: "nenhum",
  },

  // ────────────────────────── Melhorar e testar ────────────────────────────
  {
    id: "flywheel_judge",
    rotulo: "Avaliar o próprio atendimento",
    oQueFaz:
      "Revisa atendimentos já concluídos e julga quais foram bons, para o agente aprender com eles.",
    papel: "melhorar",
    exige: {},
    emissor: "lib/agent-engine/flywheel/live.ts",
    sintomaDeFalha:
      "A tela de Propostas para de sugerir melhorias, e o agente estaciona no desempenho atual.",
    registraEm: "llm_calls",
  },
  {
    id: "flywheel_distiller",
    rotulo: "Extrair a lição",
    oQueFaz:
      "Transforma os bons atendimentos em orientação prática para o agente aplicar nos próximos.",
    papel: "melhorar",
    exige: {},
    emissor: "lib/agent-engine/flywheel/live.ts",
    sintomaDeFalha:
      "As melhorias identificadas não viram instrução, e o mesmo acerto precisa ser redescoberto toda vez.",
    registraEm: "llm_calls",
  },
  {
    id: "connection_test",
    rotulo: "Testar a conexão com o provedor",
    oQueFaz:
      "Faz uma chamada de verdade ao provedor para confirmar que a chave e o modelo escolhidos funcionam.",
    papel: "melhorar",
    exige: {},
    emissor: "lib/agent-engine/edge/llm/test-model.ts",
    sintomaDeFalha:
      "O botão de testar não conclui, e você fica sem saber se a configuração está de pé antes de colocar no ar.",
    registraEm: "llm_calls",
  },
  {
    id: "teste_de_agente",
    rotulo: "Ensaiar o agente antes de publicar",
    oQueFaz:
      "Roda o agente contra uma conversa de mentira, para você ver como ele responderia sem falar com cliente de verdade.",
    papel: "melhorar",
    exige: { tools: true },
    emissor: "lib/ai/runtime/agent.ts",
    fixo: {
      razao:
        "Usa o modelo da versão do agente que você está ensaiando — e é exatamente isso que faz o ensaio valer. " +
        "Se este ponto tivesse modelo próprio, você testaria uma configuração diferente da que vai publicar, e o " +
        "ensaio deixaria de prever o comportamento real. Para trocar o modelo, troque na versão do agente.",
    },
    sintomaDeFalha:
      "O ensaio do agente não devolve resposta, e você precisa publicar às cegas para descobrir se ficou bom.",
    registraEm: "ai_agent_runs",
  },
  {
    id: "contagem_de_tokens",
    rotulo: "Medir o tamanho do contexto",
    oQueFaz:
      "Calcula quanto do limite do modelo a conversa já ocupa, para decidir a hora de resumir.",
    papel: "melhorar",
    exige: {},
    emissor: "lib/agent-engine/edge/llm/count-tokens.ts",
    fixo: {
      razao:
        "Cada família de modelo conta o tamanho do texto de um jeito próprio, então a medida precisa vir do mesmo provedor do modelo em uso — não é uma escolha à parte.",
    },
    sintomaDeFalha:
      "O sistema erra a hora de resumir a conversa: resume cedo demais e perde contexto, ou tarde demais e a resposta é recusada.",
    registraEm: "nenhum",
  },
] as const;

/** Índice por id, para quem resolve um binding. */
export const PONTO_POR_ID: ReadonlyMap<string, PontoDeIa> = new Map(
  PONTOS_DE_IA.map((p) => [p.id, p]),
);

/**
 * Os pontos agrupados como a tela mostra. A ordem dentro de cada papel é a de
 * declaração, que já está escrita na ordem em que o operador pensa (o que o
 * cliente vê primeiro, depois o que sustenta aquilo).
 */
export function pontosPorPapel(): Record<PapelDeIa, PontoDeIa[]> {
  const vazio = Object.fromEntries(
    Object.keys(PAPEIS).map((k) => [k, [] as PontoDeIa[]]),
  ) as Record<PapelDeIa, PontoDeIa[]>;

  for (const ponto of PONTOS_DE_IA) vazio[ponto.papel].push(ponto);
  return vazio;
}

/** Os pontos que aceitam troca de modelo — os únicos que a tela deixa editar. */
export function pontosConfiguraveis(): PontoDeIa[] {
  return PONTOS_DE_IA.filter((p) => p.fixo === undefined);
}
