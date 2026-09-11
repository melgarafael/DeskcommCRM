/**
 * O QUE O SISTEMA CONFERE ANTES DE UMA MENSAGEM SAIR — em linguagem de quem
 * configura.
 *
 * ## Por que esta lista existe
 *
 * A cadeia de conferências roda em `lib/agent-engine/guardrails/before-send.ts` e
 * é boa: verificações ordenadas, veto instrutivo, trace por linha. Só que o dono do
 * negócio **não sabia que ela existia**. A spec 16 §3.3 chamou o papel de
 * "Segurança" e disse, com todas as letras, que o que faltava era *superfície* —
 * e o épico dos três papéis foi entregue com dois papéis na tela.
 *
 * Mecanismo invisível que funciona é pior do que não existir: quando ele barra
 * algo, a pessoa não sabe que foi barrado nem por quem; quando ele falha, falha
 * sem culpado. É o anti-exemplo escrito no invariante 6 da doutrina.
 *
 * ## Por que a lista é DUPLICADA aqui, e o que impede a duplicata de mentir
 *
 * `before-send.ts` importa `pg`, os stores de pacing/spinning e o adaptador de
 * canal. Importá-lo de um componente arrastaria o motor inteiro para o bundle do
 * browser. Então a apresentação vive aqui, pura.
 *
 * Duplicar uma constante de runtime numa lista de tela é exatamente como uma tela
 * passa a vender proteção que não roda — e o cabeçalho do próprio `before-send.ts`
 * registra que a cadeia já teve um guarda PROMETIDO E INEXISTENTE por meses. Por
 * isso `tests/unit/seguranca-lista-casa-com-a-cadeia.test.ts` importa a cadeia de
 * verdade (arquivo de teste pode importar `pg`) e reprova nos DOIS sentidos:
 * conferência que roda e não aparece, e conferência que aparece e não roda.
 *
 * ## A política: proteções determinísticas não se desligam, e isso não é rigidez
 *
 * Um botão só existe onde há escolha real. Desligar o que impede o número do
 * cliente de ser bloqueado, ou o que respeita quem pediu para parar, não é
 * preferência — é sabotagem do produto dele, e oferecer o controle já ensina que
 * é opcional. Onde não há escolha, a tela diz POR QUÊ em uma linha; onde há, ela
 * diz o CUSTO. Controle decorativo é pior que controle ausente.
 */

/** Uma conferência, como ela se apresenta a quem configura o agente. */
export interface ConferenciaDeSaida {
  /** O `name` do gate na cadeia — a chave que casa esta lista com o runtime. */
  nome: string;
  rotulo: string;
  /** O que se perde se ela não existisse. Uma frase, sem jargão. */
  oQueProtege: string;
  /**
   * `null` = não se desliga, e o texto diz por quê.
   * Objeto = há escolha real, e ela custa dinheiro — o custo vai na tela.
   */
  escolha: { custo: string } | null;
  /** Por que não se desliga. Vazio quando há escolha. */
  porQueNaoSeDesliga: string;
  /**
   * A chave da camada em `org_guardrail_layers`, quando há escolha.
   *
   * São DOIS vocabulários e eles não coincidem: aqui o nome é o do gate na cadeia
   * (`semantic_promise`), lá é o da camada configurável (`promessa_semantica`). O
   * vínculo é explícito porque casar um pelo outro por semelhança de nome é como
   * a tela deixa de encontrar o estado e mostra "carregando…" para sempre —
   * aconteceu ao escrever isto, e o teste de componente pegou.
   */
  camada: "promessa_semantica" | "jailbreak" | null;
}

/**
 * Na MESMA ORDEM em que rodam. A ordem é informação: a primeira que veta
 * interrompe a cadeia, então quem lê entende por que uma mensagem barrada no
 * `stop` nunca chega a ser avaliada pelas seguintes.
 */
export const CONFERENCIAS_DE_SAIDA: readonly ConferenciaDeSaida[] = [
  {
    nome: "stop",
    rotulo: "Respeitar quem pediu para parar",
    oQueProtege:
      "Se a pessoa respondeu STOP, SAIR ou pediu para não receber mais, nada é enviado a ela.",
    escolha: null,
    porQueNaoSeDesliga:
      "Quem pediu para parar tem o direito de ser deixado em paz — e insistir é infração, não estratégia.",
     camada: null,
  },
  {
    nome: "lgpd",
    rotulo: "Respeitar dados apagados e a base legal",
    oQueProtege:
      "Contato anonimizado a pedido não recebe mensagem, e prospecção sem base legal não sai.",
    escolha: null,
    porQueNaoSeDesliga: "É obrigação legal. Apagar dados é irreversível por desenho, e escrever para quem foi apagado desfaria isso.",
     camada: null,
  },
  {
    nome: "pacing",
    rotulo: "Segurar o ritmo de envio",
    oQueProtege:
      "Espaça as mensagens para o seu número não parecer robô e ser bloqueado pelo WhatsApp.",
    escolha: null,
    porQueNaoSeDesliga: "É o que impede seu número de ser bloqueado — e o número é o seu negócio.",
     camada: null,
  },
  {
    nome: "messaging_window",
    rotulo: "Respeitar a janela do WhatsApp",
    oQueProtege:
      "Fora da janela de 24 horas, só modelo aprovado sai — é o que o próprio WhatsApp permite.",
    escolha: null,
    porQueNaoSeDesliga:
      "Quem impõe é o WhatsApp, não nós. Desligar aqui não libera nada: a mensagem seria recusada lá, ou cobrada.",
     camada: null,
  },
  {
    nome: "spinning",
    rotulo: "Variar o texto das mensagens iguais",
    oQueProtege:
      "Evita mandar a mesma frase idêntica para muita gente, que é o padrão que denuncia disparo em massa.",
    escolha: null,
    porQueNaoSeDesliga: "Texto idêntico em massa é o gatilho de spam do WhatsApp — mesmo risco do ritmo de envio.",
     camada: null,
  },
  {
    nome: "promise",
    rotulo: "Não prometer preço ou prazo por conta própria",
    oQueProtege:
      "Barra a mensagem em que o assistente inventa desconto, valor ou data de entrega.",
    escolha: null,
    porQueNaoSeDesliga:
      "Uma promessa escrita obriga o seu negócio. A conferência é uma regra fixa, não custa nada e não tem troca a oferecer.",
     camada: null,
  },
  {
    nome: "semantic_promise",
    rotulo: "Conferir promessas em texto livre",
    oQueProtege:
      "Uma segunda leitura, feita por um modelo, para pegar a promessa escrita de um jeito que a regra fixa não reconhece.",
    escolha: { custo: "+1 consulta ao modelo por mensagem enviada" },
    porQueNaoSeDesliga: "",
    camada: "promessa_semantica",
  },
  {
    nome: "case_promise",
    rotulo: "Não prometer atendimento humano que não existe",
    oQueProtege:
      'Impede o "vou pedir para o responsável te ligar" quando nenhum chamado foi aberto de verdade.',
    escolha: null,
    porQueNaoSeDesliga:
      "É promessa que só você pode cumprir, e o cliente fica esperando. Regra fixa, sem custo.",
     camada: null,
  },
  {
    nome: "internal_vocabulary",
    rotulo: "Não falar a nossa língua com o seu cliente",
    oQueProtege:
      "Barra nome de ferramenta, nome de tabela e código de erro na mensagem que o cliente lê.",
    escolha: null,
    porQueNaoSeDesliga:
      "É a conferência que derrubou o vazamento medido de 30% para zero. Desligar reabre exatamente o defeito que ela existe para fechar.",
     camada: null,
  },
  {
    nome: "agenda_stall",
    rotulo: "Não prometer checar a agenda sem checar de verdade",
    oQueProtege:
      'Barra o "vou verificar/confirmar o horário" quando o assistente ainda não chamou a ' +
      "ferramenta de agenda nesta resposta — a promessa só sai depois de checar de verdade.",
    escolha: null,
    porQueNaoSeDesliga:
      "É a mesma promessa vazia do 'vou pedir pro responsável', só que sobre agenda: o cliente " +
      "fica esperando uma confirmação que nunca foi checada. Regra fixa, sem custo.",
    camada: null,
  },
  {
    nome: "academia_grade_stall",
    rotulo: "Não informar a grade sem consultar de verdade",
    oQueProtege:
      'Barra o “vou verificar a grade” e horários de aula sem que o assistente tenha consultado os dados cadastrados nesta resposta.',
    escolha: null,
    porQueNaoSeDesliga:
      "Evita deixar o cliente esperando ou informar um horário inventado quando a grade já pode ser consultada. Regra fixa, sem custo.",
    camada: null,
  },
  {
    nome: "disclosure",
    rotulo: "Dizer que é um assistente quando perguntam",
    oQueProtege: "Se o cliente pergunta se está falando com um robô, a resposta não pode enganar.",
    escolha: null,
    porQueNaoSeDesliga: "Esconder que é um assistente é enganar o cliente.",
     camada: null,
  },
];

/**
 * A conferência de ENTRADA, que não está na cadeia de saída.
 *
 * Ela roda antes, sobre o que o cliente escreveu, e por isso aparece à parte: a
 * lista acima é, literalmente, o que acontece entre o assistente escrever e a
 * mensagem sair. Misturá-las faria a ordem da cadeia deixar de ser verdade.
 */
export const CONFERENCIA_DE_ENTRADA: ConferenciaDeSaida = {
  nome: "jailbreak_detect",
  rotulo: "Detectar tentativa de manipular o assistente",
  oQueProtege:
    "Lê a mensagem que chega e reconhece quem está tentando fazer o assistente ignorar as suas instruções.",
  escolha: { custo: "+1 consulta ao modelo por mensagem recebida" },
  porQueNaoSeDesliga: "",
  camada: "jailbreak",
};
