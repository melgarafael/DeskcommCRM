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

import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";

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
  // ─── As TRÊS formas que passavam batido (medido 24/09/2026) ───────────────
  //
  // O defeito: a lista de verbos tinha `remove|remova` mas não `remover`, o
  // pronome `me` era OBRIGATÓRIO antes do verbo, e só "da lista" valia como
  // destino. As três coisas juntas deixavam passar o jeito mais comum de pedir.
  //
  // INFINITIVO — "pode me remover da lista" é como se pede de fato.
  "pode me remover da lista",
  "me retirar da lista",
  "me excluir da lista",
  "me apagar da lista",
  "gostaria de me remover da lista",
  // OBJETO EXPLÍCITO — sem o pronome `me` antes do verbo.
  "retire meu contato da lista",
  "remova meu contato da lista",
  "retire meu numero da lista",
  "tira meu nome da lista",
  "quero que remova meu contato da lista",
  "pode remover meu numero da lista",
  // DESTINO — o mesmo pedido, outro lugar.
  "me tire do cadastro",
  "remova meu numero do sistema",
  "retire meu contato do cadastro",
  // ─── IMPERATIVO NEGATIVO — a família inteira que faltava (24/09/2026) ─────
  //
  // O padrão `não me X mais` tinha lista PRÓPRIA e estreita, copiada à mão, em
  // vez de usar a constante compartilhada. E a locução `entrar em contato` não
  // existia em lista nenhuma — `entre` é de ENTRAR, não de comunicar.
  //
  // Medido com a função real, antes deste conserto: 8 destas 11 passavam.
  "não entre mais em contato neste numero",
  "nao entre em contato comigo",
  "nao me contate mais",
  "nao me contacte mais",
  "nao me procure mais",
  "nao me incomode mais",
  "nao me escreva mais",
  "nao me fale mais",
  "nao me perturbe mais",
  "nao me importune mais",
  "nao volte a entrar em contato",
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
  // colagem — o defeito da versão com `\b` ASCII, que já tinha sido corrigido
  "amanhã ele sairá do escritório e pararão as obras",
  "a obra pararia se chovesse",
  // ─── Os invasores do conserto de 24/09/2026 ───────────────────────────────
  //
  // O conserto abriu os verbos (infinitivo), o objeto ("meu contato") e o
  // destino ("do cadastro"). Cada abertura é uma porta nova para falso
  // positivo, e estas são as frases que provam que ela ficou estreita:
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
  // ─── Os invasores do imperativo negativo ──────────────────────────────────
  //
  // A regra passou a usar a lista COMPLETA de verbos de comunicação. Mais
  // verbos = mais superfície. Estas provam que o freio segurou:
  "nao me mande mais boletos",
  "nao me mande mais faturas por email",
  "nao me envie mais os produtos errados",
  "nao me mandem mais cobrancas duplicadas",
  // A locução `entrar em contato` também é afirmativa na vida real: quem MARCA
  // um contato não está pedindo para sair dele.
  "nao vou poder entrar em contato hoje",
  "vou entrar em contato amanha",
  "quando voces vao entrar em contato?",
  "nao consegui entrar em contato ontem",
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
  "cancelar la suscripcion",
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
];

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
  for (const texto of [...ESPANHOL_NAO_PEDE, ...NAO_PEDE_PARA_SAIR]) {
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
