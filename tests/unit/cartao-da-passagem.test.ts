import { describe, expect, it } from "vitest";

import {
  montarCartoesDaPassagem,
  type PassagemDaConversa,
  type QuemOlha,
} from "@/lib/escalacao/cartao-da-passagem";
import { montarBriefingDaPassagem } from "@/lib/escalacao/briefing-da-passagem";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import {
  FRASE_DO_MOTIVO,
  FRASE_DO_MOTIVO_DO_AVISO,
  MOTIVO_PERCEBIDO_PELO_JEV,
  MOTIVOS_DA_PASSAGEM,
  PISO_DO_BRIEFING,
} from "@/lib/escalacao/passagem";
import { ROTULO_DE_ANONIMIZADO } from "@/lib/escalacao/texto-do-aviso";

/**
 * OS SETE ESTADOS DO CARTÃO, DECIDIDOS FORA DO JSX.
 *
 * ═══ Por que a decisão não mora no componente ═══
 *
 * Duas razões, e nenhuma é gosto:
 *
 *   1. **`tests/unit/passagem-motivo-em-portugues.test.ts` proíbe o código cru
 *      em `app/`, `components/` e `hooks/`.** Um `motivo_codigo ===
 *      "suspected_optout"` dentro do JSX reprova aquele gate — e ele está certo:
 *      vocabulário de CONSTRAINT dentro de uma tela é o caminho mais curto para
 *      ele virar texto no rosto de quem opera.
 *   2. **Estado de tela testado por render é caro e frágil.** Sete estados × a
 *      variante de quem olha dá uma matriz que um teste de DOM mede devagar e
 *      com falso vermelho de layout. Aqui a matriz é um `expect` por linha.
 *
 * ═══ O que este arquivo NÃO prova ═══
 *
 * Que a tela RENDERIZA o que a função decidiu. Isso é do componente e da prova
 * em tela (DoD 12, onda 12). O que se prova aqui é a decisão — e é ela que
 * carrega a regra de negócio.
 */

const AGORA = "2026-09-18T12:00:00.000Z";

function passagem(over: Partial<PassagemDaConversa> = {}): PassagemDaConversa {
  return {
    id: "p1",
    origem: "pedido_explicito",
    motivo_codigo: "requested_human",
    title: "15% de desconto no plano anual",
    body: "Cliente de 200 unidades, comparando com concorrente.",
    notes: "então me passa pra uma pessoa",
    content: null,
    tentativas: [
      { o_que: "Buscou a política de desconto", desfecho: "só vai a 10%" },
      { o_que: "Ofereceu 10% + 2 meses", desfecho: "recusado" },
    ],
    cliente_avisado: true,
    aviso_motivo_codigo: null,
    caso_id: null,
    criado_em: AGORA,
    reconhecido_em: null,
    reconhecido_por: null,
    reconhecido_por_nome: null,
    ...over,
  };
}

const NINGUEM_ATENDE: QuemOlha = { usuarioId: "u-eu", donoId: null, donoNome: null };

describe("cartão da passagem — o estado do episódio", () => {
  it("CONTROLE DE VACUIDADE: lista vazia devolve lista vazia, e não um cartão em branco", () => {
    // Sem isto, um bug que devolvesse `[{}]` para entrada vazia passaria em
    // todos os casos abaixo, que só olham o primeiro elemento.
    expect(montarCartoesDaPassagem([], NINGUEM_ATENDE)).toEqual([]);
  });

  it("passagem não reconhecida fica ABERTA, em destaque, com o convite de assumir", () => {
    const c = montarCartoesDaPassagem([passagem()], NINGUEM_ATENDE)[0]!;
    expect(c.estado).toBe("aberta");
    expect(c.recolhido).toBe(false);
    expect(c.acao.tipo).toBe("assumir_e_responder");
  });

  it("passagem com dono fica RECONHECIDA, sem convite, e nomeia quem assumiu", () => {
    const c = montarCartoesDaPassagem(
      [
        passagem({
          reconhecido_em: AGORA,
          reconhecido_por: "u-joana",
          reconhecido_por_nome: "Joana",
        }),
      ],
      { usuarioId: "u-eu", donoId: "u-joana", donoNome: "Joana" },
    )[0]!;
    expect(c.estado).toBe("reconhecida");
    expect(c.assumidaPor).toBe("Joana");
    expect(c.acao.tipo).toBe("nenhuma");
  });

  it("reconhecida SEM dono é devolução ao automático — o episódio fechou e ninguém assumiu", () => {
    // É o par que a 0291 documentou e o CHECK `passagens_reconhecimento_coerente`
    // permite só neste sentido: `reconhecido_em` preenchido com
    // `reconhecido_por` nulo. Ler isso como "reconhecida" diria a quem abre a
    // conversa que alguém está cuidando — e não está.
    const c = montarCartoesDaPassagem(
      [passagem({ reconhecido_em: AGORA, reconhecido_por: null })],
      NINGUEM_ATENDE,
    )[0]!;
    expect(c.estado).toBe("devolvida");
    expect(c.assumidaPor).toBeNull();
    expect(c.acao.tipo).toBe("nenhuma");
  });
});

describe("cartão da passagem — o que ele mostra", () => {
  it("o motivo sai em PORTUGUÊS, e o código do banco não aparece em lugar nenhum", () => {
    const c = montarCartoesDaPassagem([passagem({ motivo_codigo: "low_sentiment" })], NINGUEM_ATENDE)[0]!;
    expect(c.motivo).toBe(FRASE_DO_MOTIVO.low_sentiment);
    expect(JSON.stringify(c)).not.toContain("low_sentiment");
  });

  it("o resumo que é o PISO some — cabeçalho órfão é ruído", () => {
    // `body` é `not null`, então uma passagem sem contexto carrega o piso. Um
    // cabeçalho "Resumo da IA" seguido da frase "sem resumo acumulado" ocupa
    // três linhas para dizer nada.
    const c = montarCartoesDaPassagem([passagem({ body: PISO_DO_BRIEFING })], NINGUEM_ATENDE)[0]!;
    expect(c.resumo).toBeNull();
    expect(c.semContexto).toBe(true);
  });

  it("resumo de verdade fica, e `semContexto` é falso", () => {
    const c = montarCartoesDaPassagem([passagem()], NINGUEM_ATENDE)[0]!;
    expect(c.resumo).toBe("Cliente de 200 unidades, comparando com concorrente.");
    expect(c.semContexto).toBe(false);
  });

  it("a fala do cliente e o que ele quer chegam separados — um é citação, o outro é conclusão da IA", () => {
    const c = montarCartoesDaPassagem([passagem()], NINGUEM_ATENDE)[0]!;
    expect(c.falaDoCliente).toBe("então me passa pra uma pessoa");
    expect(c.clienteQuer).toBe("15% de desconto no plano anual");
  });

  it("texto em branco vira `null`, nunca string vazia", () => {
    // Uma seção com título e corpo vazio afirma que o dado existe e é nada.
    const c = montarCartoesDaPassagem(
      [passagem({ title: "   ", notes: "", content: "\n" })],
      NINGUEM_ATENDE,
    )[0]!;
    expect(c.clienteQuer).toBeNull();
    expect(c.falaDoCliente).toBeNull();
    expect(c.textoDeQuemPassou).toBeNull();
  });

  it("as tentativas viram lista, na ordem em que a IA as declarou", () => {
    const c = montarCartoesDaPassagem([passagem()], NINGUEM_ATENDE)[0]!;
    expect(c.tentativas.map((t) => t.o_que)).toEqual([
      "Buscou a política de desconto",
      "Ofereceu 10% + 2 meses",
    ]);
  });

  it("tentativa fora do schema é DESCARTADA, e o resto do cartão sobrevive", () => {
    // `tentativas` é jsonb escrito a partir do que o modelo (ou um agente MCP
    // externo) mandou. Um item torto não pode derrubar o cartão inteiro: o
    // motivo e a fala do cliente continuam sendo o que a pessoa precisa ler.
    const c = montarCartoesDaPassagem(
      [passagem({ tentativas: [{ o_que: "válida" }, { nada: "disso" }] as never })],
      NINGUEM_ATENDE,
    )[0]!;
    expect(c.tentativas.map((t) => t.o_que)).toEqual(["válida"]);
    expect(c.motivo).toBe(FRASE_DO_MOTIVO.requested_human);
  });
});

describe("cartão da passagem — irritação percebida pelo Jev (D11)", () => {
  it("o motivo em destaque diz que foi o Jev, a partir do resumo que o briefing gravou", () => {
    const body = montarBriefingDaPassagem({
      checkpoint: null,
      motivo: { codigo: "low_sentiment", percebidoPeloJev: true },
    }).body;
    const c = montarCartoesDaPassagem([passagem({ motivo_codigo: "low_sentiment", body })], NINGUEM_ATENDE)[0]!;
    expect(c.motivo).toBe(FRASE_DO_MOTIVO.low_sentiment);
    expect(c.percebidoPeloJev).toBe(true);
  });

  it("controle: a mesma irritação medida pela IA de sempre não ganha a marca", () => {
    const body = montarBriefingDaPassagem({ checkpoint: null, motivo: { codigo: "low_sentiment" } }).body;
    const c = montarCartoesDaPassagem([passagem({ motivo_codigo: "low_sentiment", body })], NINGUEM_ATENDE)[0]!;
    expect(c.percebidoPeloJev).toBe(false);
  });

  it("contato anonimizado: nem a marca sobrevive", () => {
    const c = montarCartoesDaPassagem(
      [passagem({ motivo_codigo: "low_sentiment", body: `${ROTULO_DE_ANONIMIZADO} ${MOTIVO_PERCEBIDO_PELO_JEV}` })],
      NINGUEM_ATENDE,
    )[0]!;
    expect(c.percebidoPeloJev).toBe(false);
  });
});

describe("cartão da passagem — o cliente sabe que alguém vem?", () => {
  it("avisado: a linha afirma, e não há motivo a explicar", () => {
    const c = montarCartoesDaPassagem([passagem({ cliente_avisado: true })], NINGUEM_ATENDE)[0]!;
    expect(c.aviso).toEqual({ avisado: true, frase: null });
  });

  it("NÃO avisado: a linha diz o porquê, em português", () => {
    const c = montarCartoesDaPassagem(
      [passagem({ cliente_avisado: false, aviso_motivo_codigo: "na_fila_canal_fora" })],
      NINGUEM_ATENDE,
    )[0]!;
    expect(c.aviso).toEqual({
      avisado: false,
      frase: FRASE_DO_MOTIVO_DO_AVISO.na_fila_canal_fora,
    });
  });

  it("ninguém TENTOU avisar é diferente de tentou e não conseguiu — e a tela não afirma nada", () => {
    // `null` na coluna. A primeira frase que o atendente digita muda: no
    // primeiro caso a pessoa não espera nada; no segundo ela espera sem saber.
    const c = montarCartoesDaPassagem([passagem({ cliente_avisado: null })], NINGUEM_ATENDE)[0]!;
    expect(c.aviso).toBeNull();
  });
});

describe("cartão da passagem — opt-out provável", () => {
  const optOut = passagem({ motivo_codigo: "suspected_optout", origem: "opt_out_provavel" });

  it("o título muda, e NÃO convida a responder", () => {
    // Um cartão que convida a "assumir e responder" empurra alguém a escrever
    // para quem pediu para parar de receber mensagens. O gesto certo é conferir
    // o bloqueio na ficha do contato.
    const c = montarCartoesDaPassagem([optOut], NINGUEM_ATENDE)[0]!;
    expect(c.optOut).toBe(true);
    expect(c.acao.tipo).toBe("abrir_contato");
    expect(c.titulo).not.toBe(montarCartoesDaPassagem([passagem()], NINGUEM_ATENDE)[0]!.titulo);
  });

  it("nem mesmo com a conversa sem dono o convite de responder volta", () => {
    for (const quem of [
      NINGUEM_ATENDE,
      { usuarioId: "u-eu", donoId: "u-eu", donoNome: "Eu" },
      { usuarioId: "u-eu", donoId: "u-outro", donoNome: "Outro" },
    ] satisfies QuemOlha[]) {
      expect(montarCartoesDaPassagem([optOut], quem)[0]!.acao.tipo).not.toBe("assumir_e_responder");
    }
  });
});

describe("cartão da passagem — quem já está atendendo", () => {
  it("a conversa é MINHA: nada a convidar, o cartão é só contexto", () => {
    const c = montarCartoesDaPassagem([passagem()], {
      usuarioId: "u-eu",
      donoId: "u-eu",
      donoNome: "Eu",
    })[0]!;
    expect(c.acao.tipo).toBe("nenhuma");
  });

  it("a conversa é de OUTRA pessoa: o cartão diz quem atende, em vez de ficar mudo", () => {
    // B4: sem isto o cartão mais caro da entrega não fala nada para metade dos
    // leitores — e "Assumir e responder" ali seria oferecer um gesto que a rota
    // recusa, porque a conversa já tem dono.
    const c = montarCartoesDaPassagem([passagem()], {
      usuarioId: "u-eu",
      donoId: "u-joana",
      donoNome: "Joana",
    })[0]!;
    expect(c.acao).toEqual({ tipo: "avisa_quem_atende", donoNome: "Joana" });
  });

  it("dono sem nome resolvido continua dizendo que HÁ dono", () => {
    // O nome é cortesia (self-host sem service role devolve `null`); o dono é a
    // verdade. Cair no convite de assumir aqui ofereceria o gesto errado.
    const c = montarCartoesDaPassagem([passagem()], {
      usuarioId: "u-eu",
      donoId: "u-joana",
      donoNome: null,
    })[0]!;
    expect(c.acao).toEqual({ tipo: "avisa_quem_atende", donoNome: null });
  });
});

describe("cartão da passagem — várias passagens na mesma conversa", () => {
  const tres = [
    passagem({ id: "p1", criado_em: "2026-09-16T10:00:00.000Z", reconhecido_em: "2026-09-16T11:00:00.000Z", reconhecido_por: "u-joana" }),
    passagem({ id: "p2", criado_em: "2026-09-17T10:00:00.000Z", reconhecido_em: "2026-09-17T11:00:00.000Z", reconhecido_por: null }),
    passagem({ id: "p3", criado_em: "2026-09-18T10:00:00.000Z" }),
  ];

  it("a mais recente fica aberta; as anteriores ficam recolhidas", () => {
    const cartoes = montarCartoesDaPassagem(tres, NINGUEM_ATENDE);
    expect(cartoes.map((c) => c.recolhido)).toEqual([true, true, false]);
  });

  it("a ordem é cronológica, mesmo se a rota devolver fora de ordem", () => {
    // O fio da conversa é cronológico; um cartão fora de ordem no meio das
    // mensagens diria que a IA passou a conversa depois de já ter passado.
    const cartoes = montarCartoesDaPassagem([tres[2]!, tres[0]!, tres[1]!], NINGUEM_ATENDE);
    expect(cartoes.map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("só a última convida a assumir — três convites na mesma conversa são um convite só", () => {
    const cartoes = montarCartoesDaPassagem(
      [passagem({ id: "a", criado_em: "2026-09-17T10:00:00.000Z" }), passagem({ id: "b" })],
      NINGUEM_ATENDE,
    );
    expect(cartoes.map((c) => c.acao.tipo)).toEqual(["nenhuma", "assumir_e_responder"]);
  });
});

describe("cartão da passagem — o espanhol dos textos que a tela recebe por VARIÁVEL", () => {
  it("os dois títulos têm par `es` — o gate de i18n só enxerga literal", () => {
    // `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` varre `t("literal")`. O
    // título do cartão chega como `t(cartao.titulo)`, então aquele gate passa
    // por cima e a tela cairia no português para quem escolheu espanhol — em
    // silêncio, que é o modo de falha de i18n que este repositório já pagou.
    const titulos = new Set(
      MOTIVOS_DA_PASSAGEM.flatMap((motivo) =>
        montarCartoesDaPassagem([passagem({ motivo_codigo: motivo })], NINGUEM_ATENDE).map(
          (c) => c.titulo,
        ),
      ),
    );
    expect(titulos.size, "os títulos deixaram de variar — a varredura ficou vácua").toBe(2);
    expect([...titulos].filter((texto) => DICIONARIO[texto]?.es === undefined)).toEqual([]);
  });
});

describe("cartão da passagem — contato anonimizado", () => {
  const anonima = passagem({
    body: "Cliente Anonimizado #0b1f7a2e",
    title: null,
    notes: null,
    content: null,
    tentativas: [],
  });

  it("o cartão vira o rótulo e nada mais", () => {
    const c = montarCartoesDaPassagem([anonima], NINGUEM_ATENDE)[0]!;
    expect(c.anonimizada).toBe(true);
    expect(c.resumo).toBeNull();
    expect(c.falaDoCliente).toBeNull();
    expect(c.tentativas).toEqual([]);
    expect(c.aviso).toBeNull();
    expect(c.acao.tipo).toBe("nenhuma");
  });

  it("mesmo com sobra de texto de uma cascata parcial, o cartão não a exibe", () => {
    // A cascata zera as quatro colunas; se um clone antigo tiver sobra em
    // `notes`, o cartão não pode ressuscitá-la na tela de quem atende. O
    // reconhecimento é pelo RÓTULO em `body`, que é a coluna `not null` e a
    // única que a cascata garante ter reescrito.
    const c = montarCartoesDaPassagem(
      [{ ...anonima, notes: "sobra de um clone antigo", title: "sobra" }],
      NINGUEM_ATENDE,
    )[0]!;
    expect(c.falaDoCliente).toBeNull();
    expect(c.clienteQuer).toBeNull();
  });
});
