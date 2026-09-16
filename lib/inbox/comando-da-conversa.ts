/**
 * Quem manda nesta conversa — a pergunta com UMA resposta.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * "Quem está atendendo?" e "o automático está ligado?" eram respondidas por
 * SETE fatos espalhados: `conversations.status`, `assigned_to_user_id`,
 * `assignee_kind`, `bot_silenced_until`, `last_handoff_at/reason` e
 * `contacts.force_human`. Cada pedaço da tela juntava um subconjunto diferente —
 * o cabeçalho olhava dois (`bot_silenced_until || force_human`), a linha da lista
 * olhava um (`status === 'ai_handling'`, por COR), e o painel direito olhava
 * nenhum. Três leituras parciais do mesmo estado é como se produz uma tela em que
 * ninguém sabe quem manda.
 *
 * Aqui não nasce estado novo: a doutrina DIRC manda **C**alcular antes de
 * duplicar, e uma oitava coluna a sincronizar seria o anti-pattern nº 5. Isto é
 * uma função pura sobre a linha que a rota JÁ devolve.
 *
 * ## Por que estes gates e não outros
 *
 * O espelho é o do MOTOR, não o do desenhista. Quem cala o automático, medido no
 * código de produção:
 *
 *   1. `contacts.force_human`            → `isLeadInHandoff`, `before-send`, worker
 *   2. `conversations.bot_silenced_until`→ `isLeadInHandoff`, worker
 *   3. `conversations.assignee_kind='user'` → worker legado (`assigned_to_human`)
 *      e, desde a migration 0173, consequência de (2): assumir grava silêncio.
 *
 * Um motivo a MAIS na lista seria a tela afirmando sobre o motor uma coisa que o
 * motor não faz. Dois candidatos ficaram FORA de propósito:
 *
 *   * **janela de 24h** — nem todo canal a tem (é uma CAPACIDADE,
 *     `freeformOutsideWindow` em `lib/channels/capabilities.ts`), e quem responde
 *     por isso na tela é o `JanelaSelo`, que consulta a capacidade. Recalcular 24h
 *     aqui diria "o automático está calado porque a janela fechou" em toda conversa
 *     de canal sem janela com mais de um dia, ao lado de um selo dizendo o
 *     contrário. E perguntar de que provider é o canal, aqui, seria o que a
 *     doutrina de restrição de canal proíbe fora de `lib/channels/` — foi o
 *     `lint:channels` que pegou a primeira versão deste comentário.
 *   * **conversa encerrada** — já é o `status`, e o `STATUS_LABEL` do cabeçalho já
 *     a mostra. Ela entra como ESTADO DE COMANDO (`encerrada`), não como motivo.
 *
 * Informação com propósito (invariante 5): cada motivo aqui muda a ação de quem
 * lê. `resposta_humana_recente` existe justamente para dizer **não faça nada** —
 * é a janela deslizante de 5 min do envio manual, que se desfaz sozinha, e hoje a
 * tela oferece um botão de "devolver" para um estado que já vai voltar sozinho.
 */

/** As colunas de que esta função precisa — nada além. */
export interface FatosDoComando {
  status: string;
  /**
   * A ORG tem atendimento automático de pé?
   *
   * `undefined` significa "não sei" — leitura em andamento ou que falhou — e é
   * tratado como "não afirme nada", nunca como `false`: dizer "não há automático"
   * por causa de uma requisição que não voltou é a mesma mentira ao contrário.
   * Com `undefined` a função mantém o comportamento de assumir que há, que é o
   * certo para a instalação configurada.
   */
  automaticoDaOrg?: boolean;
  assigned_to_user_id: string | null;
  /** Nome do atendente, quando o servidor conseguiu resolvê-lo (pode ser null). */
  assigned_to_user_name?: string | null;
  assignee_kind?: string | null;
  /** ISO, ou o literal `"infinity"` que o Postgres devolve para o silêncio durável. */
  bot_silenced_until?: string | null;
  /** A trava do CONTATO — irrevogável pelo agente. */
  force_human?: boolean | null;
  /**
   * O contato pediu para não receber mensagens (`contacts.is_blocked`).
   *
   * Entra aqui porque o motor o trata como parada dura — `before-send.ts` recusa
   * com `select (is_blocked or force_human) as stopped` — e uma tela que dissesse
   * "Automático atendendo" sobre um contato descadastrado afirmaria o oposto do
   * que vai acontecer.
   *
   * **Mas ele NÃO liga `travaVigente`**, e a diferença é deliberada: `travaVigente`
   * é o que acende "Devolver ao automático", e devolver não desfaz um opt-out — o
   * `stopGate` recusaria na mesma. Um botão que aparece e não pode funcionar é
   * controle decorativo, que é pior que ausência de botão.
   */
  is_blocked?: boolean | null;
}

export type Comando =
  /** Uma pessoa está no comando. */
  | { quem: "humano"; userId: string; nome: string | null }
  /** O automático está atendendo. */
  | { quem: "automatico" }
  /**
   * Sem dono e sem trava, mas a org NÃO tem atendimento automático de pé — então
   * não há quem responda. É o estado de toda instalação que ainda não configurou
   * agente, e a versão anterior desta função o chamava de "automatico": a tela
   * afirmava que o robô estava cuidando de conversas que ninguém estava
   * respondendo — na primeira impressão, que é P0.
   */
  | { quem: "ninguem" }
  /** Ninguém: o automático saiu e nenhuma pessoa assumiu. É a fila. */
  | { quem: "aguardando" }
  /** Acabou. Nem pessoa nem automático têm o que fazer aqui. */
  | { quem: "encerrada" };

export type MotivoDoSilencio =
  /** Alguém assumiu. Ação: só devolver ao automático libera. */
  | "atendente_no_comando"
  /** `contacts.force_human` — vale para TODAS as conversas deste cliente. */
  | "contato_travado"
  /** Alguém pausou de propósito, ou o automático passou o caso para uma pessoa. */
  | "pausado"
  /** Janela deslizante do envio manual. Ação: NENHUMA — volta sozinho. */
  | "resposta_humana_recente"
  /**
   * `contacts.is_blocked` — o cliente pediu para sair. Ação: NENHUMA no
   * automático; quem decide reabrir é o cliente, não a equipe.
   */
  | "contato_descadastrado";

export interface ComandoDaConversa {
  comando: Comando;
  /** O automático responderia a próxima mensagem do cliente? */
  automaticoAtivo: boolean;
  /**
   * Existe uma TRAVA vigente a devolver — silêncio na conversa ou `force_human`
   * no contato.
   *
   * Não é o mesmo que `!automaticoAtivo`, e a diferença decide um botão. Uma
   * conversa ENCERRADA tem `automaticoAtivo: false` sem ter trava nenhuma: se o
   * botão de devolver saísse de `!automaticoAtivo`, ele apareceria em TODA
   * conversa fechada, e clicá-lo reabriria uma conversa que ninguém pediu para
   * reabrir. E o contrário também importa — a conversa fechada que ficou com uma
   * trava pendurada é justamente onde a volta mais falta, porque "Liberar" só
   * existe para o dono e a rota recusa quem não é.
   */
  travaVigente: boolean;
  /** Por que ele está calado. `null` quando está ativo. */
  motivo: MotivoDoSilencio | null;
  /**
   * Quando o silêncio se desfaz sozinho — só existe para
   * `resposta_humana_recente`. Nos outros motivos alguém tem de agir, e é a
   * diferença entre "espere" e "faça algo".
   */
  silencioAte: Date | null;
}

/** O literal que o PostgREST devolve para `timestamptz 'infinity'`. */
const INFINITO = "infinity";
/**
 * O gêmeo do INFINITO, e ele NÃO é silêncio.
 *
 * `new Date("-infinity")` também é `Invalid Date`, então sem este ramo ele cairia
 * no fallback de "data ilegível = calado" — e o Postgres, que é quem grava,
 * discorda: `'-infinity' > now()` é **false**. Enquanto a regra vivia só no
 * TypeScript a divergência não tinha como aparecer; a partir do momento em que o
 * banco calcula o mesmo comando, ela vira uma linha vermelha no espelho.
 * Quem está certo é o banco: `-infinity` é um instante no passado infinito, ou
 * seja, um silêncio que já venceu.
 */
const MENOS_INFINITO = "-infinity";

/**
 * `resolved` entra, e a razão de ele não estar aqui antes é uma pergunta
 * diferente: `CONVERSATION_TERMINAL_STATUSES` responde "o que o `exclude_finished`
 * esconde", enquanto este conjunto responde "quem manda". São vizinhos e não são
 * o mesmo — mas para a pergunta do comando, conversa resolvida é conversa que
 * acabou, e deixá-la de fora punha uma conversa resolvida e sem dono na Fila.
 * Medido em 2026-08-30: nenhum código de produção escreve
 * `conversations.status='resolved'` (só há leitores), então isto não muda nada
 * hoje — e passa a importar no instante em que o banco calcular o mesmo comando.
 */
const STATUS_ENCERRADOS = new Set(["closed", "archived", "resolved"]);

/**
 * O silêncio, lido do jeito que o Postgres o entrega.
 *
 * ## Um ramo só, e a razão é uma sabotagem que não pegou
 *
 * A primeira versão tinha DOIS caminhos: um `if (valor === INFINITO)` explícito e,
 * depois, um fallback para data ilegível. Apagar o primeiro deixou os 20 casos
 * VERDES — porque `new Date("infinity")` já é `Invalid Date` (medido), então o
 * fallback devolvia exatamente o mesmo resultado. Dois caminhos para uma saída é
 * um ramo que nenhum teste consegue distinguir: a guarda parecia existir e não
 * existia.
 *
 * Com um ramo só, a asserção de que `'infinity'` cala o automático volta a ter
 * dentes — trocá-la por "data ilegível = sem silêncio" reprova na hora.
 *
 * E a direção da falha é deliberada: valor que não sabemos ler é tratado como
 * CALADO. Dizer "o automático está ativo" em cima de um dado ilegível é a frase
 * tranquilizadora que a doutrina proíbe — falha fechada na ação, aberta na
 * informação. `INFINITO` fica nomeado porque é quem o leitor vem procurar.
 */
export function silencioVigente(
  valor: string | null | undefined,
  agora: Date,
): { vigente: boolean; duravel: boolean; ate: Date | null } {
  if (valor === null || valor === undefined) return { vigente: false, duravel: false, ate: null };
  if (valor === MENOS_INFINITO) return { vigente: false, duravel: false, ate: null };
  const ate = new Date(valor);
  if (valor === INFINITO || Number.isNaN(ate.getTime())) {
    return { vigente: true, duravel: true, ate: null };
  }
  return { vigente: ate.getTime() > agora.getTime(), duravel: false, ate };
}

export function comandoDaConversa(fatos: FatosDoComando, agora: Date = new Date()): ComandoDaConversa {
  const silencio = silencioVigente(fatos.bot_silenced_until, agora);
  const travado = fatos.force_human === true;
  const bloqueado = fatos.is_blocked === true;
  const encerrada = STATUS_ENCERRADOS.has(fatos.status);

  const comando: Comando = fatos.assigned_to_user_id
    ? {
        quem: "humano",
        userId: fatos.assigned_to_user_id,
        nome: fatos.assigned_to_user_name ?? null,
      }
    : encerrada
      ? { quem: "encerrada" }
      : // Sem dono: quem manda depende do automático estar de pé. Calado e sem
        // dono é a conversa que o automático escalou e ninguém pegou — a fila.
        silencio.vigente || travado || bloqueado
        ? { quem: "aguardando" }
        : fatos.automaticoDaOrg === false
          ? { quem: "ninguem" }
          : { quem: "automatico" };

  /**
   * Encerrada COM dono continua nomeando quem atendeu.
   *
   * A versão anterior colapsava para `encerrada` e apagava o nome — justamente na
   * aba "Fechadas", que é onde a pergunta "quem atendeu isto?" é a única que
   * importa. O produto não solta o dono ao fechar de propósito ("quem atendeu é
   * histórico"), e a tela estava jogando esse histórico fora. Que a conversa
   * acabou já é dito pelo selo de status, ao lado.
   */
  const comandoFinal: Comando = comando;

  const automaticoAtivo = !encerrada && !travado && !bloqueado && !silencio.vigente;

  const motivo: MotivoDoSilencio | null = automaticoAtivo
    ? null
    : encerrada
      ? null // Encerrada não é silêncio: é ausência de assunto. O estado já diz.
      : bloqueado
        ? // ANTES de `travado`, de propósito: quando as duas valem, é o opt-out que
          // decide a AÇÃO — não há nenhuma. Nomear a trava menor faria a tela
          // sugerir um "devolver" que o `stopGate` recusaria na sequência.
          "contato_descadastrado"
        : travado
          ? "contato_travado"
          : // Ordem importa: a trava do CONTATO é mais forte e mais ampla que a da
            // conversa, então ela nomeia o motivo mesmo havendo silêncio local —
            // senão a tela ofereceria "devolver ao automático" explicando o motivo
            // menor, e a pessoa clicaria esperando o efeito errado.
            silencio.duravel
            ? fatos.assigned_to_user_id
              ? "atendente_no_comando"
              : "pausado"
            : "resposta_humana_recente";

  return {
    comando: comandoFinal,
    automaticoAtivo,
    // `bloqueado` ANULA a trava devolvível: veja o comentário de `is_blocked` em
    // `FatosDoComando`. Devolver não desfaz opt-out, e o botão seria decorativo.
    travaVigente: (travado || silencio.vigente) && !bloqueado,
    motivo,
    silencioAte: motivo === "resposta_humana_recente" ? silencio.ate : null,
  };
}

/**
 * O que a tela ESCREVE para cada estado. Fica aqui, ao lado da regra, porque foi
 * ter duas listas em arquivos diferentes que fez a timeline e o banco divergirem
 * (ver o cabeçalho de `lib/leads/activity-vocabulary.ts`).
 *
 * A palavra do estado é **"automático"**, nunca "IA": ela já é contrato em quatro
 * arquivos (`ConversationHeader`, `BudgetCard`, `orcamento.ts`, `dicionario.ts`) e
 * está travada por `tests/unit/handoff-por-orcamento.test.ts`, cujo controle
 * NEGATIVO usa literalmente "Voltar para a IA" como a sabotagem que deve reprovar.
 */
export const ROTULO_DO_COMANDO: Record<Comando["quem"], string> = {
  humano: "Em atendimento",
  automatico: "Automático atendendo",
  ninguem: "Sem atendente",
  aguardando: "Aguardando atendente",
  encerrada: "Encerrada",
};

export const ROTULO_DO_MOTIVO: Record<MotivoDoSilencio, string> = {
  atendente_no_comando: "Automático pausado — alguém assumiu",
  contato_travado: "Automático pausado para este cliente",
  pausado: "Automático pausado",
  resposta_humana_recente: "Automático volta em instantes",
  contato_descadastrado: "Cliente pediu para não receber mensagens",
};

/**
 * O VOCABULÁRIO QUE O BANCO FALA — quatro, não cinco.
 *
 * `fn_comando_da_conversa` (migration 0202) devolve estes quatro. `ninguem` fica
 * de fora de propósito: ele não é um estado diferente, é o mesmo balde do
 * `automatico` renomeado quando a ORG não tem nenhum agente no ar — e "a org tem
 * automático?" é um fato org-wide que o SQL só saberia reproduzindo
 * `agenteAtende` inteiro dentro do banco. Seria a regra duplicada de novo, agora
 * numa terceira encarnação.
 *
 * Quem sabe o fato da org é o servidor, e ele o aplica escolhendo o CONJUNTO de
 * comandos que a aba pede — ver `comandosDaFila`.
 */
export const COMANDOS_DO_BANCO = ["humano", "automatico", "aguardando", "encerrada"] as const;
export type ComandoDoBanco = (typeof COMANDOS_DO_BANCO)[number];

/**
 * O QUE A ABA "FILA" PEDE, e é aqui que o fato org-wide entra.
 *
 * Numa org COM automático de pé, "precisa de uma pessoa agora" é `aguardando`: o
 * resto o robô atende. Numa org SEM automático nenhum, `automatico` não descreve
 * ninguém — não há robô — e essas conversas também estão esperando gente; deixá-las
 * fora faria a Fila de uma instalação recém-instalada nascer VAZIA com dezenas de
 * clientes sem resposta, que é o pior estado possível na primeira impressão.
 *
 * `undefined` ("não sei", leitura em andamento ou que falhou) segue a mesma
 * convenção do resto do arquivo: assume que HÁ automático. Errar para o lado de
 * mostrar menos na fila é recuperável em ~200ms; errar para o outro pinta 83
 * linhas de trabalho humano que não existe.
 */
export function comandosDaFila(automaticoDaOrg?: boolean): ComandoDoBanco[] {
  return automaticoDaOrg === false ? ["aguardando", "automatico"] : ["aguardando"];
}
