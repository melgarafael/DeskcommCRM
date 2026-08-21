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
  "me tira dessa lista",
  "me remove da lista por favor",
  "quero sair da lista",
  "quero cancelar a inscrição",
  "me descadastra aí",
];

/** Frases do dia a dia que usam a palavra e NÃO são pedido de descadastro. */
const NAO_PEDE_PARA_SAIR = [
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
