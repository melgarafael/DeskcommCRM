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
  // PORTUGUÊS — a lista vai completa POR FORMA, não por sorte: infinitivo
  // (mandaR), 3ª pessoa do singular/plural (manda/mandam — quase todo pedido
  // vem assim: "vocês me mandam"), imperativo (mande/mandem) e subjuntivo
  // (mandes). A lista anterior tinha só algumas formas de cada verbo, e a
  // assimetria era o defeito: "pode me REMOVER da lista" caía fora porque
  // `remover` não estava lá, embora `remove` e `remova` estivessem.
  "mandar|manda|mandam|mande|mandem|mandes|" +
  "enviar|envia|enviam|envie|enviem|envies|" +
  "escrever|escreve|escrevem|escreva|escrevam|escrevas|" +
  "chamar|chama|chamam|chame|chamem|chames|" +
  "ligar|liga|ligam|ligue|liguem|ligues|" +
  "contatar|contata|contatam|contate|contatem|contates|" +
  "contactar|contacta|contactam|contacte|contactem|contactes|" +
  "procurar|procura|procuram|procure|procurem|procures|" +
  "incomodar|incomoda|incomodam|incomode|incomodem|incomodes|" +
  "importunar|importuna|importunam|importune|importunem|importunes|" +
  "perturbar|perturba|perturbam|perturbe|perturbem|perturbes|" +
  "encher|enche|enchem|encha|encham|enches|" +
  "insistir|insiste|insistem|insista|insistam|insistas|" +
  "falar|fala|falam|fale|falem|fales|" +
  "receber|recebe|recebem|receba|recebam|recebas|" +
  // espanhol — mesma âncora, outra língua. Sem eles "no quiero recibir mas
  // mensajes" não casa nenhum padrão e o pedido se perde.
  "recibir|recibe|reciben|reciban|recibas|" +
  "escribir|escribe|escriben|escriban|escribas|" +
  "llamar|llama|llaman|llamen|llames|" +
  "molestar|molesta|molestan|moleste|molesten|molestes|" +
  "mandes|manden|envies|envien|contactes|contacten";

/**
 * O QUE o cliente quer que seja removido — o OBJETO do verbo.
 *
 * "retire **meu contato** da lista", "apague **meu numero** do sistema".
 * Inclui `nome` de propósito: "tira meu nome da lista" é pedido claro, e o
 * objeto do verbo não é onde mora a ambiguidade.
 */
const ALVO_REMOVIDO =
  "contato|contatos|contacto|contactos|" +
  "numero|numeros|" +
  "nome|nomes|" +
  "telefone|telefonos|celular|celulares|" +
  "whatsapp|zap|dados|cadastro";

/**
 * DE ONDE o cliente quer sair — o DESTINO.
 *
 * Aqui `nome` e `email` FICAM DE FORA, e a diferença é medida: como destino,
 * "tira meu nome do e-mail" é mais provável ser pedido de correção de cadastro
 * do que descadastro. Como objeto do verbo (a lista acima) ele é inequívoco.
 * A mesma palavra muda de sentido conforme a posição — por isso são duas
 * listas, e não uma.
 *
 * `cancelar` fica fora do verbo pelo mesmo motivo: "quero cancelar o pedido" e
 * "posso cancelar a consulta de amanhã?" são do corpus NEGATIVO.
 */
const DE_ONDE =
  "lista|listas|cadastro|cadastros|base|bases|sistema|sistemas|" +
  "contatos|contactos|contato|contacto|" +
  "numero|numeros|telefone|telefonos|celular|celulares|whatsapp|zap";

/**
 * Verbos de remoção, completos por forma: infinitivo (tiraR), 3ª pessoa
 * (tira/tiram), imperativo (tire/tirem) e subjuntivo (tires). Mais o espanhol.
 *
 * A lista anterior tinha só algumas formas de cada verbo, e a assimetria era o
 * defeito: "pode me REMOVER da lista" caía fora porque `remover` não estava lá,
 * embora `remove` e `remova` estivessem.
 */
const VERBOS_DE_REMOCAO =
  "tirar|tira|tiram|tire|tirem|tires|" +
  "remover|remove|removem|remova|removam|removas|" +
  "retirar|retira|retiram|retire|retirem|retires|" +
  "excluir|exclui|excluem|exclua|excluam|excluas|" +
  "apagar|apaga|apagam|apague|apaguem|apagues|" +
  "deletar|deleta|deletam|delete|deletem|deletes|" +
  "descartar|descarta|descartam|descarte|descartem|descartes|" +
  "sacar|saca|sacame|sacarme|quitar|quita|quitame|quitarme|" +
  "eliminar|elimina|eliminame|eliminarme|borrar|borra|borrame|borrarme";

/** Possessivos e artigos que vêm entre o verbo e o alvo. */
const DETERMINANTES_DO_ALVO =
  "meu|minha|meus|minhas|o|a|os|as|nosso|nossa|seu|sua|seus|suas|mi|mis|tu|tus";

/** A preposição que liga o alvo ao destino — `de la`/`del` são o espanhol. */
const PREPOSICAO_DE_SAIDA =
  "da|das|do|dos|de|dessa|deste|desta|desses|dessas|de\\s+la|de\\s+los|de\\s+las|del|from";

/**
 * Freio do destino: `lista de espera` NÃO é descadastro.
 *
 * O espanhol já tinha este parêntese e o português não — assimetria, não
 * decisão. Quem escreve "tira da lista de espera" quer ser chamado, só não
 * agora.
 */
const FREIO_DO_DESTINO = "(?!\\s+de\\s+(?:espera|precos|preco|interesse|convidados|casamento))";

/**
 * Como se pede para "parar de falar comigo" — a LOCUÇÃO, não o verbo.
 *
 * "não entre em contato" não tem verbo de comunicação: `entre` é de ENTRAR, e o
 * pedido mora em `entrar em contato`. Medido: foi a forma que um cliente real
 * usou ("não entre mais em contato neste número") e não casava padrão nenhum.
 */
const VERBOS_DE_ENTRADA_EM_CONTATO =
  "entrar|entra|entram|entre|entrem|entres|" +
  "voltar|volta|voltam|volte|voltem|voltes|" +
  "fazer|faz|fazem|faca|facam|" +
  "vir|vem|venha|venham|" +
  // espanhol
  "contactar|contacte|contacten|comunicar|comunique|comuniquen";

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
  // ─── Imperativo negativo — "não me contate mais" ──────────────────────────
  //
  // Esta regra tinha a PRÓPRIA lista de verbos (`mande|manda|mandem|envie|
  // envia|enviem|chame|chama|ligue|liga`), copiada à mão e mais estreita que a
  // constante compartilhada. O resultado é que o pedido mais direto que existe
  // passava batido — medido com a função real:
  //
  //   ❌ "não me contate mais"     ❌ "não me contacte mais"
  //   ❌ "não me procure mais"     ❌ "não me incomode mais"
  //   ❌ "não me escreva mais"     ❌ "não me falar mais"
  //
  // Agora usa a MESMA `VERBOS_DE_COMUNICACAO` do resto do arquivo, com o `me`
  // opcional (o cliente escreve "não contate mais" tanto quanto "não me contate
  // mais") e o freio de `OBJETOS_NAO_COMUNICATIVOS` que já protegia a forma
  // "não me mande mais BOLETOS" — reclamação de cobrança, não descadastro.
  new RegExp(
    `\\bnao\\s+(?:me\\s+)?(?:${VERBOS_DE_COMUNICACAO})\\s+mais\\b` +
      `(?!\\s+(?:${DETERMINANTES_DE_OBJETO})?\\s*(?:${OBJETOS_NAO_COMUNICATIVOS})\\b)`,
    "u",
  ),
  // "não entre em contato", "não volte a entrar em contato", "não faça contato".
  // A locução, não o verbo: `entre` é de ENTRAR, e nenhuma lista de verbos de
  // comunicação o pegaria. Medido: foi a frase que um cliente real usou
  // ("não entre mais em contato neste número") e ela não casava nada.
  new RegExp(
    `\\bnao\\s+(?:${VERBOS_DE_ENTRADA_EM_CONTATO})\\s+(?:mais\\s+)?` +
      `(?:em\\s+|a\\s+)?(?:entrar\\s+em\\s+)?(?:contato|contacto)\\b`,
    "u",
  ),
  // ─── Remoção de um alvo — UMA régua para as três peças ────────────────────
  //
  //   [me]? + VERBO + [o que remover]? + preposição + DE ONDE
  //
  // Antes eram três padrões com listas escritas à mão, e cada um cobria uma
  // combinação exata — o que deixava passar o jeito mais comum de pedir.
  // Medido com a regex real, antes deste conserto:
  //
  //   ✅ "me tira da lista"                ❌ "pode me REMOVER da lista"
  //   ✅ "me remova da lista"              ❌ "retire MEU CONTATO da lista"
  //   ✅ "me retire da lista"              ❌ "remova meu numero da lista"
  //   ✅ "me exclua da lista"              ❌ "me tire DO CADASTRO"
  //
  // As causas eram três, todas de lista incompleta:
  //   1. INFINITIVO — havia `remove|remova|removam` e não `remover`.
  //   2. OBJETO EXPLÍCITO — o pronome `me` era OBRIGATÓRIO antes do verbo, e
  //      "retire MEU CONTATO da lista" não o tem.
  //   3. DESTINO — só "da lista" valia; "do cadastro" e "do sistema" ficavam fora.
  //
  // ⚠️ `(?:(?:${CONST})\s+)?` — o grupo em volta da CONSTANTE é obrigatório.
  // Sem ele, `\s+` casa só com a ÚLTIMA alternativa (a alternação tem
  // precedência menor que a concatenação): `(?:lista|cadastro|nome\s+)` deixava
  // "lista" sem o espaço, e o padrão inteiro parava de casar. Foi exatamente
  // esse erro que fez a primeira versão deste conserto não pegar nada.
  //
  // Os invasores — cada abertura é uma porta nova para falso positivo — têm
  // teste próprio e NENHUM bloqueia: "remove o produto do carrinho", "apaga a
  // luz", "tira meu nome do e-mail", "remove meu contato do grupo", "excluir
  // minha conta do banco", "tira da lista de espera".
  new RegExp(
    `\\b(?:me\\s+)?(?:${VERBOS_DE_REMOCAO})\\s+` +
      `(?:(?:${DETERMINANTES_DO_ALVO})\\s+)?` +
      `(?:(?:${ALVO_REMOVIDO})\\s+)?` +
      `(?:${PREPOSICAO_DE_SAIDA})\\s+` +
      `(?:${DE_ONDE})\\b` +
      FREIO_DO_DESTINO,
    "u",
  ),
  /\bsair\s+d(?:a|essa|esta)\s+lista\b/u,
  /\bcancelar?\s+(?:a\s+)?(?:inscricao|assinatura)\b/u,
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
  /\bcancelar\s+(?:la\s+)?(?:suscripcion|inscripcion)\b/u,
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
  /\bno\s+me\s+molest(?:e|en|es)\b/u,
];

/** A mensagem inteira é a palavra-chave (ignorando pontuação e emoji de borda). */
function ehPalavraIsolada(normalizado: string): boolean {
  const somenteLetras = normalizado.replace(/[^a-z]/gu, "");
  return PALAVRAS_DE_OPT_OUT.has(somenteLetras);
}

/**
 * É pedido de descadastro INEQUÍVOCO? Só este autoriza gravar `is_blocked` —
 * ver o cabeçalho deste arquivo sobre por que o ambíguo não entra aqui.
 */
export function ehPedidoDeOptOut(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const normalizado = normalizarTexto(texto.trim());
  if (normalizado === "") return false;
  if (ehPalavraIsolada(normalizado)) return true;
  return FRASES_DE_OPT_OUT.some((re) => re.test(normalizado));
}

/**
 * É pedido de descadastro INEQUÍVOCO **ou** sinal ambíguo de que a pessoa quer
 * parar? Sinal conservador do runtime: para de responder e escala; o bloqueio
 * real fica com o humano.
 */
export function ehOptOutProvavel(texto: string | null | undefined): boolean {
  if (!texto) return false;
  if (ehPedidoDeOptOut(texto)) return true;
  const normalizado = normalizarTexto(texto.trim());
  return FRASES_AMBIGUAS_DE_OPT_OUT.some((re) => re.test(normalizado));
}
