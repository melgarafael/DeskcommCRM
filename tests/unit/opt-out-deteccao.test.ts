/**
 * A CALIBRAÇÃO DO OPT-OUT, congelada.
 *
 * Este arquivo existe porque a regra anterior errava dos DOIS lados, e cada lado
 * falha de um jeito diferente:
 *
 *   - falso POSITIVO ("tem como parar a dor?" → bloqueado) some em silêncio: a
 *     pessoa deixa de receber e ninguém descobre, porque o motivo gravado
 *     (`stop_keyword`) parece legítimo;
 *   - falso NEGATIVO ("não quero mais receber" → não bloqueava) é pedido de LGPD
 *     ignorado.
 *
 * As duas listas abaixo são o corpus: frases de atendimento brasileiro real
 * (clínica, comércio, serviços). Acrescentar padrão em `lib/opt-out/deteccao.ts`
 * sem rodar isto é como o defeito volta.
 */
import { describe, expect, it } from "vitest";

import {
  comecaComPalavraDeSaida,
  ehOptOutProvavel,
  ehPedidoDeOptOut,
  semAssinaturaDaAtendente,
} from "@/lib/opt-out/deteccao";

/** Pedidos de descadastro que PRECISAM ser respeitados (bloqueiam o contato). */
const PEDE_PARA_SAIR = [
  "STOP",
  "stop",
  "PARAR",
  "Parar.",
  "sair",
  "SAIR!",
  "unsubscribe",
  "descadastrar",
  "pode parar de mandar mensagem",
  "para de me mandar isso",
  "pare de me enviar essas mensagens",
  "quero parar de receber",
  "não quero mais receber nada de vocês",
  "nao quero receber mais",
  "não me mande mais mensagens",
  // CONTROLE do lookahead da #435, lado português.
  "nao me mandem mais mensagens",
  "nao me ligue mais",
  "me tira dessa lista",
  "me remove da lista por favor",
  // CONTROLE do lookahead novo: continua bloqueando quando o objeto É a
  // comunicação — o lookahead exclui só a lista fechada de objetos não
  // comunicativos, não apaga o padrão inteiro.
  "pare de mandar essas fotos",
  "quero sair da lista",
  "quero cancelar a inscrição",
  "me descadastra aí",
  // ─── Formas que passavam batido (medido por @deskcommopp4s-cmd, #1607) ─────
  //
  // INFINITIVO — "pode me remover da lista" é como se pede de fato; a lista de
  // verbos tinha `remove|remova` e não `remover`.
  "pode me remover da lista",
  "me retirar da lista",
  "me excluir da lista",
  "me apagar da lista",
  "gostaria de me remover da lista",
  // IMPERATIVO NEGATIVO — o padrão "não me X mais" tinha lista própria, mais
  // estreita que a constante compartilhada. E a locução "entrar em contato"
  // não existia em lista nenhuma: `entre` é de ENTRAR, não de comunicar.
  "não entre mais em contato neste numero",
  "nao entre em contato comigo",
  "nao me contate mais",
  "nao me contacte mais",
  "nao me escreva mais",
  "nao me perturbe mais",
  "nao volte a entrar em contato",
  // Variações das três formas, com a regra estreitada do #1607: `me`
  // obrigatório, imperativo, e lista de ENVIO.
  "Não me contate mais!",
  "por favor nao me contate mais",
  "nao me contatem mais",
  "nao me chame mais",
  "nao entrem mais em contato",
  "parem de entrar em contato comigo",
  "pare de entrar em contato",
  "nao entre mais em contato por aqui",
  "me tira da lista de transmissão",
  "me remove da lista de contatos",
  // MESMA CLASSE, outro verbo: "sair da lista" é o irmão de "me tira da
  // lista" e no #1806 estava sem o freio — só o segundo pedia lista de ENVIO.
  "quero sair da lista de transmissão",
  "sair da lista de contatos",
  "quero sair dessa lista de mensagens",
  // a imperativa de terceira pessoa segue bloqueando quando NÃO há sujeito:
  // é a frase que os controles negativos abaixo precisam proteger.
  "não me liga mais",
  "por favor não me liga mais",
  // ─── A isenção por sujeito alcançava pedido que NÃO é ambíguo (#1825) ─────
  //
  // Medido pelo mantenedor com a função real: com o lookahead lendo a
  // constante de verbos INTEIRA e com `[,;:]*` entre o sintagma e "não me",
  // as frases abaixo davam `ehPedidoDeOptOut = false` E `ehOptOutProvavel =
  // false` — nem bloqueavam nem escalavam para humano. Na main, todas
  // bloqueavam.
  //
  // vírgula depois do sintagma marca VOCATIVO: em português o sujeito não se
  // separa do verbo por vírgula, e quem vem ali é com quem se fala, não a
  // pessoa descrita — "minha filha, não me liga mais" é a filha pedindo.
  "minha filha, não me liga mais",
  "meu filho, não me liga mais",
  "meu querido, não me manda mais nada",
  // tratamento de 2ª pessoa com verbo de 3ª: casa como sujeito de 3ª pessoa
  // e não é — é ordem dada a quem se está escrevendo.
  "o senhor não me mande mais mensagem",
  "a senhora não me manda mais mensagem",
  "o sr não me mande mais mensagem",
  "a sra não me manda mais mensagem",
  // imperativa SEM duplo sentido, com sujeito: `contate` nunca é 3ª pessoa do
  // indicativo, então não há o que separar — a isenção não alcança aqui.
  "meu filho não me contate mais",
  // o sujeito precisa ABRIR a mensagem ou a oração (#1825): sem pontuação, o
  // normal no WhatsApp, o fim da oração anterior ("o numero", "o plano") era
  // lido como sujeito e o pedido nem bloqueava nem escalava. Na main, todas
  // bloqueavam.
  "vou bloquear o numero não me liga mais",
  "já cancelei o plano não me manda mais mensagem",
  "não tenho interesse nesse produto não me manda mais",
  "odeio esse spam não me manda mais",
  "vou denunciar essa empresa não me manda mais nada",
  // `tu` é 2ª pessoa, a mesma classe de "o senhor": não abre sujeito de 3ª.
  "tu não me liga mais",
  // determinante SOZINHO não é sujeito (#1825): o "meu" interjeição, sem
  // vírgula, abria sujeito com zero palavras e isentava o pedido.
  "meu não me liga mais",
  "Meu não me manda mais nada",
];

/** Frases do dia a dia que usam a palavra e NÃO são pedido de descadastro. */
const NAO_PEDE_PARA_SAIR = [
  // e-commerce — o padrão de cessação ancorava só no VERBO ("mandar"), e
  // "mandar" é verbo de comunicação mesmo quando o objeto é outra coisa.
  // Bloquearia um cliente pedindo para mudar a ENTREGA.
  "pare de mandar o pedido nesse endereco",
  "para de mandar a fatura por aqui",
  // MESMA CLASSE, outra construção: "não me mande mais X" ancorava só no
  // verbo, como o padrão de cessação acima ancorava. O lookahead de
  // OBJETOS_NAO_COMUNICATIVOS estava num e faltava no outro — e este é o mais
  // comum dos dois, porque é como se reclama direto (issue #435).
  "nao me mande mais boletos",
  "nao me mande mais faturas por email",
  "nao me mandem mais cobrancas duplicadas",
  "nao me envie mais os produtos errados",
  // clínica — o caso que motivou este arquivo
  "tem como parar a dor?",
  "dá pra parar o sangramento em casa?",
  "quero parar o tratamento por enquanto",
  "posso sair antes das 15h?",
  "preciso sair mais cedo da consulta",
  "vou ter que sair do trabalho pra ir aí",
  "o remédio fez a dor parar",
  // comércio e serviços
  "quero cancelar o pedido",
  "posso cancelar a consulta de amanhã?",
  "vocês vão parar no feriado?",
  "que horas vocês param de atender?",
  // ─── CONTROLE NEGATIVO de `assinatura` (#2886) ────────────────────────────
  //
  // O corpus não tinha UMA frase negativa para `assinatura`: só o positivo, que
  // esta fatia moveu para as ambíguas. Sem estes casos, alguém "consertaria" o
  // falso positivo alargando o padrão de bloqueio até casar qualquer coisa com
  // a palavra, e a suíte seguiria verde. Aqui `assinatura` é o PLANO ou a
  // FATURA, nunca o canal de mensagens: nenhuma bloqueia — e nenhuma ESCALA
  // (o describe do lado negativo cobre o escalar, abaixo; sem ele a frase
  // cairia no ambíguo e desligaria a automação na pergunta de preço).
  "quanto custa a assinatura anual?",
  "o valor da assinatura aumentou este mês",
  "quando vence a assinatura do meu plano?",
  "a assinatura renova sozinha ou preciso avisar?",
  // colagem — o defeito da versão com `\b` ASCII, que já tinha sido corrigido
  "amanhã ele sairá do escritório e pararão as obras",
  "a obra pararia se chovesse",
  // ─── Invasores das aberturas do #1607 (@deskcommopp4s-cmd) ────────────────
  //
  // remover/apagar/tirar aparecem, mas o OBJETO não é a comunicação com o
  // cliente. Nenhuma bloqueia.
  "remove o produto do carrinho",
  "tira meu nome do e-mail",
  "remove meu contato do grupo",
  "apaga a luz quando sair",
  "retire o item da sacola",
  "excluir minha conta do banco",
  "me tira uma duvida",
  "posso remover o produto",
  "retirei o pedido ontem",
  "vou remover o app",
  "tira da lista de espera",
  // A locução `entrar em contato` também é afirmativa na vida real: quem MARCA
  // um contato não está pedindo para sair dele.
  "nao vou poder entrar em contato hoje",
  "vou entrar em contato amanha",
  "quando voces vao entrar em contato?",
  "nao consegui entrar em contato ontem",
  // ─── O que o #1607 bloqueava a mais: clínica, oficina, loja ──────────────
  //
  // Medido na triagem do #1607 — todas `false` na main e `true` no PR. Cada
  // grupo é uma abertura que a regra NÃO fez:
  //
  // sem `me`, o sujeito não é quem escreve (3ª pessoa descritiva)
  "o dente nao incomoda mais",
  "o implante nao incomoda mais",
  "o carro nao liga mais",
  "meu celular nao liga mais",
  "o pix nao recebe mais",
  "meu filho nao fala mais comigo",
  "a caneta nao escreve mais",
  // com `me`, mas `incomodar` não é verbo de comunicação — e as formas
  // descritivas da constante (`FORMAS_DESCRITIVAS_DEPOIS_DE_ME`) ficam fora
  "a dor nao me incomoda mais",
  "a dor nao me perturba mais",
  "o convenio nao me recebe mais",
  "a doutora nao me escreve mais a receita",
  // infinitivo novo na constante alargaria o "parar de …"
  "vou parar de procurar outro dentista",
  "pode parar de falar da cirurgia?",
  "para de falar besteira kkk",
  // remoção sem `me`, ou com destino que não é lista de envio
  "ja exclui do celular",
  "apaga do whatsapp aquela foto",
  "remove do sistema a consulta de amanha",
  "tira da base do dente",
  "remove da lista de desejos",
  "tira da lista de presentes",
  "me tira da lista de espera",
  "me tira da lista de presentes",
  "me remove da lista de desejos",
  // #1806 (1): "sair da lista" não tinha o freio que "me tira da lista"
  // ganhou no #1805. "lista de espera" é paciente querendo ser chamado e a
  // frase gravava `is_blocked` — o MESMO defeito, com outro verbo.
  "quero sair da lista de espera",
  "quero sair dessa lista de presentes",
  "sair da lista de desejos",
  "quero sair da lista de espera, pode ser?",
  // #1806 (2): `liga` é imperativo informal E 3ª pessoa do indicativo. Sem
  // sujeito explícito a ordem bloqueia (acima); COM sujeito é relato de quem
  // está falando, não pedido de descadastro. Os casos abaixo são controles
  // negativos do mesmo freio. O controle COM vírgula saiu daqui no #1825: a
  // vírgula marca vocativo, não sujeito, e a frase passou a bloquear — está
  // em `PEDE_PARA_SAIR`.
  "meu filho não me liga mais",
  "ele não me liga mais",
  "ela não me manda mais nada",
  "a doutora não me chama mais",
  "a minha equipe não me liga mais",
  "meu antigo chefe não me liga mais",
  // o sujeito abre a oração depois da saudação: segue sendo relato (#1825).
  "oi, meu filho não me liga mais",
  // "entrar em contato" com outro destinatário ou outro canal, e a reclamação
  "nao entre em contato com meu marido, fale comigo",
  "nao entrem em contato por email, so whatsapp",
  "vou parar de entrar em contato com o fornecedor",
  "o medico nao entra mais em contato",
  // vazios
  "",
  "   ",
];

/**
 * ─── ESPANHOL, e por que ele não é "mais um idioma" ─────────────────────────
 *
 * `baja` é a palavra que a PLANTILLA pede. Medido numa instalação real: 6 das 9
 * definições aprovadas terminam com "Respondé BAJA para no recibir más", todas
 * de categoria MARKETING. Três clientes pediram e nenhum foi atendido, porque a
 * lista só tinha português e inglês.
 *
 * A promessa está escrita na mensagem que a empresa manda, com aprovação da
 * plataforma — e é no canal onde denúncia de spam derruba o quality rating e faz
 * a plataforma recusar definições NOVAS. Perde-se as aprovadas, não só a linha.
 *
 * Os casos negativos são metade do valor: a âncora em verbo de comunicação é o
 * que impede o falso positivo NOVO, e sem ela "no quiero recibir la factura por
 * aqui" bloquearia um cliente que está pedindo para CONTINUAR sendo atendido.
 */
const ESPANHOL_PEDE_PARA_SAIR = [
  "BAJA",
  "Baja",
  "baja.",
  "darme de baja",
  "dar de baja la suscripcion",
  "quiero dar de baja la suscripcion",
  // Pronome PRESO ao infinitivo — a construção mais comum de pedir
  // descadastro em espanhol, e a que não casava padrão nenhum até este PR.
  // Diferente do português, onde o pronome vem solto ANTES do verbo.
  "deja de escribirme",
  "dejen de mandarme mensajes",
  "deja de enviarme promociones",
  "para de escribirme",
  "para de mandarme mensajes",
  "deja de escribirme por favor",
  "deja de escribir",
  // Objeto SUSTANTIVO em vez de verbo — "no quiero más mensajes" não tem
  // verbo de comunicação depois de "no quiero", então o padrão geral (que
  // exige verbo) não pega. Espelho de "não quero mais mensagem/contato".
  "no quiero mas mensajes",
  "no quiero mas publicidad",
  "ya no quiero mas promociones",
  "no quiero mas nada de ustedes",
  // Imperativo com pronome preso — como a pessoa responde de fato à
  // plantilla "Respondé BAJA".
  "dame de baja",
  "denme de baja",
  // `contactar`, que faltava na lista de verbos de comunicação.
  "no me contacten mas",
  // CONTROLE do lookahead da #435: quando o objeto É a comunicação, a regra
  // segue valendo. O lookahead exclui uma lista fechada, não apaga o padrão.
  "no me manden mas mensajes",
  "no me escriban mas",
  "no me llamen mas",
  "no quiero que me contacten",
  "borrame de tus contactos",
  "eliminame de la base de datos",
  // `salir` é o `sair` em espanhol, e `sair` já estava na lista em português.
  // Faltava, e a promessa do CHANGELOG da 1.4.0 ("`baja`, `salir` e
  // `no quiero recibir` descadastram") era falsa exatamente nesta palavra —
  // medido com as funções reais antes do conserto: `baja` true, `salir` false.
  "salir",
  "SALIR",
  "Salir.",
  "no quiero recibir mas mensajes",
  "no quiero recibir más mensajes",
  "por favor no me escriban mas",
  "me desuscribo",
  "sacame de la lista",
];

const ESPANHOL_NAO_PEDE = [
  // O caso que motivou os três estados: cliente ATIVO perguntando sobre pausar
  // o anúncio dele. Bloqueá-lo tiraria as mensagens de quem está comprando.
  "Doy de baja la pauta?",
  "che, la baja temporada nos mato las ventas",
  "necesito rebajar el precio",
  "Y el abuelo subiendo y bajando bolsones",
  "puedo cancelar el turno del martes?",
  // Troca de canal, não descadastro — o mesmo raciocínio da regra de "ligação".
  "no quiero recibir la factura por aqui, manda por email",
  // Outra lista. Quem escreve isto QUER continuar sendo atendido.
  "sacame de la lista de espera",
  // CONTROLE de `salir`: a palavra só vale SOZINHA. Sem estes casos, alguém
  // poderia "consertar" o positivo com um `includes("salir")` e a suíte ficaria
  // verde bloqueando quem só avisou que vai sair de casa.
  "voy a salir ahora",
  "puedo salir mas temprano?",
  "el pedido va a salir hoy?",
  // CONTROLE do lookahead novo de OBJETOS_NAO_COMUNICATIVOS: o mesmo achado
  // de "pare de mandar o pedido" (português), em espanhol. Sem o lookahead,
  // "deja de mandar el pedido a esa dirección" bloquearia um cliente que
  // está pedindo para mudar a ENTREGA, não para parar de ser atendido.
  "deja de mandar el pedido a esa direccion",
  "deja de cobrarme el envio",
  // O espelho espanhol da issue #435 — o objeto é a cobrança, não a conversa.
  "no me manden mas cobros duplicados",
  "no me manden mas facturas por correo",
  "no me manden mas paquetes a esa direccion",
  "no me mande mas boletas, ya pague",
  // OBJEÇÃO COMERCIAL — o buraco que faltava neste corpus, e por onde um
  // falso positivo entrou. `ESPANHOL_NAO_PEDE` tinha controle de clínica, de
  // e-commerce e de troca de canal, mas nenhum da recusa de VENDA: a frase
  // mais comum do funil, e a que o agente precisa contornar em vez de fugir
  // dela. Sem estes casos, `no me interesa` nu escalava para humano e a
  // suíte ficava verde.
  "no me interesa",
  "no me interesa, gracias",
  "no me interesa ese plan, pero si el otro",
  "por ahora no me interesa, quizas el mes que viene",
  "no me interesa el seguro, quiero solo el producto",
  "la verdad no me interesa el precio, me interesa la calidad",
  "no me interesa pagar mas, hay algo mas barato?",
  // CONTROLE NEGATIVO de `suscripcion` (#2886) — espelho do controle de
  // `assinatura` em `NAO_PEDE_PARA_SAIR`: aqui a palavra é o PLANO ou a FATURA,
  // nunca o canal. Nenhuma bloqueia e nenhuma escala.
  "cuanto cuesta la suscripcion anual?",
  "la suscripcion se renueva sola?",
  "quiero saber el precio de la suscripcion",
];

/**
 * ─── PORTUGUÊS DE PORTUGAL, no MESMO detector ───────────────────────────────
 *
 * O seletor de país já aceita Portugal (doc 88 / PR #2339), mas o marketing
 * português segue as regras do Brasil: a Lei n.º 41/2004, art. 13.º-A, exige
 * consentimento prévio e um meio simples e gratuito de recusa em CADA mensagem.
 * A fatia deste PR é o primeiro pedaço disso — o opt-out reconhecer o
 * vocabulário de Portugal (issue #2343). O resto (exigir consentimento por
 * contato) exige schema novo e NÃO entra aqui.
 *
 * Duas palavras do corpo da issue:
 *   - "cancelar a subscrição" — `subscricao` faltava na lista de objetos;
 *   - "remover" — já é palavra-chave sozinha, mas a FRASE em pt-PT não casava
 *     nada, porque o pronome vem PRESO ao verbo ("remova-me"), e não solto
 *     antes dele como no Brasil ("me remova").
 *
 * Os controles negativos são metade do valor: sem eles, alguém "consertaria" o
 * positivo com um `includes("remover")` e a suíte ficaria verde bloqueando quem
 * só avisou que vai remover o produto do carrinho.
 */
const PT_PT_PEDE_PARA_SAIR = [
  // "remover" na gramática de Portugal — pronome PRESO ao verbo, depois dele.
  "remova-me da lista",
  "removam-me da lista",
  "podem remover-me da lista",
  "retirem-me da lista de contactos",
  "eliminem-me da lista",
  "apaguem-me da lista de contactos",
  "excluam-me da lista de envios",
];

const PT_PT_NAO_PEDE = [
  // "subscrição" noutro sentido: fala da fatura, não pede saída.
  "o valor da subscrição aumentou este mês",
  "quanto custa a subscrição anual?",
  // "remover" em Portugal, mas o objeto NÃO é a comunicação com quem escreve —
  // mesmo continente do controle do #1607.
  "vou remover o produto do carrinho",
  "remova-me a dúvida sobre o prazo de entrega",
  "podem remover a fatura duplicada do sistema",
  // Outra lista — quem escreve isto QUER continuar a ser contactado.
  "removam-me da lista de espera",
  "remova-me da lista de desejos",
  // "contactos" sem "lista": a forma brasileira ("me remova dos contatos do
  // fornecedor") também não bloqueia.
  "remova-me dos contatos do fornecedor",
];

/**
 * "cancelar a subscrição" — a frase do corpo da issue — ESCALA e não bloqueia:
 * em Portugal a palavra também é o plano do ginásio ou da revista, e quem
 * pergunta "posso cancelar a subscrição e voltar depois?" quer resposta.
 */
const PT_PT_ESCALA_SEM_BLOQUEAR = [
  "cancelar a subscrição",
  "quero cancelar a subscrição",
  "podem cancelar a subscrição, por favor",
  "cancela a subscrição",
  "posso cancelar a subscrição e voltar depois?",
];

/**
 * ─── "cancelar a assinatura" é o PLANO, não as mensagens (#2886) ─────────────
 *
 * A palavra serve às duas coisas: sair das mensagens E cancelar o plano do
 * produto. Medido com `ehPedidoDeOptOut`/`ehOptOutProvavel` da main, antes
 * desta fatia, as frases abaixo gravavam `is_blocked` (e escalavam), porque o
 * padrão `cancelar a (inscricao|assinatura)` estava em `FRASES_DE_OPT_OUT`:
 *
 *   "posso cancelar a assinatura e voltar depois?"  bloqueia=true  escala=true
 *   "quero cancelar a assinatura da revista"        bloqueia=true  escala=true
 *   "cancelar la suscripcion"                       bloqueia=true  escala=true
 *
 * Uma academia, uma revista ou um SaaS que atende pelo WhatsApp PERDIA o cliente
 * que só perguntava como pausar o plano: o contato ficava bloqueado e a IA parava
 * de responder. O precedente é a #2872, que fez o mesmo com `cancelar a
 * subscricão` (pt-PT); o custo aceito — campanhas seguem até alguém da equipe
 * decidir o bloqueio — está escrito na #2886.
 *
 * Quem quer sair DAS MENSAGENS continua coberto pelas formas com objeto, que
 * bloqueiam na hora; o `it` de baixo é a guarda disso.
 */
const ASSINATURA_ESCALA_SEM_BLOQUEAR = [
  "cancelar a assinatura",
  "quero cancelar a assinatura",
  "posso cancelar a assinatura e voltar depois?",
  "quero cancelar a assinatura da revista",
  "gostaria de cancelar minha assinatura por enquanto",
];

const SUSCRIPCION_ESCALA_SEM_BLOQUEAR = [
  "cancelar la suscripcion",
  "quiero cancelar la suscripcion",
  "puedo cancelar la suscripcion y volver despues?",
  "necesito cancelar mi suscripcion, como hago?",
];

describe("cancelar o PLANO escala sem bloquear — a palavra de duas caras (#2886)", () => {
  for (const texto of [...ASSINATURA_ESCALA_SEM_BLOQUEAR, ...SUSCRIPCION_ESCALA_SEM_BLOQUEAR]) {
    it(`escala sem bloquear: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(false);
      expect(ehOptOutProvavel(texto)).toBe(true);
    });
  }

  it("as formas COM objeto de comunicação continuam bloqueando na hora", () => {
    // O outro lado do conserto: mover `assinatura` para as ambíguas não pode
    // afrouxar quem de fato pediu para parar de receber.
    for (const texto of [
      "parar de me mandar",
      "sair da lista",
      "dar de baja la suscripcion",
      "quiero dar de baja la suscripcion",
      "quero cancelar a inscrição",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(true);
    }
  });

  it("`cancelar` SOZINHO, sem objeto, continua bloqueando", () => {
    expect(ehPedidoDeOptOut("cancelar")).toBe(true);
  });
});

describe("português de Portugal — o vocabulário da issue #2343", () => {
  for (const texto of PT_PT_PEDE_PARA_SAIR) {
    it(`bloqueia: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(true);
    });
  }

  for (const texto of PT_PT_NAO_PEDE) {
    it(`NÃO bloqueia: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(false);
    });
  }

  for (const texto of PT_PT_ESCALA_SEM_BLOQUEAR) {
    it(`escala sem bloquear: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(false);
      expect(ehOptOutProvavel(texto)).toBe(true);
    });
  }

  it("o Brasil continua a valer byte a byte — a regra daqui não muda", () => {
    // A fatia ACRESCENTA formas; nenhuma brasileira pode sair.
    for (const texto of PEDE_PARA_SAIR) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(true);
    }
    for (const texto of NAO_PEDE_PARA_SAIR) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
    }
  });
});

describe("espanhol — a palavra que a plantilla pede", () => {
  for (const texto of ESPANHOL_PEDE_PARA_SAIR) {
    it(`bloqueia: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(true);
    });
  }

  for (const texto of ESPANHOL_NAO_PEDE) {
    it(`NÃO bloqueia: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(false);
    });
  }
});

/**
 * O lado negativo do corpus verificava só o BLOQUEIO, e não a ESCALADA.
 *
 * São dois níveis com custos diferentes: `ehPedidoDeOptOut` grava
 * `is_blocked=true` e o contato para de ser atendido; `ehOptOutProvavel` faz o
 * agente parar de responder e chamar um humano. O segundo é mais barato, mas
 * não é grátis — num sistema de vendas ele desliga a automação exatamente na
 * objeção, que é o momento em que ela deveria trabalhar.
 *
 * Enquanto só o bloqueio era verificado, uma frase podia entrar na lista
 * ambígua e o corpus inteiro seguir verde: `ehPedidoDeOptOut` devolve `false`
 * para ela, que é tudo que se perguntava. Foi por essa porta que
 * `no me interesa` (sem marca de repetição) passou a escalar toda objeção
 * comercial em espanhol sem nenhum caso vermelhar.
 *
 * Medido ao escrever: com a regra corrigida, ZERO frases dos dois corpora
 * negativos escalam. O gate nasce verde e trava a volta.
 */
describe("o lado negativo também não pode ESCALAR, não só não bloquear", () => {
  for (const texto of [...ESPANHOL_NAO_PEDE, ...NAO_PEDE_PARA_SAIR, ...PT_PT_NAO_PEDE]) {
    it(`não escala para humano: ${texto}`, () => {
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    });
  }
});

/**
 * O espanhol tinha ZERO frases ambíguas — `ehOptOutProvavel` nunca somava
 * nada além do inequívoco nesse idioma, e o comentário de `baja`/`salir` em
 * `deteccao.ts` chegou a afirmar que duas frases "caem no ambíguo" sem que
 * essa camada existisse para pegá-las. Espelha o corpus português de baixo
 * ("me deixa em paz", "já disse que não quero", "para com isso") — mesma
 * forma, outra língua.
 */
describe("espanhol — o ambíguo, que não existia", () => {
  it.each([
    "déjame en paz",
    "déjenme en paz",
    "ya te dije que no me interesa",
    "ya no me interesa",
    // CONTROLE do lado positivo: o marcador de repetição é o que separa o
    // sinal da objeção. "ya" numa, "mas" na outra — sem nenhum dos dois, a
    // frase está em `ESPANHOL_NAO_PEDE`, acima.
    "no me interesa mas",
    "ya no me interesa nada de esto",
    "basta ya",
    "ya basta con esto",
    "no me molesten",
  ])("reconhece o sinal ambíguo: %s", (texto) => {
    expect(ehOptOutProvavel(texto)).toBe(true);
  });

  it("o ambíguo em espanhol também NÃO autoriza bloqueio por si só", () => {
    expect(ehOptOutProvavel("déjame en paz")).toBe(true);
    expect(ehPedidoDeOptOut("déjame en paz")).toBe(false);
  });
});

describe("ehPedidoDeOptOut — pedido INEQUÍVOCO, o que autoriza bloquear", () => {
  it.each(PEDE_PARA_SAIR)("respeita o pedido: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `deveria ter reconhecido "${texto}"`).toBe(true);
  });

  it.each(NAO_PEDE_PARA_SAIR)("não bloqueia quem não pediu: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}" sem pedido`).toBe(false);
  });

  it("texto ausente não é pedido de nada", () => {
    expect(ehPedidoDeOptOut(null)).toBe(false);
    expect(ehPedidoDeOptOut(undefined)).toBe(false);
  });

  it("a palavra precisa estar SOZINHA para valer por si", () => {
    // É o coração da correção: a mesma palavra, dois significados. Se algum dia
    // este par voltar a dar o mesmo resultado, a regra regrediu para "caçar
    // palavra" — que é o defeito, não a solução.
    expect(ehPedidoDeOptOut("parar")).toBe(true);
    expect(ehPedidoDeOptOut("tem como parar a dor?")).toBe(false);
  });

  it("cancelar sozinho sai; cancelar UMA COISA fica", () => {
    expect(ehPedidoDeOptOut("cancelar")).toBe(true);
    expect(ehPedidoDeOptOut("quero cancelar o pedido")).toBe(false);
  });
});

describe("ehOptOutProvavel — soma o ambíguo, para parar de responder e escalar", () => {
  it("todo pedido inequívoco também é provável", () => {
    for (const texto of PEDE_PARA_SAIR) {
      expect(ehOptOutProvavel(texto), texto).toBe(true);
    }
  });

  it.each(["me deixa em paz", "já disse que não quero", "para com isso"])(
    "reconhece o sinal ambíguo: %s",
    (texto) => {
      expect(ehOptOutProvavel(texto)).toBe(true);
    },
  );

  it("o ambíguo NÃO autoriza bloqueio por si só", () => {
    // A assimetria é a política: silenciar alguém para sempre é decisão de
    // pessoa. O ambíguo para o robô e chama o humano; quem bloqueia é ele.
    expect(ehOptOutProvavel("me deixa em paz")).toBe(true);
    expect(ehPedidoDeOptOut("me deixa em paz")).toBe(false);
  });

  it("não confunde troca de canal com descadastro", () => {
    // "não quero receber ligação, só whatsapp" QUER continuar recebendo aqui.
    expect(ehPedidoDeOptOut("não quero receber ligação, só whatsapp")).toBe(false);
    expect(ehOptOutProvavel("não quero receber ligação, prefiro mensagem")).toBe(false);
  });
});

/**
 * ═══ O CALL SITE, e não só a regra ═══
 *
 * `detectAmbiguousOptOut` (o runtime do agente) e a ingestão respondiam a MESMA
 * pergunta com DUAS regras diferentes — e a divergência é o defeito que este PR
 * conserta: a ingestão bloqueava paciente que perguntou como parar a dor.
 *
 * Medido: revertendo SÓ `lib/agent-engine/agent/human-handoff.ts` para a versão
 * antiga (que reintroduz as constantes inline), a suíte INTEIRA fica verde —
 * 458 arquivos, 5123 casos, exit 0. Ou seja: nada guardava a religação, e a
 * divergência podia voltar sem um único vermelho.
 *
 * Os casos abaixo são de COMPORTAMENTO, não de texto: as duas frases só
 * respondem certo pela regra nova. Um `expect(fonte).toContain("import")` casaria
 * o símbolo e não o comportamento — e símbolo não é comportamento.
 */
describe("o runtime do agente usa a MESMA regra da ingestão", () => {
  it("'parar de receber' é opt-out provável — a regra antiga do runtime não pegava", async () => {
    const { detectAmbiguousOptOut } = await import("@/lib/agent-engine/agent/human-handoff");
    expect(detectAmbiguousOptOut("parar de receber")).toBe(true);
    expect(detectAmbiguousOptOut("pare de me mandar mensagem")).toBe(true);
  });

  it("'tem como parar a dor?' NÃO é opt-out — é o falso positivo que motivou o conserto", async () => {
    const { detectAmbiguousOptOut } = await import("@/lib/agent-engine/agent/human-handoff");
    expect(detectAmbiguousOptOut("tem como parar a dor?")).toBe(false);
    expect(detectAmbiguousOptOut("posso sair antes das 15h?")).toBe(false);
  });
});


describe("comecaComPalavraDeSaida — qual frase o cliente lê quando a IA sai de campo", () => {
  it("'Parar não é daqui' começa com a palavra de saída — o caso medido em produção", () => {
    expect(comecaComPalavraDeSaida("Parar não é daqui")).toBe(true);
    // ...e NÃO autoriza bloqueio: é por isso que ele ficou sem bloqueio.
    expect(ehPedidoDeOptOut("Parar não é daqui")).toBe(false);
  });

  it("as palavras que o rodapé das abordagens oferece, em qualquer caixa e com pontuação", () => {
    for (const t of ["PARAR", "parar.", "¿Parar?", "Pare de me mandar", "STOP!", "Baja", "  stop  "]) {
      expect(comecaComPalavraDeSaida(t), t).toBe(true);
    }
  });

  it("só o INÍCIO conta: pergunta de paciente e conversa comum não casam", () => {
    for (const t of [
      "tem como parar a dor?",
      "quero saber se dá para parar o tratamento",
      "oi, tudo bem?",
      "não paro de pensar nisso",
      "",
      "   ",
      "123 !!!",
    ]) {
      expect(comecaComPalavraDeSaida(t), t).toBe(false);
    }
  });

  it("nenhuma frase de controle do corpus casa — o mesmo lado negativo que protege o bloqueio", () => {
    // Sem isto, "pare de mandar o pedido nesse endereco" (cliente irritado com a
    // entrega, candidato natural a `low_sentiment`) lia "Encerro os envios
    // automáticos deste canal agora mesmo".
    const casam = [...NAO_PEDE_PARA_SAIR, ...ESPANHOL_NAO_PEDE, ...PT_PT_NAO_PEDE].filter(
      (t) => comecaComPalavraDeSaida(t),
    );
    expect(casam).toEqual([]);
    for (const t of [
      "Parar de tomar o remédio faz mal?",
      "Parar o tratamento agora é ruim?",
      "Pare de doer o dente, quando?",
    ]) {
      expect(comecaComPalavraDeSaida(t), t).toBe(false);
    }
  });

  it("texto ausente é falso, sem lançar", () => {
    expect(comecaComPalavraDeSaida(null)).toBe(false);
    expect(comecaComPalavraDeSaida(undefined)).toBe(false);
  });
});

/**
 * ─── Com objeto de comunicação, `assinatura` BLOQUEIA (#2971) ───────────────
 *
 * O outro lado do bloco de cima. Quando a frase nomeia o que se quer parar de
 * receber — as mensagens, as notificações, os avisos, a newsletter —, ela tem
 * objeto de comunicação e bloqueia na hora, como na main antes do #2886. Só a
 * frase SEM objeto (que também pode ser o plano) escala sem bloquear.
 *
 * "do whatsapp" e "de vocês" ficam fora DE PROPÓSITO: também podem ser o plano
 * ("cancelar a assinatura do whatsapp" numa revenda de planos de WhatsApp), e
 * seguem só escalando para uma pessoa. A mesma regra fecha o buraco igual da
 * `subscricao` de Portugal (#2872).
 */
const ASSINATURA_COM_OBJETO_BLOQUEIA = [
  "cancelar a assinatura das mensagens",
  "quero cancelar a assinatura dessas mensagens",
  "cancelar a assinatura da newsletter",
  "cancelar a assinatura das notificações",
  "quero cancelar a assinatura dos avisos",
  "cancelar minha assinatura das promoções",
  "quero cancelar a subscrição das mensagens",
  "cancelar la suscripción a los mensajes",
  "quiero cancelar mi suscripcion de sus promociones",
];

describe("com objeto de comunicação, `assinatura` BLOQUEIA (#2971)", () => {
  for (const texto of ASSINATURA_COM_OBJETO_BLOQUEIA) {
    it(`bloqueia: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(true);
    });
  }

  it("o objeto que pode ser o PLANO não bloqueia — só escala", () => {
    for (const texto of [
      "cancelar a assinatura do plano de mensagens",
      "cancelar a assinatura de mensagens",
      "cancelar a assinatura do whatsapp",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(true);
    }
  });
});

/**
 * ─── A ASSINATURA DA ATENDENTE NA PRIMEIRA LINHA (#3078, ajustada no #3158) ──
 *
 * O caso do relato: WhatsApp Business com vários atendentes prefixa a
 * ASSINATURA ao texto, e o "PARAR" chega na SEGUNDA linha:
 *
 *   *Amanda Nobre:*
 *   PARAR
 *
 * Com o texto cru, `ehPalavraIsolada` cola as letras ("amandanobreparar") e
 * nenhuma frase casa — o pedido se perdia, o contato não era bloqueado e a IA
 * respondia. O recorte tira a assinatura da FRENTE e julga o resto pela MESMA
 * régua; nada no vocabulário nem no limiar que grava `is_blocked` se move.
 *
 * ─── O AJUSTE DO #3158 — as frases medidas pelo mantenedor são CONTROLE ─────
 *
 * A primeira versão reconhecia também o rótulo SEM asteriscos (`Nome:`, até 4
 * palavras) e julgava só o recortado. O mantenedor passou 28 frases pelas duas
 * versões e 18 resultados mudaram de veredito contra a `main`, nos dois
 * sentidos. Os grupos (e) a (h) abaixo são EXATAMENTE esses casos, um `it` por
 * grupo, para que nenhuma das 18 mudanças possa voltar em silêncio:
 *
 *   (e) 5 rótulos curtos que passavam a BLOQUEAR: "Consulta de amanhã:",
 *       "Pedido 123:", "Remédio:", "Dúvida:" e "Sua mensagem:";
 *   (f) 3 primeiras linhas que SÃO o pedido e deixavam de bloquear;
 *   (g) os 3 controles dele — nunca bloquearam e continuam não bloqueando;
 *   (h) o resíduo `*Remédio:*` + `parar?`: limite DECLARADO, não silêncio.
 *
 * A régua do ajuste: só o NEGRITO terminado em dois pontos é assinatura, e o
 * pedido é julgado no texto ORIGINAL **ou** no recortado — basta um bloquear.
 */
describe("a assinatura da atendente na primeira linha não esconde o pedido (#3078)", () => {
  it("(a) o caso do defeito: `*Amanda Nobre:*` + `PARAR` é pedido INEQUÍVOCO", () => {
    // Este é o caso que fica VERMELHO sem o recorte (ver o PR: sabotagem).
    expect(ehPedidoDeOptOut("*Amanda Nobre:*\nPARAR")).toBe(true);
    // ...e também escala, pela mesma razão de sempre (inequívoco ⇒ provável).
    expect(ehOptOutProvavel("*Amanda Nobre:*\nPARAR")).toBe(true);
  });

  it("(b) variações da assinatura em NEGRITO — todas reconhecidas", () => {
    for (const texto of [
      "*Nome:*\nsair", // nome curto, palavra de saída diferente
      "*Amanda Nobre*:\nPARAR", // dois pontos FORA dos asteriscos
      "*Amanda Nobre:*\nnao quero mais receber", // frase de opt-out, não só palavra
      "*Dra. Amanda Nobre:*\nparar de me mandar mensagem", // ponto de abreviação no nome
    ]) {
      expect(ehPedidoDeOptOut(texto), `deveria reconhecer ${JSON.stringify(texto)}`).toBe(true);
    }
  });

  it("(b) a marca da assinatura é o NEGRITO: o rótulo sem asteriscos deixa de ser assinatura (#3158)", () => {
    // Era por aqui que "Consulta de amanhã:" e "Dúvida:" viravam assinatura (o
    // grupo (e) mede o estrago). O texto original segue sendo julgado: quando o
    // que vem depois é FRASE de pedido, o grupo (f) bloqueia igual. O que se
    // perde — declarado — é a PALAVRA SOLTA depois de um rótulo sem a marca.
    for (const texto of ["Amanda Nobre:\nPARAR", "*Amanda Nobre*\nPARAR"]) {
      expect(semAssinaturaDaAtendente(texto), `não deve recortar ${JSON.stringify(texto)}`).toBe(texto);
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
  });

  it("(b) controle negativo: assinatura em mensagem que NÃO pede saída segue não sendo pedido", () => {
    // O recorte não pode virar um "ignore o que vem antes": com a assinatura
    // removida, o que sobra é atendimento normal — nem bloqueia, nem escala.
    for (const texto of [
      "*Amanda Nobre:*\nBom dia, tudo bem?",
      "Amanda Nobre:\nvocês abrem amanhã?",
      "*Joana:*\nvou pensar e te falo",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
  });

  /**
   * (e) os 5 que passavam a BLOQUEAR: a forma sem asteriscos lia qualquer
   * rótulo curto como assinatura, e o resto — a palavra isolada — silenciava a
   * pessoa para sempre. Num paciente de clínica ou num cliente de loja isso é
   * falso positivo que ninguém descobre, porque o motivo gravado
   * (`stop_keyword`) parece legítimo.
   */
  it("(e) rótulo curto sem asteriscos NÃO é assinatura — os 5 falsos positivos do #3158", () => {
    for (const texto of [
      "Consulta de amanhã:\ncancelar",
      "Pedido 123:\ncancelar",
      "Remédio:\nparar?",
      "Dúvida:\nparar?",
      "Sua mensagem:\nPARAR",
    ]) {
      expect(ehPedidoDeOptOut(texto), `não pode bloquear: ${JSON.stringify(texto)}`).toBe(false);
      expect(ehOptOutProvavel(texto), `não pode escalar: ${JSON.stringify(texto)}`).toBe(false);
    }
  });

  /**
   * (f) os 3 que DEIXAVAM de bloquear: a primeira linha É o pedido e era
   * recortada como assinatura, sobrando só "obrigado"/"chato". Aqui o que
   * decide é o texto ORIGINAL — o pedido mora na própria primeira linha.
   */
  it("(f) primeira linha que É o pedido volta a bloquear — os 3 falsos negativos do #3158", () => {
    for (const texto of [
      "*Não quero mais receber*\nobrigado",
      "*Pare de me mandar mensagem*\nchato",
      "Não quero mais receber:\nobrigado",
    ]) {
      expect(ehPedidoDeOptOut(texto), `deve bloquear: ${JSON.stringify(texto)}`).toBe(true);
      expect(ehOptOutProvavel(texto), texto).toBe(true);
    }
  });

  it("(f) o pedido é julgado nos DOIS textos: mesmo com o recorte inocente, o original bloqueia (#3158)", () => {
    // `obrigado` sozinho não é pedido nenhum; sem olhar o texto ORIGINAL, o
    // recorte apagaria o pedido que vive na primeira linha em negrito.
    const texto = "*Não quero mais receber:*\nobrigado";
    expect(semAssinaturaDaAtendente(texto)).toBe("obrigado");
    expect(ehPedidoDeOptOut(texto)).toBe(true);
  });

  /**
   * (g) Os 3 controles do mantenedor. Nenhum deles bloqueia na `main` nem
   * antes deste ajuste — e nenhum pode passar a bloquear: o primeiro é a
   * assinatura real seguida de pergunta de paciente, os dois últimos são
   * conversa que só CONTÉM a palavra.
   */
  it("(g) os 3 controles do mantenedor seguem sem bloquear (#3158)", () => {
    for (const texto of [
      "*Amanda Nobre:*\ntem como parar a dor?",
      "Ana:\nparar o tratamento?",
      "> PARAR\nnão, quero continuar",
    ]) {
      expect(ehPedidoDeOptOut(texto), `não pode bloquear: ${JSON.stringify(texto)}`).toBe(false);
      expect(ehOptOutProvavel(texto), `não pode escalar: ${JSON.stringify(texto)}`).toBe(false);
    }
  });

  /**
   * (h) O RESÍDUO, declarado. `*Remédio:*` é estruturalmente idêntico a um
   * nome em negrito (`*Ana:*`): separar os dois exigiria um dicionário de nomes
   * próprios, e o rótulo que a issue descreve é `*Nome:*`. O ajuste escolhe
   * manter o bloqueio (perder um pedido de quem assina é o erro caro do
   * módulo) — e este `it` existe para que a escolha não fique implícita: se
   * alguém resolver o rótulo, é aqui que o teste muda.
   */
  it("(h) LIMITE DECLARADO: `*Remédio:*` + `parar?` segue bloqueando (rótulo em negrito = nome)", () => {
    expect(ehPedidoDeOptOut("*Remédio:*\nparar?")).toBe(true);
    // O contraste que mostra o limite: o MESMO rótulo sem os asteriscos não é
    // assinatura nenhuma, e ali não bloqueia (grupo (e)).
    expect(ehPedidoDeOptOut("Remédio:\nparar?")).toBe(false);
  });

  it("(c) pedido SEM assinatura continua reconhecido igual a hoje", () => {
    for (const texto of ["PARAR", "sair", "nao quero mais receber", "parar de me mandar mensagem"]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(true);
    }
  });

  it("(d) mensagem legítima de duas linhas não passa a ser pedido", () => {
    for (const texto of [
      "Bom dia\nvamos falar amanha",
      "oi\nqueria saber o preço",
      "Bom dia:\nvamos falar amanha", // dois pontos no fim, mas a 2ª linha não é pedido
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
    }
  });

  it("mensagem de UMA linha só é PRESERVADA — `*PARAR:*` sozinho continua bloqueando", () => {
    // O limite mais delicado: a "assinatura" é a mensagem INTEIRA. Recortá-la
    // devolveria vazio e o pedido morreria — por isso o recorte exige texto
    // DEPOIS da primeira linha.
    expect(semAssinaturaDaAtendente("*PARAR:*")).toBe("*PARAR:*");
    expect(ehPedidoDeOptOut("*PARAR:*")).toBe(true);
    expect(ehPedidoDeOptOut("PARAR:\n")).toBe(true);
  });

  it("o recorte é puro e devolve o RESTO intacto (não decide nada)", () => {
    expect(semAssinaturaDaAtendente("*Amanda Nobre:*\nPARAR")).toBe("PARAR");
    expect(semAssinaturaDaAtendente("*Amanda Nobre*:\nPARAR")).toBe("PARAR");
    expect(semAssinaturaDaAtendente("*Amanda Nobre:*\nPARAR\npor favor")).toBe("PARAR\npor favor");
    // não é assinatura (#3158): rótulo sem asteriscos / negrito sem dois pontos
    expect(semAssinaturaDaAtendente("Amanda Nobre:\nPARAR\npor favor")).toBe(
      "Amanda Nobre:\nPARAR\npor favor",
    );
    expect(semAssinaturaDaAtendente("*Amanda Nobre*\nPARAR")).toBe("*Amanda Nobre*\nPARAR");
    expect(semAssinaturaDaAtendente("Bom dia\nvamos falar amanha")).toBe("Bom dia\nvamos falar amanha");
    expect(semAssinaturaDaAtendente("Bom dia, tudo bem:\nsegue o pedido")).toBe(
      "Bom dia, tudo bem:\nsegue o pedido",
    );
    // texto que COMEÇA com dois pontos nunca é assinatura
    expect(semAssinaturaDaAtendente(": nota\nPARAR")).toBe(": nota\nPARAR");
  });
});
