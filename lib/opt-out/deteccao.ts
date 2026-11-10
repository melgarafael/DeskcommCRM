/**
 * QUEM PEDIU PARA SAIR — a regra, num lugar só.
 *
 * ═══ POR QUE ESTE MÓDULO EXISTE ═══
 *
 * A mesma pergunta ("esta mensagem é um pedido de descadastro?") era respondida
 * por DUAS regras diferentes, e a pior delas era a que decidia o bloqueio:
 *
 *   - `lib/channels/pos-entrada.ts` usava `STOP_RX`, que caçava a PALAVRA em
 *     qualquer posição da frase. Ela grava `contacts.is_blocked` na INGESTÃO,
 *     antes do modelo — e a partir daí todo envio volta `contato_bloqueado`.
 *   - `lib/agent-engine/agent/human-handoff.ts` já fazia certo: palavra sozinha
 *     (mensagem inteira = a palavra) mais frases de opt-out em pt-BR.
 *
 * Medido numa clínica odontológica em produção, com a regex antiga:
 *
 *   "tem como parar a dor?"              → paciente BLOQUEADO
 *   "posso sair antes das 15h?"          → paciente BLOQUEADO
 *   "preciso sair mais cedo da consulta" → paciente BLOQUEADO
 *   "não quero mais receber nada"        → NÃO bloqueava (opt-out de verdade)
 *
 * Os dois erros são o mesmo erro: caçar a PALAVRA em vez da INTENÇÃO. E o
 * primeiro é o mais caro, porque falha em silêncio — a pessoa some da conversa
 * sem que ninguém saiba, e o motivo gravado (`stop_keyword`) parece legítimo.
 *
 * ═══ A REGRA: verbo de cessação + OBJETO DE COMUNICAÇÃO ═══
 *
 * "parar" só vira opt-out quando o que se pede para parar é a MENSAGEM. Por isso
 * todo padrão aqui exige o objeto — "parar de me mandar", "parar de receber",
 * "sair da lista" — ou a palavra ISOLADA, que é a convenção universal do canal.
 * Nunca a palavra solta no meio da frase: numa clínica, num pet shop ou numa
 * oficina, "parar" e "sair" são vocabulário do dia a dia do cliente.
 *
 * ═══ DOIS NÍVEIS, e a diferença importa ═══
 *
 * `ehPedidoDeOptOut` (INEQUÍVOCO) é o que autoriza gravar `is_blocked`: um
 * estado que só uma pessoa desfaz.
 *
 * `ehOptOutProvavel` soma os casos AMBÍGUOS ("me deixa em paz", "chega") e é o
 * sinal conservador do runtime: parar de responder já e escalar ao humano, que
 * confirma o bloqueio de verdade. Deixar o ambíguo bloquear sozinho inverteria
 * a política — quem tem o poder de silenciar alguém para sempre é a pessoa.
 */

/** minúsculas, sem acento — a forma sobre a qual todos os padrões daqui rodam. */
export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "");
}

/**
 * Palavra-chave enviada SOZINHA (mensagem inteira = a palavra) — a convenção
 * universal de descadastro em canais de mensagem. A comparação é feita sobre o
 * texto normalizado e sem pontuação de borda, para "STOP." e "SAIR!" contarem.
 */
export const PALAVRAS_DE_OPT_OUT: ReadonlySet<string> = new Set([
  "stop",
  "parar",
  "pare",
  "sair",
  "cancelar",
  "descadastrar",
  "remover",
  "unsubscribe",
  // ── espanhol ──────────────────────────────────────────────────────────────
  //
  // `baja` não é preferência de vocabulário: é a palavra que a PLANTILLA pede.
  // Medido numa instalação em espanhol — 6 das 9 definições aprovadas terminam
  // com "Respondé BAJA para no recibir más", todas da categoria MARKETING:
  //
  //   "Baja"                              14/08   bloqueado: NÃO
  //   "Doy de baja la pauta?"             12/08   bloqueado: NÃO
  //   "quiero dar de baja la suscripcion" 02/08   bloqueado: NÃO
  //
  // Três pessoas pediram, nenhuma foi atendida — e a promessa está escrita na
  // mensagem que a empresa mandou, com aprovação da plataforma. No canal onde
  // denúncia de spam derruba o quality rating e faz a plataforma recusar
  // definições novas: perde-se as aprovadas, não só a linha.
  //
  // `baja` sozinha É o pedido. "Doy de baja la pauta?" tem quatro palavras:
  // não bloqueia — é pergunta sobre pausar publicidade (o objeto é "la
  // pauta", fora de `suscripcion|lista|publicidad|promociones`, abaixo), não
  // pedido de descadastro. Este comentário chamava o resultado de "cai no
  // ambíguo"; estava errado — o espanhol não tinha UMA frase ambígua sequer
  // até este PR acrescentar as de baixo em `FRASES_AMBIGUAS_DE_OPT_OUT`. Cai
  // em NADA, e é onde deve cair: pergunta de negócio não é sinal de opt-out.
  "baja",
  "bajar",
  // `salir` é o `sair` em espanhol, e `sair` está nesta lista desde sempre —
  // faltar aqui era assimetria, não decisão. O CHANGELOG da 1.4.0 chegou a
  // prometer que "`baja`, `salir` e `no quiero recibir` descadastram"; medido
  // com as funções reais, `baja` e `no quiero recibir` devolviam `true` e
  // `salir` devolvia `false`. Quem respondesse a palavra solta continuava
  // recebendo — no idioma em que a plantilla é a fonte do pedido.
  //
  // Não alarga a regra: continua valendo só a palavra SOZINHA (mensagem inteira
  // = a palavra). "Voy a salir ahora" tem três palavras: não bloqueia — a
  // mesma proteção que faz "tem como parar a dor?" não bloquear paciente de
  // clínica. Cai em NADA, não em "ambíguo" — mesma correção do comentário de
  // `baja`, acima.
  "salir",
  "desuscribir",
  "desuscribirme",
]);

/**
 * Verbos que revelam que o objeto do pedido é a COMUNICAÇÃO, e não o tratamento,
 * a dor, o horário ou o trabalho da pessoa. É este trecho que separa "pare de me
 * mandar mensagem" de "tem como parar a dor?".
 */
const VERBOS_DE_COMUNICACAO =
  "mandar|manda|mande|mandem|enviar|envia|envie|enviem|receber|recebe|escrever|escreve|" +
  "chamar|chama|ligar|liga|perturbar|perturba|encher|enche|insistir|insiste|" +
  // espanhol — mesma âncora, outra língua. Sem eles "no quiero recibir mas
  // mensajes" não casa nenhum padrão e o pedido se perde.
  "recibir|recibe|escribir|escribe|escriban|molestar|molesta|llamar|llama|mandes|envien|" +
  // `contactar` faltava — "no me contacten más" e "deja de contactarme" não
  // casavam nenhum padrão, embora sejam pedido de descadastro tão direto
  // quanto "no me escriba".
  "contactar|contacta|contacte|contacten|contactes|" +
  // IMPERATIVO português (#1607). O padrão "não me X mais" tinha lista própria,
  // escrita à mão, e passou a ler esta constante — estas são as formas de
  // comando que ele precisa e que faltavam aqui (`contate` é a grafia
  // brasileira de `contacte`, que já estava acima). Só imperativo/subjuntivo,
  // de propósito: nenhuma cabe depois de "parar de", "deixar de" ou "no
  // quiero", que pedem infinitivo — os outros padrões que leem esta constante
  // não se alargam. Infinitivo novo aqui ("procurar", "falar") alarga o
  // "parar de …" e já produziu "vou parar de procurar outro dentista" bloqueado.
  "contate|contatem|chame|chamem|ligue|liguem|escreva|escrevam|perturbe|perturbem";

/**
 * Formas da constante acima que, depois de "não me", DESCREVEM outra pessoa em
 * vez de dar uma ordem: 3ª pessoa do indicativo, com sujeito que não é quem
 * escreve — "o convênio não me recebe mais", "a dor não me perturba mais", "a
 * doutora não me escreve mais a receita". O padrão "não me X mais" as recusa.
 *
 * `manda|envia|chama|liga` ficam DENTRO, e não por esquecimento: são também o
 * imperativo informal ("não me liga mais") e já bloqueavam antes do #1607.
 * Tirá-las seria regressão; acrescentar as de cá seria falso positivo novo.
 */
const FORMAS_DESCRITIVAS_DEPOIS_DE_ME = "recebe|escreve|perturba|enche|insiste|contacta";

/**
 * Objetos que aparecem depois de um verbo de comunicação mas NÃO são a
 * comunicação em si — pedido, fatura, orçamento, campanha publicitária.
 * Compartilhada entre português e espanhol: sem este lookahead, "parar de
 * mandar o pedido" ou "deja de mandar el pedido" bloqueariam um cliente
 * que está pedindo para CONTINUAR sendo atendido, só que sobre outro
 * assunto — o mesmo risco que o padrão de "não quero receber" já trata
 * para "ligação", só que agora no verbo de cessação em vez do verbo isolado.
 */
const OBJETOS_NAO_COMUNICATIVOS =
  "pedido|pedidos|encomenda|encomendas|pacote|pacotes|entrega|entregas|" +
  "fatura|faturas|boleto|boletos|cobranca|cobrancas|produto|produtos|" +
  "paquete|paquetes|envio|envios|factura|facturas|boleta|boletas|" +
  "cobro|cobros|producto|productos|pauta|pautas|presupuesto|presupuestos";

/**
 * Determinantes que podem vir entre o verbo e o objeto não comunicativo —
 * "o pedido", "el paquete". Compartilhado pt/es, e não só por DRY: os dois
 * padrões de cessação abaixo (`par(?:ar|a|e|em)` em português e
 * `dej(?:ar|a|e|en)|par(?:ar|a|e|en)` em espanhol) casam a MESMA forma
 * "pare"/"para" nos dois idiomas — "pare" é alcançado pela alternativa "e"
 * de AMBOS. Um lookahead só com determinantes de um idioma deixa "pare de
 * mandar o pedido" escapar pelo padrão espanhol, que não reconhece "o" como
 * determinante e portanto não vê o objeto excluído. Medido.
 */
const DETERMINANTES_DE_OBJETO =
  "o|a|os|as|el|los|la|las|meu|minha|meus|minhas|seu|sua|seus|suas|" +
  "mi|mis|tu|tus|esse|essa|esses|essas|ese|esa|esos|esas|nesse|nessa";

/**
 * Listas que são a MENSAGEM em si: contatos, transmissão, mensagens, promoções.
 * É a régua do freio de "lista qualificada": quando a frase nomeia "lista de
 * X", só vale se X for destas. "lista de espera" é paciente querendo ser
 * chamado; "lista de presentes" é compra; "lista de desejos" é vitrine.
 */
const LISTAS_DE_ENVIO =
  "contatos?|contactos?|transmissao|envios?|mensagens|disparos?|divulgacao|promocoes|" +
  "ofertas|whatsapp|zap|voces|vcs";

/**
 * O freio em si, numa forma só, porque as duas regras que o usam precisam dele
 * idêntico: "me tira da lista" já o tinha (o conserto do #1805) e "sair da
 * lista" estava SEM ele na main — "quero sair da lista de espera" bloqueava o
 * paciente (#1806). O lookahead lê de trás pra frente: ou não vem "de X"
 * nenhum, ou o X que vem é de envio.
 */
const FREIO_DE_LISTA_QUALIFICADA = `(?!\\s+de\\s+(?!(?:${LISTAS_DE_ENVIO})\\b))`;

/**
 * Pronomes que já são sujeito sozinhos, sem determinante: "ele não me liga
 * mais", "aquele não me manda mais nada".
 */
const PRONOMES_DE_SUJEITO = "ele|ela|eles|elas|aquele|aquela|aqueles|aquelas";

/**
 * Determinantes que ABREM um sujeito de 3ª pessoa antes de "não me X mais".
 * Lista PORTUGUESA escrita à parte, e não herdada de `DETERMINANTES_DE_OBJETO`:
 * aquela carrega o espanhol, e `tu`/`tus`/`mi`/`mis` herdados viravam sujeito
 * de 3ª pessoa sozinhos — "tu não me liga mais" é 2ª pessoa (a mesma classe de
 * "o senhor") e deixava de bloquear. Medido no #1825.
 *
 * São dois cargos diferentes e é por isso que a lista não é uma só: este
 * candidato a sujeito fica ANTES do "não me", e uma palavra só já basta para
 * ser sujeito ("o médico não me liga mais"); lá, o candidato a determinante
 * vem depois do verbo e precisa deixar passar "parar de mandar O PEDIDO".
 */
const DETERMINANTES_DE_SUJEITO =
  "o|a|os|as|meu|minha|meus|minhas|seu|sua|seus|suas|esse|essa|esses|essas|" +
  "nesse|nessa|do|da|dos|das|nosso|nossa|nossos|nossas|dele|dela|deles|delas";

/**
 * Palavras que podem ocupar a vaga de sujeito SEM SER sujeito de 3ª pessoa.
 * Duas famílias, e as duas são medidas.
 *
 * A primeira é preposição e conjunção: sem elas o freio casaria "a partir de
 * amanhã não me manda mais" como se "partir" fosse o sujeito — e aí a ordem
 * deixa de bloquear. Cada uma destas é uma frase medida no corpus do #1806.
 *
 * A segunda (#1825) é o que no português colado a "não me X" OCUPA o lugar
 * do sujeito sem descrever uma 3ª pessoa: tratamento de 2ª pessoa com verbo
 * de 3ª (`o senhor não me mande mais mensagem` casava como sujeito e isentava
 * a frase) e vocativo (`meu querido, não me manda mais nada` — quem fala é
 * quem escreve, não é terceiro descrito). Ambas deixavam a frase sem bloquear
 * e sem escalar.
 */
const NAO_ABRIM_SUJEITO =
  "de|da|do|das|dos|em|no|na|nos|nas|que|para|pra|pro|ate|desde|partir|apartir|" +
  "partindo|com|por|pelo|pela|ao|aos|e|mas|ja|quando|como|se|sem|entao|apos|logo|porque|" +
  // tratamento de 2ª pessoa, vocativo e afeto (#1825) — medido pelo
  // mantenedor: casam como sujeito e não são sujeito de 3ª pessoa.
  "senhor|senhora|sr|sra|deus|amor|querido|querida|moco|moca";

/**
 * "não me liga mais" é DUAS frases diferentes com a MESMA forma, e o verbo não
 * as separa: `liga` é o imperativo informal ("não me liga mais" = pedido) e é
 * também a 3ª pessoa do indicativo ("meu filho não me liga mais" = relato).
 * `manda`, `chama` e `envia` têm o mesmo duplo sentido — e é por isso que
 * ficaram FORA de `FORMAS_DESCRITIVAS_DEPOIS_DE_ME` (ver o comentário de lá:
 * tirá-las seria regressão, acrescentá-las seria falso positivo novo).
 *
 * O que separa os dois, portanto, é o SUJEITO — e ele vem ANTES de "não me".
 * Este lookahead exige que não haja sujeito explícito de 3ª pessoa colado ali:
 * pronome sozinho (`ele não me liga mais`) ou sintagma nominal com determinante
 * (`meu filho não me liga mais`, `o médico não me liga mais`, `a minha mae não
 * me chama mais`). Ele fica DENTRO de um `(?!...)`, de modo que só é cobrado
 * para as quatro formas ambíguas: nas imperativas sem duplo sentido
 * (`nao me mande mais`, `nao me contate mais`) não há o que separar.
 *
 * Medido (#1806): sem o lookahead, "meu filho não me liga mais" gravava
 * `is_blocked` num paciente que só estava conversando; com ele, "não me liga
 * mais" sozinho continua bloqueando. Os dois casos estão como controles
 * negativos em `tests/unit/opt-out-deteccao.test.ts`.
 *
 * O `{0,2}` cobre "meu filho" (uma palavra), "meu antigo chefe" (duas) e o
 * pronome sem determinante (zero). O zero é SÓ do pronome: determinante
 * sozinho não é sujeito, e com `{0,2}` para os dois "meu não me liga mais" (o
 * "meu" interjeição, sem vírgula) casava e deixava de bloquear. Por isso são
 * duas alternativas, e o determinante exige `{1,2}` (#1825). Entre o sujeito e "não me" NÃO cabe
 * pontuação (#1825): em português o sujeito não se separa do verbo por
 * vírgula, e o que vem ali é quase sempre VOCATIVO — "minha filha, não me
 * liga mais" é a filha pedindo, não a filha descrita. Havia um `[,;:]*` ali e
 * ele isentava justamente esta frase. E as palavras do meio não podem ser
 * preposição — é `NAO_ABRIM_SUJEITO` que impede "a partir de amanhã não me
 * mande mais" de casar, e também que "o senhor" e "meu amor" casem como
 * sujeito de 3ª pessoa.
 *
 * O sujeito precisa ABRIR a mensagem ou a oração (`^` ou pontuação antes,
 * #1825). Sem essa âncora, numa mensagem sem pontuação — o normal no WhatsApp —
 * o FIM da oração anterior era lido como sujeito: "vou bloquear o numero não me
 * liga mais" casava "o numero" e o pedido deixava de bloquear e de escalar.
 * O custo aceito é o lado fechado: "ah meu filho não me liga mais" bloqueia.
 *
 * O `\b` da direita faz questão: ele impede que o determinante seque o começo
 * de uma palavra. Sem o de direita, "a partir de amanhã" casava pegando o `a` de
 * "amanhã" e deixando "manha" na caixa de palavras do meio — a ordem de
 * amanhã deixava de bloquear, que era um falso negativo NOVO. Medido.
 */
const SUJEITO_EXPLICITO_DE_TERCEIRA_PESSOA =
  `(?<=(?:^|[.!?,;:])\\s*(?:` +
  `(?:${PRONOMES_DE_SUJEITO})\\b\\s*(?:(?!(?:${NAO_ABRIM_SUJEITO})\\b)[a-z]+\\s+){0,2}|` +
  `(?:${DETERMINANTES_DE_SUJEITO})\\b\\s*(?:(?!(?:${NAO_ABRIM_SUJEITO})\\b)[a-z]+\\s+){1,2}` +
  `)nao\\s+me\\s+)`;

/**
 * Pedidos INEQUÍVOCOS de descadastro escritos por extenso. Todos exigem o objeto
 * de comunicação; nenhum casa a palavra solta.
 *
 * ⚠️ Ao acrescentar um padrão aqui, teste-o contra as frases do dia a dia de uma
 * CLÍNICA, e não só contra o caso que você quer pegar: é assim que o falso
 * positivo entra. As frases de controle vivem em
 * `tests/unit/opt-out-deteccao.test.ts` e reprovam o CI.
 */
const FRASES_DE_OPT_OUT: readonly RegExp[] = [
  // "pare de me mandar", "parar de receber", "para de mandar mensagem" — mas
  // NÃO "pare de mandar o pedido nesse endereço": o padrão ancorava só no
  // VERBO ("mandar"), e "mandar" é verbo de comunicação mesmo quando o
  // OBJETO é outra coisa. Medido: sem o lookahead, esta frase de e-commerce
  // bloqueava um cliente pedindo para mudar a ENTREGA — o mesmo defeito que
  // este arquivo existe para impedir ("tem como parar a dor?"), só que
  // introduzido pela própria regra que consertou o primeiro caso. O
  // lookahead (OBJETOS_NAO_COMUNICATIVOS) é o mesmo que já protege o
  // padrão de cessação espanhol, abaixo.
  new RegExp(
    `\\bpar(?:ar|a|e|em)\\s+de\\s+(?:me\\s+)?(?:${VERBOS_DE_COMUNICACAO})\\b` +
      `(?!\\s+(?:${DETERMINANTES_DE_OBJETO})?\\s*(?:${OBJETOS_NAO_COMUNICATIVOS})\\b)`,
    "u",
  ),
  // "não quero (mais) receber" — mas "não quero receber ligação, só whatsapp" é
  // troca de canal, não descadastro: quem diz isso QUER continuar no WhatsApp.
  /\bnao\s+(?:quero|desejo|gostaria)\s+(?:de\s+)?(?:mais\s+)?receber\b(?!\s+(?:ligacao|ligacoes|chamada|chamadas|telefonema|telefonemas|telefone)\b)/u,
  /\bnao\s+quero\s+receber\s+mais\b/u,
  /\bnao\s+quero\s+mais\s+(?:mensagem|mensagens|contato|nada\s+de\s+voces)\b/u,
  // "não me mande mais" — mas NÃO "não me mande mais boletos": esta regra
  // ancorava só no VERBO, e mandar é verbo de comunicação mesmo quando o
  // objeto é uma cobrança. Bloqueava um cliente que está RECLAMANDO e quer
  // continuar sendo atendido, com o objeto escrito na própria frase.
  //
  // É a mesma classe que o lookahead de `OBJETOS_NAO_COMUNICATIVOS` já
  // resolvia no padrão de cessação ("parar de mandar o pedido"), e que ficou
  // sem ele aqui — conserto por instância, não por classe. Esta é a forma
  // mais COMUM das duas: "não me mande mais X" é como se reclama direto.
  //
  // A lista de verbos deste padrão era escrita à mão (`mande|manda|…|liga`) e
  // mais estreita que `VERBOS_DE_COMUNICACAO`: "não me contate mais" não
  // bloqueava (#1607). Agora lê a constante. O `me` é OBRIGATÓRIO — é ele que
  // diz que o objeto é quem escreve: "o dente não incomoda mais" e "o carro não
  // liga mais" não têm `me` e não bloqueiam. E `incomodar` não é verbo de
  // comunicação: "a dor não me incomoda mais" também não.
  //
  // E agora também o SUJEITO (#1806). `manda|chama|liga|envia` são imperativo
  // informal E 3ª pessoa do indicativo, e esta regra enxergava as duas como a
  // mesma ordem: "meu filho não me liga mais" virava `is_blocked` — relato de
  // paciente, não pedido de descadastro. O lookahead isenta a frase quando há
  // sujeito explícito de 3ª pessoa antes de "não me" — e lê SÓ as quatro
  // formas ambíguas, `manda|chama|liga|envia`. Nas imperativas sem duplo
  // sentido (`nao me mande mais`, `nao me contate mais`) não há o que
  // separar, e com sujeito elas seguem bloqueando: "o senhor não me mande
  // mais mensagem" é pedido, não relato (#1825).
  new RegExp(
    `\\bnao\\s+me\\s+(?!(?:${FORMAS_DESCRITIVAS_DEPOIS_DE_ME})\\b)` +
      `(?!(?=${SUJEITO_EXPLICITO_DE_TERCEIRA_PESSOA})(?:manda|chama|liga|envia)\\s+mais\\b)` +
      `(?:${VERBOS_DE_COMUNICACAO})\\s+mais\\b` +
      `(?!\\s+(?:${DETERMINANTES_DE_OBJETO})?\\s*(?:${OBJETOS_NAO_COMUNICATIVOS})\\b)`,
    "u",
  ),
  // "não entre (mais) em contato", "parem de entrar em contato comigo" (#1607).
  // A locução não tem verbo de comunicação — `entre` é de ENTRAR —, então
  // nenhuma lista de verbos a alcançava. Só o imperativo (`entre|entrem`):
  // "o médico não entra mais em contato" é reclamação, não pedido.
  //
  // O lookahead é o mesmo precedente de "não quero receber ligação, só
  // whatsapp": `com <outra pessoa>` e `por <outro canal>` mudam o destinatário
  // ou o canal, não pedem para sair — "não entre em contato com meu marido,
  // fale comigo" QUER continuar sendo atendida. `comigo` não casa `com\b`, e
  // "por aqui/este/esse" é o próprio canal.
  new RegExp(
    `\\b(?:nao\\s+(?:entre|entrem)\\s+(?:mais\\s+)?|nao\\s+(?:volte|voltem)\\s+a\\s+entrar\\s+|` +
      `(?:par|deix)(?:ar|a|e|em)\\s+de\\s+entrar\\s+)em\\s+contato\\b` +
      `(?!\\s+(?:com|pel[oa]|via)\\b|\\s+por\\s+(?!(?:aqui|est[ea]|ess[ea])\\b))`,
    "u",
  ),
  // "me tira da lista" — e, desde o #1607, o infinitivo: "pode me REMOVER da
  // lista" não bloqueava porque só `remove|remova|removam` estavam aqui.
  //
  // O `me` segue obrigatório e a lista precisa ser a de ENVIO: se vem "lista de
  // X", X tem de ser comunicação. "me tira da lista de espera" é paciente
  // querendo ser chamado, e bloqueava; "tira da lista de presentes" é compra.
  new RegExp(
    "\\bme\\s+(?:tira|tire|tirem|tirar|remove|remova|removam|remover|retira|retire|retirar|" +
      "exclui|exclua|excluir|apaga|apague|apagar)\\s+(?:da|dessa|desta|de\\s+sua|da\\s+sua)\\s+lista\\b" +
      FREIO_DE_LISTA_QUALIFICADA,
    "u",
  ),
  // "sair da lista" tinha EXATAMENTE o freio que o padrão de cima ganhou no
  // #1805 — só que ele não veio junto. "quero sair da lista de espera" gravava
  // `is_blocked` num paciente que só queria ser chamado (#1806), enquanto "me
  // tira da lista de espera", a mesma frase com outro verbo, já não bloqueava.
  // As duas leem hoje a MESMA constante (`LISTAS_DE_ENVIO`), que é o que torna
  // impossível uma voltar a divergir da outra.
  new RegExp(`\\bsair\\s+d(?:a|essa|esta)\\s+lista\\b${FREIO_DE_LISTA_QUALIFICADA}`, "u"),
  // "cancelar a inscrição" — e NÃO "cancelar a assinatura" (#2886). A palavra
  // `assinatura` saiu daqui para as ambíguas, abaixo, pelo mesmo motivo que a
  // `subscricao` de Portugal saiu no #2343: ela serve às DUAS coisas, sair das
  // mensagens e cancelar o plano do produto, e bloqueava quem só perguntava
  // "posso cancelar a assinatura e voltar depois?" (medido: `is_blocked` gravado
  // e nenhuma resposta depois).
  //
  // `inscricao` FICA, e não por esquecimento: medida na #2886, ela tem o mesmo
  // formato de defeito ("posso cancelar a inscrição e voltar depois?" grava
  // `is_blocked`), mas movê-la obriga a reverter uma guarda de INGESTÃO que hoje
  // a fixa bloqueando (`tests/unit/pos-entrada-efeitos-do-canal.test.ts`), e o
  // recorte desta fatia é `assinatura`/`suscripcion`. A medição dela está na
  // evidência da issue como medida-e-não-movida, com o número.
  /\bcancelar?\s+(?:a\s+)?inscricao\b/u,
  // ...mas "cancelar a assinatura DAS MENSAGENS" nomeia o objeto de
  // comunicação, e aí bloqueia na hora — a regra do cabeçalho. A ambígua lá
  // embaixo só cobre a frase SEM objeto. Vale também para a `subscricao` de
  // Portugal (#2872), que tinha o mesmo buraco. "do whatsapp" e "de vocês"
  // ficam DE FORA de propósito: também podem ser o plano, então seguem só
  // escalando para uma pessoa.
  /\bcancelar?\s+(?:a\s+)?(?:minha\s+)?(?:assinatura|subscricao)\s+(?:d(?:as|essas|estas)\s+(?:mensagens|notificacoes|promocoes|ofertas|novidades)|d(?:os|esses|estes)\s+(?:avisos|disparos|envios)|d(?:a|essa|esta)\s+newsletter)\b/u,
  // ── PORTUGUÊS DE PORTUGAL: o pronome vem PRESO ao verbo, DEPOIS dele ──────
  //
  // Em pt-PT o pronome átono é ENCLÍTICO ("remova-me da lista"), enquanto o
  // pt-BR o põe ANTES do verbo ("me remova da lista"). O padrão de cima já
  // cobria a forma brasileira; a forma de cá não casava padrão NENHUM, embora
  // seja a construção normal de quem escreve de Portugal — a mesma assimetria
  // que o espanhol tinha com o pronome preso ao infinitivo ("escribirme").
  //
  // O verbo sozinho não basta (a lição do cabeçalho): o pedido só existe com o
  // objeto de ENVIO depois do pronome — "remova-me da lista de contactos",
  // "excluam-me da lista de envios". "remova-me a dúvida sobre o prazo" e
  // "removam-me da lista de espera" continuam fora, pelo mesmo freio de lista
  // qualificada e pela mesma régua do #1607 — ver os controles negativos em
  // `tests/unit/opt-out-deteccao.test.ts`. `contacto(s)` é a grafia de Portugal
  // de contato(s): sem ela, "retirem-me da lista de contactos" não passaria o
  // freio (a lista só tinha a palavra brasileira). E "contactos" sozinho, sem
  // "lista", NÃO entra: a forma brasileira também exige "lista", e "remova-me
  // dos contatos do fornecedor" bloqueava aqui o que "me remova dos contatos do
  // fornecedor" não bloqueia lá.
  new RegExp(
    "\\b(?:tira|tire|tirem|tirar|remove|remova|removam|remover|retira|retire|retirem|retiram|retirar|" +
      "exclui|exclua|excluam|excluir|apaga|apague|apaguem|apagar|elimina|elimine|eliminem|eliminar)" +
      "-(?:me|nos)\\s+(?:d[ao]s?|dessa|desta|de\\s+sua|da\\s+sua)\\s+" +
      `lista\\b${FREIO_DE_LISTA_QUALIFICADA}`,
    "u",
  ),
  /\b(?:me\s+)?descadastr\w*\b/u,
  /\bdescadastro\b/u,
  // ── espanhol ──────────────────────────────────────────────────────────────
  //
  // Mesma regra das de cima: TODAS exigem o objeto de comunicação. Sem isso
  // "no quiero recibir la factura por aqui, manda por email" bloquearia um
  // cliente que está pedindo justamente para CONTINUAR sendo atendido.
  // O `(?!…)` é o mesmo recurso que a regra portuguesa usa para "ligação": o
  // verbo sozinho não basta, porque o OBJETO pode ser outro. Medido — sem ele,
  // "no quiero recibir la factura por aqui, manda por email" bloqueava um
  // cliente que está pedindo justamente para CONTINUAR sendo atendido.
  new RegExp(
    `\\bno\\s+(?:quiero|deseo)\\s+(?:mas\\s+)?(?:${VERBOS_DE_COMUNICACAO})\\b` +
      "(?!\\s+(?:la|el|los|las|mi|mis)?\\s*(?:factura|facturas|boleta|boletas|presupuesto|" +
      "presupuestos|recibo|recibos|comprobante|comprobantes|llamada|llamadas|contrato|contratos)\\b)",
    "u",
  ),
  /\bno\s+quiero\s+recibir\s+mas\b/u,
  // "no quiero más mensajes/publicidad/promociones" — o objeto é um
  // SUBSTANTIVO, não um verbo, e por isso não casava no padrão de cima
  // (que exige verbo de comunicação depois de "no quiero"). Espelho direto
  // de "não quero mais mensagem/contato" em português: faltava por
  // assimetria, não por decisão.
  /\bno\s+quiero\s+mas\s+(?:mensajes?|publicidad|promociones|nada\s+de\s+ustedes)\b/u,
  // Imperativo com pronome preso — "dame de baja" é como a pessoa responde
  // de fato à própria plantilla que pede "Respondé BAJA". `dar de baja`
  // (sem pronome) segue de fora de propósito: sem objeto, é a frase que o
  // corpus de testes marca como ambígua/fora de escopo (pausar campanha),
  // não pedido de descadastro.
  /\b(?:dame|deme|denme|danos)\s+de\s+baja\b/u,
  // "no quiero que me contacten" — outra estrutura para o mesmo pedido que
  // a extensão de `contacte|contacten|contactes` acima já cobre na forma
  // "no me contacten mas".
  /\bno\s+quiero\s+que\s+me\s+contact(?:e|en|es)\b/u,
  // Remoção de "contactos" ou "base de datos" — mesma família da regra de
  // `lista`, abaixo, mas objeto diferente: quem pede isto não está trocando
  // de assunto, está pedindo para ser esquecido.
  /\b(?:borrame|borrar|eliminame|elimina|sacame|quitame)\s+de\s+(?:tus\s+|mis\s+|la\s+)?(?:contactos|base\s+de\s+datos)\b/u,
  // Espelho exato da regra portuguesa acima, com o mesmo lookahead e pelo
  // mesmo motivo: "no me manden mas cobros duplicados" é reclamação de
  // cobrança, não pedido de descadastro.
  new RegExp(
    `\\bno\\s+me\\s+(?:escriba|escriban|escribas|mande|manden|mandes|llame|llamen|contacte|contacten|contactes)\\s+mas\\b` +
      `(?!\\s+(?:${DETERMINANTES_DE_OBJETO})?\\s*(?:${OBJETOS_NAO_COMUNICATIVOS})\\b)`,
    "u",
  ),
  // "deja de escribirme", "para de mandarme mensajes" — o pronome PRESO ao
  // infinitivo ("escribirme"), diferente do português, onde ele vem solto
  // ANTES do verbo ("de me mandar"). Sem o sufixo opcional, a construção
  // mais comum de pedir descadastro em espanhol não casava padrão nenhum.
  // Mesmo lookahead de objeto não comunicativo do padrão português de
  // "parar de", acima — o risco de capturar o objeto errado é o mesmo nos
  // dois idiomas.
  new RegExp(
    `\\b(?:dej(?:ar|a|e|en)|par(?:ar|a|e|en))\\s+de\\s+` +
      `(?:${VERBOS_DE_COMUNICACAO})(?:me|nos|le|les)?\\b` +
      `(?!\\s+(?:${DETERMINANTES_DE_OBJETO})?\\s*(?:${OBJETOS_NAO_COMUNICATIVOS})\\b)`,
    "u",
  ),
  // "dar de baja" já É o pedido — a plantilla usa a palavra nesse sentido.
  /\b(?:dar|darme|doy)\s+de\s+baja\s+(?:la\s+)?(?:suscripcion|lista|publicidad|promociones)\b/u,
  /\bdarme\s+de\s+baja\b/u,
  /\bme\s+desuscrib\w*\b/u,
  // `lista` sozinha vale, MENOS quando o que vem depois diz que é outra lista.
  // Medido: sem a exclusão, "sacame de la lista de espera" bloqueava alguém que
  // quer continuar sendo atendido.
  /\b(?:sacame|sacar|quitame|quitar|borrame|borrar|elimina|eliminame)\s+de\s+(?:la\s+)?lista\b(?!\s+de\s+(?:espera|precios|invitados))/u,
  /\bsalir\s+de\s+(?:la\s+)?lista\b(?!\s+de\s+(?:espera|precios|invitados))/u,
  // Espelho exato do português acima: `suscripcion` saiu para as ambíguas
  // (#2886) porque em espanhol também serve às duas coisas — "cancelar la
  // suscripcion" é o plano, e bloqueava quem só perguntava. `inscripcion` fica
  // pelo mesmo motivo de `inscricao` lá em cima.
  /\bcancelar\s+(?:la\s+)?inscripcion\b/u,
  // E o espelho da forma com objeto: "cancelar la suscripción a los mensajes"
  // bloqueia na hora; "cancelar la suscripción" sozinha só escala.
  /\bcancelar\s+(?:la\s+|mi\s+)?suscripcion\s+(?:a|de)\s+(?:los|estos|tus|sus)\s+(?:mensajes|promociones|ofertas)\b/u,
];

/**
 * Frases AMBÍGUAS: sugerem que a pessoa quer parar, sem nomear a mensagem. Não
 * autorizam bloqueio — autorizam parar de responder e chamar um humano.
 */
const FRASES_AMBIGUAS_DE_OPT_OUT: readonly RegExp[] = [
  /\bme\s+deixa?\s+(?:em\s+paz|quieto|quieta)\b/u,
  /\bja\s+(?:disse|falei)\s+que\s+nao\s+(?:quero|tenho\s+interesse)\b/u,
  /\bnao\s+(?:me\s+)?interessa\s+mais\b/u,
  /\bpara\s+com\s+isso\b/u,
  // "cancelar a subscrição" (pt-PT, #2343) escala e NÃO bloqueia. Em Portugal
  // a palavra serve às duas coisas: sair das mensagens E cancelar o plano do
  // ginásio ou da revista — "posso cancelar a subscrição e voltar depois?" é
  // cliente a perguntar sobre o produto, e `is_blocked` o deixaria sem
  // resposta. Sem o objeto de comunicação, o humano decide.
  /\bcancelar?\s+(?:a\s+)?(?:minha\s+)?subscric(?:ao|oes)\b/u,
  // "cancelar a assinatura" (pt-BR, #2886) — a MESMA decisão da subscrição de
  // Portugal acima, e pela mesma razão: a palavra serve às duas coisas. "quero
  // cancelar a assinatura da revista" é cliente a falar do PLANO dele, e o
  // bloqueio o deixaria sem resposta — a academia, a revista ou o SaaS perde o
  // cliente que só queria saber como pausar. Medido com as funções da main:
  //   "posso cancelar a assinatura e voltar depois?"  bloqueia=true
  //   "quero cancelar a assinatura da revista"        bloqueia=true
  //   "cancelar la suscripcion" (espanhol, abaixo)    bloqueia=true
  // Aqui escala para um humano, que decide o bloqueio de verdade — o custo
  // aceito (campanhas seguem até alguém decidir) está na #2886.
  /\bcancelar?\s+(?:a\s+)?(?:minha\s+)?assinatura\b/u,
  // ── espanhol ──────────────────────────────────────────────────────────────
  //
  // Esta lista tinha ZERO entradas em espanhol. Não por decisão: o ambíguo é
  // uma segunda lista, com curadoria própria, e ninguém a preencheu quando o
  // espanhol entrou — o comentário de `baja`/`salir` acima chegou a AFIRMAR
  // que certas frases "caem no ambíguo" sem que essa lista tivesse uma
  // entrada em espanhol capaz de pegá-las. Efeito medido: em espanhol,
  // `ehOptOutProvavel` nunca soma nada além do inequívoco —
  // `detectAmbiguousOptOut` (o runtime do agente) nunca escala um cliente de
  // fala espanhola, por mais claro que o sinal seja.
  /\b(?:dejame|dejenme)\s+en\s+paz\b/u,
  /\bya\s+(?:te\s+)?dije\s+que\s+no\s+(?:quiero|me\s+interesa)\b/u,
  // "ya no me interesa" / "no me interesa mas" — e NÃO "no me interesa" nu.
  //
  // O que faz desta frase um sinal de opt-out não é a recusa: é a marca de
  // REPETIÇÃO. "No me interesa" sozinho é a objeção comercial mais comum do
  // funil — "no me interesa ese plan, pero sí el otro", "no me interesa,
  // gracias" —, e o agente precisa seguir vendendo ali, não parar e escalar.
  // Com os dois trechos opcionais, sete frases de objeção medidas passavam a
  // escalar; com um dos dois marcadores exigido, nenhuma. E as 89 frases do
  // corpus deste arquivo não mudam de veredito: as duas formas que ele testa
  // ("ya no me interesa", "ya te dije que no me interesa") têm marcador.
  //
  // É o espelho exato do português, que sempre exigiu o "mais":
  // `/\bnao\s+(?:me\s+)?interessa\s+mais\b/` — a assimetria era o defeito.
  /\b(?:ya\s+no\s+me\s+interesa|no\s+me\s+interesa\s+mas)\b/u,
  /\b(?:ya\s+basta|basta\s+ya)\b/u,
  // "cancelar la suscripcion" — o espelho espanhol de "cancelar a assinatura"
  // (#2886). Mesma palavra para o plano do produto e para as mensagens: quem
  // pergunta "puedo cancelar la suscripcion?" quer resposta, não `is_blocked`.
  // A forma com OBJETO segue bloqueando na hora — "dar de baja la suscripcion"
  // e "quiero dar de baja la suscripcion" continuam em `FRASES_DE_OPT_OUT`.
  /\bcancelar\s+(?:la\s+|mi\s+)?suscripcion\b/u,
  /\bno\s+me\s+molest(?:e|en|es)\b/u,
];

/** A mensagem inteira é a palavra-chave (ignorando pontuação e emoji de borda). */
function ehPalavraIsolada(normalizado: string): boolean {
  const somenteLetras = normalizado.replace(/[^a-z]/gu, "");
  return PALAVRAS_DE_OPT_OUT.has(somenteLetras);
}

/**
 * ─── A ASSINATURA DA ATENDENTE NA PRIMEIRA LINHA (#3078, ajustada no #3158) ──
 *
 * Num WhatsApp Business com vários atendentes, a assinatura é prefixada ao
 * texto — a mensagem chega assim:
 *
 *   *Amanda Nobre:*
 *   PARAR
 *
 * A decisão lia o texto INTEIRO: `*amanda nobre:*\nparar` faz `ehPalavraIsolada`
 * colar as letras ("amandanobreparar", fora do conjunto) e nenhuma frase de
 * `FRASES_DE_OPT_OUT` casa — o pedido se perdia. Efeito medido no relato
 * (1.85.0): o contato não era bloqueado, o card não ia para perdido e a IA
 * respondia — quem pediu para sair seguia recebendo prospecção (risco de
 * denúncia do número e de LGPD, art. 18).
 *
 * O recorte NÃO é regra nova: a assinatura muda o TEXTO analisado, e o pedido
 * continua julgado pela MESMA régua — palavra sozinha ou frase de
 * `FRASES_DE_OPT_OUT`. Nenhuma palavra duvidosa vira inequívoca aqui, e o
 * limiar que grava `is_blocked` não se move.
 *
 * ─── O AJUSTE DO #3158: a marca da assinatura é o NEGRITO + DOIS PONTOS ──────
 *
 * A primeira versão aceitava também a forma SEM asteriscos (`Nome:` com até 4
 * palavras) e julgava SÓ o recortado. Medido pelo mantenedor com 28 frases (o
 * mesmo corpus desta seção de teste), os dois detalhes erravam dos dois lados:
 *
 *   `Consulta de amanhã:` + `cancelar`   → bloqueava (rótulo curto lido como
 *   `Pedido 123:` + `cancelar`              assinatura; o resto vira a palavra
 *   `Sua mensagem:` + `PARAR`               isolada e o contato é silenciado
 *   `Dúvida:`/`Remédio:` + `parar?`         para sempre por um rótulo)
 *   `*Não quero mais receber*` + `obrigado` → NÃO bloqueava (a primeira linha É
 *   `*Pare de me mandar mensagem*` + `chato`   o pedido e o recorte a jogava
 *   `Não quero mais receber:` + `obrigado`     fora, sobrando só "obrigado")
 *
 * São 9 frases × as duas funções = 18 resultados que mudavam de veredito contra
 * a `main` (medido, ver o comentário do PR #3158). Duas decisões desfazem as 18:
 *
 *   1. só o NEGRITO do WhatsApp Business é assinatura, e ele termina em dois
 *      pontos — `*Amanda Nobre:*`, `*Amanda Nobre*:`. Sem asteriscos, `Nome:` é
 *      um rótulo qualquer ("Consulta de amanhã:") e deixa de ser assinatura; a
 *      forma sem dois pontos (`*Não quero mais receber*`) é uma FRASE em
 *      negrito, não um nome — ela nem chega a ser recortada;
 *   2. quem julga é sempre o par: o texto ORIGINAL **ou** o recortado, e basta
 *      um dos dois bloquear. É o item 2 que sustenta o item 1 — sem ele, jogar
 *      fora a primeira linha apagaria o pedido que VIVE nela.
 *
 * Limites declarados (não são silêncio, são escolha):
 *   - um rótulo em negrito com dois pontos (`*Remédio:*` + `parar?`) continua
 *     sendo lido como assinatura e bloqueia. Estruturalmente é idêntico a um
 *     nome em negrito (`*Ana:*`); separar os dois exigiria um dicionário de
 *     nomes próprios. Custo aceito: prefere-se o bloqueio (falso positivo) à
 *     perda do pedido de quem assina — os dois erros estão medidos nesta seção;
 *   - a primeira linha em negrito SEM dois pontos (`*Amanda Nobre*` + `PARAR`)
 *     e o rótulo sem asteriscos (`Amanda Nobre:` + `PARAR`) deixam de ser
 *     assinatura. Quando o que vem depois é uma FRASE de pedido, nada se perde
 *     (o texto original é julgado também); o que se perde é só a palavra
 *     solta depois de um rótulo sem a marca de assinatura. É a troca que
 *     desfaz os 5 falsos positivos: a assinatura real do relato tem o negrito.
 */

/**
 * A primeira linha é uma ASSINATURA de atendente?
 *
 * A marca é o NEGRITO do WhatsApp Business MAIS os dois pontos do rótulo, com
 * a linha INTEIRA (nada antes, nada depois — o chamador já passou `trim`):
 *   `*Amanda Nobre:*` / `*Amanda Nobre*:` — dois pontos dentro ou fora dos
 *     asteriscos. É a forma que a issue #3078 descreve e a que o relato traz;
 *   `*Dra. Amanda Nobre:*` — o ponto de abreviação do nome não atrapalha: o que
 *     se exige é o `:` do rótulo, não a ausência de `.`.
 *
 * Ficam de fora, de propósito (#3158):
 *   - `Nome:` SEM asteriscos — era aqui que "Consulta de amanhã:" e "Dúvida:"
 *     viravam assinatura e o contato era silenciado por um rótulo;
 *   - `*Não quero mais receber*` — negrito SEM dois pontos: é uma frase em
 *     negrito, e recortá-la comia o próprio pedido.
 */
function ehAssinaturaDaAtendente(linha: string): boolean {
  if (linha === "") return false;
  return /^\*[^*\n]+:\*:?$/u.test(linha) || /^\*[^*\n]+\*:$/u.test(linha);
}

/**
 * O texto SEM a assinatura da atendente na primeira linha — pura e pequena,
 * para rodar na ENTRADA de toda decisão que hoje olha o texto cru.
 *
 * Limites do recorte, medidos com os casos de `opt-out-deteccao.test.ts`:
 *   - só recorta quando a primeira linha INTEIRA é uma assinatura E existe
 *     texto DEPOIS dela. Mensagem de UMA linha só é preservada — é o que
 *     mantém `*PARAR:*` sozinho bloqueando (recortar devolveria vazio e o
 *     pedido morreria), e o que protege uma mensagem legítima de duas linhas
 *     cujo começo não é assinatura (`Bom dia\nvamos falar amanha`);
 *   - o RESTO é devolvido intacto: o recorte não decide nada, só tira o ruído
 *     da frente;
 *   - o texto ORIGINAL continua sendo julgado junto com o recortado (#3158):
 *     quem decide é `ehPedidoDeOptOut`/`ehOptOutProvavel`, e eles olham os dois.
 */
export function semAssinaturaDaAtendente(texto: string): string {
  const quebra = texto.indexOf("\n");
  if (quebra === -1) return texto;
  const resto = texto.slice(quebra + 1);
  if (resto.trim() === "") return texto;
  return ehAssinaturaDaAtendente(texto.slice(0, quebra).trim()) ? resto : texto;
}

/**
 * A régua de UM texto: a palavra sozinha ou uma frase de `FRASES_DE_OPT_OUT`.
 * É a mesma régua de sempre — não sabe nada sobre assinatura.
 */
function ehPedidoInequivoco(texto: string): boolean {
  const normalizado = normalizarTexto(texto.trim());
  if (normalizado === "") return false;
  if (ehPalavraIsolada(normalizado)) return true;
  return FRASES_DE_OPT_OUT.some((re) => re.test(normalizado));
}

/** A régua do AMBÍGUO sobre um texto — o irmão conservador de cima. */
function ehSinalAmbiguo(texto: string): boolean {
  const normalizado = normalizarTexto(texto.trim());
  if (normalizado === "") return false;
  return FRASES_AMBIGUAS_DE_OPT_OUT.some((re) => re.test(normalizado));
}

/**
 * É pedido de descadastro INEQUÍVOCO? Só este autoriza gravar `is_blocked` —
 * ver o cabeçalho deste arquivo sobre por que o ambíguo não entra aqui.
 *
 * Julga os DOIS textos e basta UM bloquear (#3158):
 *   - o ORIGINAL, para o pedido que VIVE na primeira linha em negrito
 *     (`*Não quero mais receber*` + `obrigado`) — o recorte o apagaria;
 *   - o RECORTADO, para o pedido que vem depois da assinatura
 *     (`*Amanda Nobre:*` + `PARAR`) — o texto cru cola as letras e não casa
 *     nada.
 * O `ou` é obrigatório: cada texto cobre o erro do outro, e é ele que permite
 * estreitar o que conta como assinatura sem perder pedido nenhum.
 */
export function ehPedidoDeOptOut(texto: string | null | undefined): boolean {
  if (!texto) return false;
  return ehPedidoInequivoco(texto) || ehPedidoInequivoco(semAssinaturaDaAtendente(texto.trim()));
}

/**
 * É pedido de descadastro INEQUÍVOCO **ou** sinal ambíguo de que a pessoa quer
 * parar? Sinal conservador do runtime: para de responder e escala; o bloqueio
 * real fica com o humano. Mesmo par de textos de `ehPedidoDeOptOut` (#3158).
 */
export function ehOptOutProvavel(texto: string | null | undefined): boolean {
  if (!texto) return false;
  if (ehPedidoDeOptOut(texto)) return true;
  return ehSinalAmbiguo(texto) || ehSinalAmbiguo(semAssinaturaDaAtendente(texto.trim()));
}

/**
 * As palavras de saída que o rodapé das abordagens OFERECE ao cliente ("Responda
 * PARAR" e suas versões). Subconjunto de `PALAVRAS_DE_OPT_OUT` — o vocabulário
 * continua num lugar só; aqui só se escolhe quais dessas palavras, no INÍCIO da
 * mensagem, já dizem a que ela veio.
 */
const PALAVRAS_DE_SAIDA_DO_RODAPE: ReadonlySet<string> = new Set(["parar", "pare", "stop", "baja"]);

/**
 * A mensagem COMEÇA com a palavra de saída? ("Parar não é daqui", "Pare de me
 * mandar", "STOP!")
 *
 * NÃO autoriza bloqueio — para isso só há `ehPedidoDeOptOut`, e ele exige a
 * palavra sozinha ou uma frase inteira: "Parar não é daqui" não passa nele, e é
 * por isso que este contato ficou sem bloqueio e recebeu o texto de "passei seu
 * pedido para um atendente humano". Serve a UMA decisão: qual frase o cliente lê
 * quando a IA sai de campo por outro motivo (clima ruim) logo depois de uma
 * mensagem assim — quem começa a resposta com "parar" não quer ouvir sobre
 * atendente, quer ouvir que o pedido foi entendido.
 *
 * Só o INÍCIO conta: "tem como parar a dor?" é uma pergunta de paciente, não um
 * pedido de saída (o mesmo cuidado de `FRASES_DE_OPT_OUT`).
 */
export function comecaComPalavraDeSaida(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const normalizado = normalizarTexto(texto.trim());
  const primeira = normalizado.match(/[a-z]+/u)?.[0];
  if (primeira === undefined) return false;
  if (!PALAVRAS_DE_SAIDA_DO_RODAPE.has(primeira) || !PALAVRAS_DE_OPT_OUT.has(primeira)) return false;
  // "Pare de mandar o pedido nesse endereço", "Parar de tomar o remédio faz mal?":
  // "<palavra> de …" e pergunta já têm dono — a regra de cessação com objeto
  // de comunicação. Delega a ela em vez de decidir pela primeira palavra.
  if (/^[^a-z]*[a-z]+\s+de\b/u.test(normalizado) || normalizado.includes("?")) {
    return ehOptOutProvavel(texto);
  }
  return true;
}
