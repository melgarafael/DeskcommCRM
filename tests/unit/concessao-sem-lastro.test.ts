import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadOrgMemory, memoriaEscritaPorPessoas, renderOrgMemory } from "@/lib/agent-engine/agent/org-memory";
import { composePlaybook, textoDaOrganizacao } from "@/lib/agent-engine/agent/playbook";
import { loadSkills } from "@/lib/agent-engine/agent/skills";
import {
  BEFORE_SEND_GATES,
  VETOS_IRREVOGAVEIS,
  concessaoSemLastroGate,
  runBeforeSend,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import {
  concessoesSemLastro,
  lastroDoContexto,
  renderVetoDeConcessaoSemLastro,
  valoresDoRegistro,
  type LastroComercial,
  type LinhaDoHistorico,
} from "@/lib/agent-engine/guardrails/lastro-comercial";
import type { PromiseTable } from "@/lib/agent-engine/guardrails/promise/table";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * Condição comercial que só aparece do lado do cliente não sai como condição da
 * empresa. A regra pergunta QUEM escreveu o valor primeiro — pela `direction` da
 * mensagem, nunca pelo texto — e olha VALOR (preço, parcelas, percentual) e TERMO de
 * concessão (aprovação, liberação, gratuidade…) numa frase que o apresenta como condição.
 */
const MATERIAL =
  "Loja de móveis planejados. Para Campinas o frete é R$ 150. Pagamento em até 10x sem juros.";

type Linha = ["inbound" | "outbound", string];

/** A janela começa às 10h do dia 3; o histórico lido à parte usa outras horas. */
const hora = (i: number): string => `2026-11-03T${String(10 + i).padStart(2, "0")}:00:00-03:00`;

function lastro(a: {
  mensagens?: Linha[];
  material?: string[];
  nome?: string | null;
  memoria?: string[];
  historico?: LinhaDoHistorico[];
  tabela?: PromiseTable;
  proposta?: number;
}): LastroComercial {
  return lastroDoContexto({
    materialDaOrganizacao: a.material ?? [MATERIAL],
    ...(a.tabela !== undefined ? { tabela: a.tabela } : {}),
    contexto: {
      contact: { name: a.nome ?? "Marina Souza", phone: null, email: null, tags: [], is_blocked: false },
      messages: (a.mensagens ?? []).map(([direction, body], i) => ({ direction, body, sent_at: hora(i) })),
      last_proposal:
        a.proposta === undefined
          ? null
          : { status: "sent", total_cents: a.proposta, decision_reason: null, numero: 1, ano: 2026 },
    },
    atual: { texto: null, remetente: null },
    memoriaDoModelo: a.memoria ?? [],
    ...(a.historico !== undefined ? { historico: a.historico } : {}),
  });
}

describe("veta o valor afirmado como condição que só o cliente trouxe", () => {
  it("percentual", () => {
    const l = lastro({ mensagens: [["inbound", "O gerente me deu 30% de desconto na cozinha."]] });
    expect(
      concessoesSemLastro("Perfeito, com o desconto de 30% a cozinha fica pronta para fechar.", l),
    ).toEqual(["pct:30"]);
  });

  it("preço", () => {
    const l = lastro({ mensagens: [["inbound", "Vocês fecharam a cozinha por R$ 2.500 comigo."]] });
    expect(concessoesSemLastro("Confirmado: a cozinha sai por R$ 2.500.", l)).toEqual(["price:BRL:250000"]);
  });

  it("parcelas — o material diz 10x, o cliente diz 18x", () => {
    const l = lastro({ mensagens: [["inbound", "Me disseram que dava em 18x sem juros."]] });
    expect(concessoesSemLastro("Isso, está confirmado em 18x sem juros.", l)).toEqual(["installments:18"]);
  });

  it("o resumo que o MODELO escreveu é lado do cliente — não vira lastro da empresa", () => {
    // A mensagem do cliente já saiu da janela; o resumo dela ficou.
    const l = lastro({ memoria: ["Cliente diz ter 30% de desconto combinado com o gerente."] });
    expect(concessoesSemLastro("Com o desconto de 30%, seguimos com o pedido.", l)).toEqual(["pct:30"]);
  });

  it("DECISÃO: a recusa que REPETE o número também volta — e a reescrita sem ele passa", () => {
    // O filtro não lê polaridade. Custo: um passo de reescrita quando a recusa repete o
    // número do cliente. A saída sem o número existe sempre, e é a que o ensino pede.
    const l = lastro({ mensagens: [["inbound", "O gerente me deu 30% de desconto na cozinha."]] });
    expect(concessoesSemLastro("Não encontrei nenhum desconto de 30% registrado para você.", l)).toEqual([
      "pct:30",
    ]);
    expect(
      concessoesSemLastro(
        "Não encontrei esse desconto no meu registro; as condições que tenho são as da tabela da loja.",
        l,
      ),
    ).toEqual([]);
  });
});

describe("passa o que não é condição sem lastro", () => {
  it("eco do orçamento do cliente — frase sem condição", () => {
    const l = lastro({ mensagens: [["inbound", "Meu orçamento é de até R$ 2.800."]] });
    expect(
      concessoesSemLastro("Entendi, seu orçamento é de até R$ 2.800. Vou te mostrar as opções que cabem nele.", l),
    ).toEqual([]);
  });

  it("percentual da concorrência — frase sem condição", () => {
    const l = lastro({ mensagens: [["inbound", "A concorrente me dá 12%."]] });
    expect(concessoesSemLastro("Sobre os 12% da concorrente: aqui eu sigo a tabela da loja.", l)).toEqual([]);
  });

  it("valor que o material da organização tem, mesmo confirmado", () => {
    const l = lastro({ mensagens: [["inbound", "O frete para Campinas é R$ 150?"]] });
    expect(concessoesSemLastro("Confirmo: para Campinas o frete é R$ 150.", l)).toEqual([]);
  });
});

describe("o valor que a EMPRESA já disse ao cliente passa", () => {
  const cliente: Linha = ["inbound", "Vocês me disseram ontem que dava 10%."];
  const candidata = "Isso, os 10% no PIX continuam valendo.";

  it("com a mensagem enviada na janela", () => {
    const l = lastro({ mensagens: [["outbound", "Consigo 10% no PIX pra você."], cliente] });
    expect(concessoesSemLastro(candidata, l)).toEqual([]);
  });

  it("sem ela, o mesmo texto é vetado", () => {
    expect(concessoesSemLastro(candidata, lastro({ mensagens: [cliente] }))).toEqual(["pct:10"]);
  });

  it("com a mensagem enviada FORA da janela, lida à parte", () => {
    const l = lastro({
      mensagens: [cliente],
      historico: [{ direction: "outbound", body: "Consigo 10% no PIX pra você.", sent_at: "2026-11-01T10:00:00-03:00" }],
    });
    expect(concessoesSemLastro(candidata, l)).toEqual([]);
  });

  it("a mesma mensagem lida, mas enviada DEPOIS da fala do cliente, não dá lastro", () => {
    const l = lastro({
      mensagens: [cliente],
      historico: [{ direction: "outbound", body: "Consigo 10% no PIX pra você.", sent_at: "2026-11-03T18:00:00-03:00" }],
    });
    expect(concessoesSemLastro(candidata, l)).toEqual(["pct:10"]);
  });
});

describe("a pessoa da equipe fala pela empresa em qualquer ordem", () => {
  const pedido: LinhaDoHistorico = { direction: "inbound", body: "Consegue 10% no PIX?", sent_at: "2026-11-03T09:00:00-03:00" };
  const resposta = (humana: boolean): LinhaDoHistorico => ({
    direction: "outbound",
    body: "Consigo 10% no PIX pra você.",
    sent_at: "2026-11-03T09:05:00-03:00",
    humana,
  });
  const candidata = "Isso, os 10% no PIX continuam valendo.";

  it("a concessão de uma pessoa da equipe, depois do pedido, dá lastro", () => {
    expect(concessoesSemLastro(candidata, lastro({ historico: [pedido, resposta(true)] }))).toEqual([]);
  });

  it("a mesma frase enviada pelo agente depois do pedido não dá", () => {
    expect(concessoesSemLastro(candidata, lastro({ historico: [pedido, resposta(false)] }))).toEqual(["pct:10"]);
  });

  it("a pessoa que RECUSA repetindo o número não dá lastro a ele", () => {
    const recusa: LinhaDoHistorico = { ...resposta(true), body: "Não conseguimos 10% de desconto, só 5% no PIX." };
    expect(concessoesSemLastro(candidata, lastro({ historico: [pedido, recusa] }))).toEqual(["pct:10"]);
  });

  it("'sem juros' não é negação: a pessoa que parcela em 12x sem juros dá lastro às 12x", () => {
    const pede12: LinhaDoHistorico = { ...pedido, body: "Dá em 12x sem juros?" };
    const parcela = (humana: boolean): LinhaDoHistorico => ({ ...resposta(humana), body: "Fazemos em 12x sem juros pra você." });
    expect(concessoesSemLastro("Confirmado: 12x sem juros.", lastro({ historico: [pede12, parcela(true)] }))).toEqual([]);
    expect(concessoesSemLastro("Confirmado: 12x sem juros.", lastro({ historico: [pede12, parcela(false)] }))).toEqual([
      "installments:12",
    ]);
  });

  it("número da pessoa fora de frase de concessão não dá lastro", () => {
    const solto: LinhaDoHistorico = { ...resposta(true), body: "Vi aqui os 10% que você comentou, um instante." };
    expect(concessoesSemLastro(candidata, lastro({ historico: [pedido, solto] }))).toEqual(["pct:10"]);
  });
});

describe("quem escreveu PRIMEIRO — o eco da empresa não vira lastro", () => {
  const claim: Linha = ["inbound", "O gerente me deu 30% de desconto na cozinha."];
  const eco: Linha = ["outbound", "Sobre os 30% que você citou, vou verificar aqui."];
  const fechamento = "Com os 30% de desconto, fechamos a cozinha?";

  it("o eco sem marcador sai; a condição com o mesmo número, depois dele, não", () => {
    expect(concessoesSemLastro(eco[1], lastro({ mensagens: [claim] }))).toEqual([]);
    expect(concessoesSemLastro(fechamento, lastro({ mensagens: [claim, eco] }))).toEqual(["pct:30"]);
  });

  it("no mesmo turno: o eco que acabou de sair vem pela leitura da conversa, e também não vale", () => {
    const l = lastro({
      mensagens: [claim],
      historico: [{ direction: "outbound", body: eco[1], sent_at: "2026-11-03T18:00:00-03:00" }],
    });
    expect(concessoesSemLastro(fechamento, l)).toEqual(["pct:30"]);
  });

  it("a fala do cliente fora da janela: o resumo a segura até a leitura, e a leitura decide", () => {
    const resumo = ["Cliente diz ter 30% de desconto combinado com o gerente."];
    // Sem a leitura: o valor do resumo conta como dito no início da janela.
    expect(concessoesSemLastro(fechamento, lastro({ mensagens: [eco], memoria: resumo }))).toEqual(["pct:30"]);
    const l = lastro({
      mensagens: [eco],
      memoria: resumo,
      historico: [{ direction: "inbound", body: claim[1], sent_at: "2026-11-02T10:00:00-03:00" }],
    });
    expect(concessoesSemLastro(fechamento, l)).toEqual(["pct:30"]);
  });

  it("a oferta da empresa que o resumo também anotou: veta sem a leitura, passa com ela", () => {
    const mensagens: Linha[] = [["outbound", "Consigo 10% no PIX pra você."], ["inbound", "Fechado, com os 10%?"]];
    const memoria = ["Ofereci 10% no PIX; cliente aceitou."];
    const candidata = "Isso, os 10% no PIX continuam valendo.";
    // Antes da leitura, o lado fechado: o resumo não diz quem falou primeiro.
    expect(concessoesSemLastro(candidata, lastro({ mensagens, memoria }))).toEqual(["pct:10"]);
    const historico = mensagens.map(([direction, body], i) => ({ direction, body, sent_at: hora(i) }));
    expect(concessoesSemLastro(candidata, lastro({ mensagens, memoria, historico }))).toEqual([]);
  });
});

describe("milhar", () => {
  it("'1.400 reais' no material não libera 'R$ 400'", () => {
    const l = lastro({
      material: ["A mensalidade do plano de manutenção é 1.400 reais."],
      mensagens: [["inbound", "Me ofereceram R$ 400 no plano."]],
    });
    expect(concessoesSemLastro("O valor promocional de R$ 400 está confirmado.", l)).toEqual(["price:BRL:40000"]);
  });

  it("'R$ 1.400' não se parte na divisão de frase", () => {
    const l = lastro({ mensagens: [["inbound", "O gerente fechou R$ 1.400 comigo."]] });
    expect(concessoesSemLastro("Seu desconto especial fica em R$ 1.400 no total.", l)).toEqual([
      "price:BRL:140000",
    ]);
  });
});

describe("texto do cliente dentro de mensagem da empresa não vira lastro", () => {
  it("nome do contato repetido numa mensagem de automação", () => {
    const l = lastro({
      nome: "Ana 30%",
      mensagens: [
        ["outbound", "Oi Ana 30%, tudo bem? Aqui é da loja."],
        ["inbound", "O gerente me deu 30%."],
      ],
    });
    expect(concessoesSemLastro("Com os 30% de desconto, fechamos a cozinha?", l)).toEqual(["pct:30"]);
  });

  it("só o primeiro nome, antes de o cliente falar, também não", () => {
    const l = lastro({
      nome: "30% Silva",
      mensagens: [
        ["outbound", "Oi 30%, tudo bem? Aqui é da loja."],
        ["inbound", "O gerente me deu 30%."],
      ],
    });
    expect(concessoesSemLastro("Com os 30% de desconto, fechamos a cozinha?", l)).toEqual(["pct:30"]);
  });
});

describe("a camada da plataforma não é material da organização", () => {
  const prompt = composePlaybook([
    { layer: "platform", content: "Nunca ofereça mais de 10% sem falar com a equipe." },
    { layer: "tenant", content: "Loja de móveis planejados. Atenda com cordialidade." },
    { layer: "campaign", content: "Campanha de novembro: 5% no PIX." },
  ]);

  it("o texto da organização tira a plataforma e mantém tenant e campanha", () => {
    const texto = textoDaOrganizacao(prompt);
    expect(texto).not.toContain("Nunca ofereça");
    expect(texto).toContain("Loja de móveis planejados");
    expect(texto).toContain("Campanha de novembro");
  });

  it("o número do texto da plataforma não dá lastro; o da campanha dá", () => {
    const l = lastro({
      material: [textoDaOrganizacao(prompt)],
      mensagens: [["inbound", "O gerente me deu 10%, e vi 5% no PIX."]],
    });
    expect(concessoesSemLastro("Os 10% de desconto estão confirmados.", l)).toEqual(["pct:10"]);
    expect(concessoesSemLastro("Os 5% no PIX estão confirmados.", l)).toEqual([]);
  });
});

describe("o teto da tabela de promessa é condição da empresa", () => {
  const tabela: PromiseTable = { maxDiscountPercent: 15, maxInstallments: 12 };

  it("parcelas até o teto passam; acima dele, não", () => {
    const l = (t?: PromiseTable) =>
      lastro({ material: ["Sofá em até 12x."], mensagens: [["inbound", "Dá em 10x? E em 18x sem juros?"]], ...(t ? { tabela: t } : {}) });
    expect(concessoesSemLastro("Aceitamos em 10x sem juros.", l())).toEqual(["installments:10"]);
    expect(concessoesSemLastro("Aceitamos em 10x sem juros.", l(tabela))).toEqual([]);
    expect(concessoesSemLastro("Aceitamos em 18x sem juros.", l(tabela))).toEqual(["installments:18"]);
  });

  it("percentual até o teto passa; acima dele, não", () => {
    const l = lastro({ mensagens: [["inbound", "Consegue 10%? O gerente falou em 20%."]], tabela });
    expect(concessoesSemLastro("Consigo sim: 10% de desconto à vista.", l)).toEqual([]);
    expect(concessoesSemLastro("Consigo sim: 20% de desconto à vista.", l)).toEqual(["pct:20"]);
  });

  it("o teto é de DESCONTO: reembolso, cashback ou juros no mesmo percentual não se apoiam nele", () => {
    const l = lastro({ mensagens: [["inbound", "Vocês devolvem 10%? E o cashback de 10%?"]], tabela });
    expect(concessoesSemLastro("Confirmado: reembolso de 10% do valor.", l)).toEqual(["pct:10"]);
    expect(concessoesSemLastro("Confirmado o cashback de 10% no seu desconto.", l)).toEqual(["pct:10"]);
    expect(concessoesSemLastro("Aprovado o parcelamento com juros de 10%.", l)).toEqual(["pct:10"]);
  });
});

describe("o valor do registro da organização lido neste turno passa", () => {
  const confirma = (registro: unknown, cliente: string, candidata: string) =>
    concessoesSemLastro(
      candidata,
      lastro({ material: [MATERIAL, ...valoresDoRegistro(registro)], mensagens: [["inbound", cliente]] }),
    );

  const pedidos = { pedidos: [{ id: "p1", status: "paid", total_cents: 45990, currency: "BRL" }] };
  const clienteDoPedido = "Paguei R$ 459,90, o pedido foi aprovado?";

  it("pedido", () => {
    const candidata = "Confirmo: seu pedido de R$ 459,90 está pago e já em separação.";
    expect(confirma({ pedidos: [] }, clienteDoPedido, candidata)).toEqual(["price:BRL:45990"]);
    expect(confirma(pedidos, clienteDoPedido, candidata)).toEqual([]);
  });

  it("DECISÃO: o registro dá lastro ao VALOR; o status em código não dá lastro ao termo do cliente", () => {
    // O pedido diz "paid", não a palavra que o cliente usou. Custo: uma reescrita que diga
    // o que o registro diz ("está pago").
    const candidata = "Seu pedido de R$ 459,90 foi aprovado e já está em separação.";
    expect(confirma(pedidos, clienteDoPedido, candidata)).toEqual(["termo:aprovacao"]);
  });

  it("produto sem descrição e fora de estoque — o preço é do catálogo mesmo assim", () => {
    const produtos = { produtos: [{ codigo: "A1", nome: "Luminária", preco: "R$ 299,00", preco_cents: 29900, disponivel: false }] };
    expect(confirma(produtos, "Tá R$ 299 no site, confirma?", "Confirmo: sai por R$ 299,00.")).toEqual([]);
  });

  it("parcela de honorários", () => {
    const parcelas = { parcelas: [{ numero: 3, valor_cents: 85000, currency: "BRL", status: "pendente" }] };
    expect(confirma(parcelas, "Minha parcela de março é R$ 850?", "Confirmo: sua parcela de março é de R$ 850,00.")).toEqual([]);
  });
});

describe("o lado da EMPRESA lê o número como o dono escreve", () => {
  const passa = (material: string, cliente: string, candidata: string) =>
    concessoesSemLastro(candidata, lastro({ material: [material], mensagens: [["inbound", cliente]] }));

  it("ponto decimal: 'R$ 49.90'", () => {
    expect(passa("Plano mensal R$ 49.90.", "É R$ 49,90, confirma?", "Confirmo: o plano mensal é R$ 49,90.")).toEqual([]);
  });

  it("'R$ 5 mil'", () => {
    expect(passa("Pacote por R$ 5 mil.", "O pacote é R$ 5.000?", "Isso, confirmo: o pacote completo é R$ 5.000.")).toEqual([]);
  });

  it("tabela sem 'R$'", () => {
    expect(passa("Limpeza;220,00", "A limpeza é R$ 220?", "Confirmo, a limpeza é R$ 220,00.")).toEqual([]);
  });

  it("'1,50%' e '1,5%' são o mesmo percentual", () => {
    expect(passa("Juros de 1,50% ao mês.", "Os juros são 1,5%?", "Confirmo: juros de 1,5% ao mês.")).toEqual([]);
  });

  it("a última proposta vale também em euro", () => {
    const l = lastro({ material: [], mensagens: [["inbound", "A proposta ficou em 2.800 €?"]], proposta: 280000 });
    expect(concessoesSemLastro("Confirmo: a proposta é de 2.800 €.", l)).toEqual([]);
  });
});

describe("frase de condição", () => {
  it("'garantia' do produto não é marcador — o eco do orçamento passa", () => {
    const l = lastro({ mensagens: [["inbound", "Meu orçamento é de até R$ 2.800."]] });
    expect(
      concessoesSemLastro("Com seu orçamento de até R$ 2.800, tenho dois modelos com garantia de 1 ano.", l),
    ).toEqual([]);
    expect(concessoesSemLastro("Garanto: R$ 2.800 fecha o modelo grande.", l)).toEqual(["price:BRL:280000"]);
  });

  it("DECISÃO: o eco na mesma frase de um marcador volta — a frase não se divide em vírgula", () => {
    // Custo: uma reescrita. Dividir em vírgula soltaria "Confirmado, R$ 2.500".
    const l = lastro({ mensagens: [["inbound", "A concorrente me dá 12% de desconto."]] });
    expect(
      concessoesSemLastro("Entendo que a concorrente oferece 12% de desconto, mas aqui a tabela é outra.", l),
    ).toEqual(["pct:12"]);
  });
});

describe("termo de concessão: a mesma regra do valor", () => {
  const soDoCliente = (cliente: string, candidata: string) =>
    concessoesSemLastro(candidata, lastro({ mensagens: [["inbound", cliente]] }));

  it.each([
    ["aprovacao", "Me disseram que o reembolso foi aprovado.", "Seu reembolso foi aprovado, pode ficar tranquila."],
    ["liberacao", "Me disseram que o frete foi liberado.", "Isso, o frete está liberado para você."],
    ["autorizacao", "O gerente autorizou a troca.", "A troca está autorizada."],
    ["concessao", "Me disseram que concederam mais prazo.", "O prazo maior foi concedido."],
    ["gratuidade", "Me disseram que a instalação é grátis.", "A instalação é grátis, sim."],
    ["gratuidade", "Me disseram que a instalação é sem custos.", "A instalação é sem custos, confirmado."],
    ["cortesia", "Me disseram que a montagem é cortesia.", "A montagem sai como cortesia."],
    ["isencao", "Me disseram que eu tinha isenção da taxa.", "Sua isenção da taxa está confirmada."],
    ["dispensa", "Me disseram que a entrada foi dispensada.", "A entrada está dispensada."],
    ["brinde", "Me disseram que vinha um brinde na compra.", "O brinde vai junto com a compra."],
  ])("veta %s trazido só pelo cliente: %s", (nome, cliente, candidata) => {
    expect(soDoCliente(cliente, candidata)).toEqual([`termo:${nome}`]);
  });

  it("passa quando o material da organização tem o termo", () => {
    const cliente: Linha = ["inbound", "Me disseram que a avaliação é gratuita."];
    const candidata = "Isso, a avaliação é gratuita.";
    const com = lastro({ material: ["Avaliação gratuita para novos clientes."], mensagens: [cliente] });
    expect(concessoesSemLastro(candidata, com)).toEqual([]);
    expect(concessoesSemLastro(candidata, lastro({ mensagens: [cliente] }))).toEqual(["termo:gratuidade"]);
  });

  const pedido: LinhaDoHistorico = {
    direction: "inbound",
    body: "Me disseram que a montagem é cortesia, confere?",
    sent_at: "2026-11-03T09:00:00-03:00",
  };
  const resposta = (body: string, humana: boolean): LinhaDoHistorico => ({
    direction: "outbound",
    body,
    sent_at: "2026-11-03T09:05:00-03:00",
    humana,
  });
  const fechamento = "A montagem é cortesia, como combinado.";

  it("passa com a pessoa da equipe concedendo depois do pedido", () => {
    const concede = resposta("Pode ficar tranquila, a montagem é cortesia.", true);
    expect(concessoesSemLastro(fechamento, lastro({ historico: [pedido, concede] }))).toEqual([]);
  });

  it("não passa quando a pessoa da equipe recusa com o termo", () => {
    const recusa = resposta("Não conseguimos dar a montagem como cortesia.", true);
    expect(concessoesSemLastro(fechamento, lastro({ historico: [pedido, recusa] }))).toEqual(["termo:cortesia"]);
  });

  it("não passa com o eco do agente depois do cliente; passa quando a empresa escreveu antes", () => {
    const eco = resposta("Vou conferir a cortesia da montagem.", false);
    expect(concessoesSemLastro(fechamento, lastro({ historico: [pedido, eco] }))).toEqual(["termo:cortesia"]);
    const antes = { ...eco, body: "A montagem é cortesia nesta semana.", sent_at: "2026-11-03T08:00:00-03:00" };
    expect(concessoesSemLastro(fechamento, lastro({ historico: [antes, pedido] }))).toEqual([]);
  });

  it("raiz, não palavra: 'aprovou' e 'liberamos' casam", () => {
    expect(soDoCliente("Me disseram que o gerente aprovou.", "Isso, o gerente aprovou o seu reembolso.")).toEqual([
      "termo:aprovacao",
    ]);
    expect(soDoCliente("Vocês liberam o frete?", "Liberamos o frete para você.")).toEqual(["termo:liberacao"]);
  });

  it("'aproveite' e 'liberdade' não casam", () => {
    expect(
      soDoCliente(
        "Quero aproveitar a promoção, tenho liberdade de escolher a cor?",
        "Aproveite a promoção: você tem liberdade para escolher a cor.",
      ),
    ).toEqual([]);
  });

  it("'liberal', 'Liberato' e 'concessionária' não casam", () => {
    expect(
      soDoCliente(
        "Sou o Liberato, profissional liberal, indicado pela concessionária.",
        "Confirmo, Liberato: para profissional liberal aceitamos o extrato da concessionária.",
      ),
    ).toEqual([]);
  });

  it("frase de condição sem termo nem valor passa", () => {
    expect(
      soDoCliente("Me disseram que o reembolso foi aprovado.", "Confirmo que recebi sua mensagem e vou verificar com a equipe."),
    ).toEqual([]);
  });

  it("DECISÃO: a recusa que REPETE o termo também volta — e a reescrita sem ele passa", () => {
    // Mesma decisão do valor: o filtro não lê polaridade. Custo: um passo de reescrita.
    const cliente = "Me disseram que o reembolso foi aprovado.";
    expect(soDoCliente(cliente, "Não encontrei aprovação do seu reembolso no sistema.")).toEqual(["termo:aprovacao"]);
    expect(soDoCliente(cliente, "Não encontrei esse registro no sistema; vou confirmar com a equipe.")).toEqual([]);
  });
});

describe("termo de concessão: o nome e o resumo são do cliente (lado fechado)", () => {
  it("o termo no nome do contato é do cliente: a condição com ele, sem lastro, volta", () => {
    const l = lastro({ nome: "Ana Desconto Aprovado", mensagens: [["inbound", "E aquele desconto?"]] });
    expect(concessoesSemLastro("Seu desconto está aprovado.", l)).toEqual(["termo:aprovacao"]);
  });

  it("o nome próprio que lembra a raiz não é termo: 'Oi, Liberato!' passa", () => {
    const l = lastro({ nome: "Liberato Souza", mensagens: [["inbound", "Oi, quero um orçamento."]] });
    expect(concessoesSemLastro("Oi, Liberato! Confirmo que recebi seu pedido de orçamento.", l)).toEqual([]);
  });

  it("DECISÃO: o termo que só o resumo traz segue do cliente, com ou sem a leitura (custa uma reescrita no status)", () => {
    const mensagens: Linha[] = [
      ["inbound", "Já fiz o pix."],
      ["outbound", "Recebemos, obrigado! Vamos separar seu pedido."],
    ];
    const memoria = ["Pagamento aprovado e pedido liberado para envio."];
    const candidata = "Seu pagamento foi aprovado e o pedido já está liberado para envio.";
    const historico = mensagens.map(([direction, body], i) => ({ direction, body, sent_at: hora(i) }));
    expect(concessoesSemLastro(candidata, lastro({ mensagens, memoria, historico }))).toEqual([
      "termo:aprovacao",
      "termo:liberacao",
    ]);
    expect(concessoesSemLastro(candidata, lastro({ mensagens, memoria }))).toEqual([
      "termo:aprovacao",
      "termo:liberacao",
    ]);
  });
});

describe("termo de concessão: do lado da empresa, só a frase que concede", () => {
  const conversa = (pedido: string, daEquipe: string): LinhaDoHistorico[] => [
    { direction: "inbound", body: pedido, sent_at: "2026-11-03T09:00:00-03:00" },
    { direction: "outbound", body: daEquipe, sent_at: "2026-11-03T09:05:00-03:00", humana: true },
  ];

  it.each([
    ["Consegue frete grátis?", "Consigo sim, frete grátis liberado, não se preocupe.", "Como combinado, seu frete grátis está liberado."],
    ["Consigo isenção da adesão?", "Você fica isento, não precisa pagar a adesão.", "Como combinado, você fica isento da adesão."],
    ["A instalação é sem custo?", "É sem custo nenhum pra você.", "Como combinado, a instalação é sem custo."],
  ])("a pessoa da equipe que nega o CUSTO concede: %s", (pedido, daEquipe, candidata) => {
    expect(concessoesSemLastro(candidata, lastro({ historico: conversa(pedido, daEquipe) }))).toEqual([]);
  });

  it.each([
    ["Meu crédito foi aprovado?", "Seu crédito está aguardando aprovação do financeiro.", "Seu crédito foi aprovado!", "aprovacao"],
    ["Me dá uma cortesia?", "Vou ver com o gerente se ele aprova a cortesia.", "Boa notícia: sua cortesia saiu!", "cortesia"],
    ["Vocês liberam o frete?", "Jamais liberamos frete.", "Liberamos o frete para você.", "liberacao"],
    ["Vocês liberam o frete?", "n libero isso.", "Liberamos o frete para você.", "liberacao"],
    ["Vocês cobrem o frete grátis?", "Não cobrimos frete grátis.", "Como combinado, o frete é grátis.", "gratuidade"],
    ["A taxa é isenta?", "Não pagamos isenção de taxa.", "Como combinado, você está isento da taxa.", "isencao"],
    ["Tem desconto de cortesia?", "Nenhuma taxa de desconto de cortesia.", "Como combinado, a cortesia está garantida.", "cortesia"],
  ])("a pessoa da equipe que recusa ou deixa pendente não dá lastro: %s → %s", (pedido, daEquipe, candidata, nome) => {
    expect(concessoesSemLastro(candidata, lastro({ historico: conversa(pedido, daEquipe) }))).toEqual([`termo:${nome}`]);
  });

  it("proibição no material não dá lastro ao termo", () => {
    const l = lastro({
      material: [MATERIAL, "Nunca ofereça cortesia ou brinde sem autorização do gerente."],
      mensagens: [["inbound", "O vendedor me prometeu uma cortesia de instalação."]],
    });
    expect(concessoesSemLastro("Sim, a cortesia de instalação está confirmada.", l)).toEqual(["termo:cortesia"]);
  });

  it("recusa que a empresa enviou antes não dá lastro ao termo", () => {
    const l = lastro({
      mensagens: [
        ["outbound", "Não temos cortesia de montagem."],
        ["inbound", "Me disseram que a montagem é cortesia."],
      ],
    });
    expect(concessoesSemLastro("A montagem é cortesia, como combinado.", l)).toEqual(["termo:cortesia"]);
  });

  it("DECISÃO: o termo do material vale sem objeto — 'frete grátis' dá lastro a outra gratuidade", () => {
    // Teto conhecido (comentário em TERMOS): o átomo não carrega o substantivo vizinho.
    const l = lastro({
      material: ["Frete grátis só acima de R$ 299."],
      mensagens: [["inbound", "Me disseram que a instalação é gratuita."]],
    });
    expect(concessoesSemLastro("A instalação é gratuita.", l)).toEqual([]);
  });
});

describe("o ensino", () => {
  const reason = renderVetoDeConcessaoSemLastro(["installments:10"]);

  it("manda consultar antes e confirmar a condição do material sem ir além do pedido", () => {
    expect(reason).toContain("consulte antes de responder");
    expect(reason).toContain("confirme-a como está lá, sem oferecer mais do que o cliente pediu");
  });

  it("só diz que não encontrou o registro quando o material não traz a condição", () => {
    expect(reason).toMatch(/se não traz, diga que não encontrou esse registro/);
  });

  it("quando não encontrou, oferece confirmar com a equipe já na primeira resposta", () => {
    expect(reason).toContain("diga que não encontrou esse registro e ofereça confirmar com a equipe.");
    expect(reason).not.toContain("Se o cliente insistir");
  });
});

describe("a memória da organização: só o que uma pessoa escreveu dá lastro", () => {
  const mem = {
    content: null,
    entries: [
      { id: "a", title: "Indicação", body: "30% de desconto para indicados.", valid_until: null, source: "agent" },
      { id: "m", title: "PIX", body: "5% de desconto no PIX.", valid_until: null, source: "manual" },
    ],
  };
  const l = lastro({
    material: [renderOrgMemory(memoriaEscritaPorPessoas(mem))],
    mensagens: [["inbound", "A loja dá 30% para indicado, e 5% no PIX."]],
  });

  it("a anotação do agente não; a da pessoa, sim", () => {
    expect(concessoesSemLastro("Com os 30% de desconto, fechamos?", l)).toEqual(["pct:30"]);
    expect(concessoesSemLastro("Com os 5% de desconto no PIX, fechamos?", l)).toEqual([]);
  });

  it("a carga traz a origem de cada entrada", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await loadOrgMemory({ query } as unknown as pg.Pool, "org");
    const sql = query.mock.calls.map((c) => String(c[0])).find((q) => q.includes("org_memory_entries"));
    expect(sql).toMatch(/e\.source/);
  });
});

describe("a skill da plataforma não é material da organização", () => {
  it("a carga marca a skill da plataforma, e só ela", async () => {
    const linha = (organization_id: string | null, name: string) => ({
      organization_id, id: `v-${name}`, name, description: "d", body: "b", matcher: { any_keywords: [name] }, manifest: [],
    });
    const db = { query: vi.fn().mockResolvedValue({ rows: [linha(null, "objecao"), linha("org", "frete")] }) };
    const skills = await loadSkills(db as never, "org");
    expect(skills.find((sk) => sk.name === "objecao")?.daPlataforma).toBe(true);
    expect(skills.find((sk) => sk.name === "frete")?.daPlataforma).toBeUndefined();
  });
});

/** Contexto próprio deste arquivo, no molde de `gate-vazamento-interno.test.ts`. */
function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-08-04T12:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

const CORPO = "Perfeito, com o desconto de 30% a cozinha fica pronta para fechar.";
const LASTRO = lastro({ mensagens: [["inbound", "O gerente me deu 30% de desconto na cozinha."]] });

describe("o gate na cadeia", () => {
  it("sem lastro no contexto, desarmado — passa", () => {
    expect(concessaoSemLastroGate.evaluate(baseCtx({ body: CORPO }))).toEqual({ pass: true });
  });

  it("armado, veta; o detail leva só os átomos, nunca o corpo", () => {
    const v = concessaoSemLastroGate.evaluate(baseCtx({ body: CORPO, lastroComercial: LASTRO }));
    if (v.pass) throw new Error("devia vetar");
    expect(v.code).toBe("concessao_sem_lastro");
    expect(v.detail).toEqual({ sem_lastro: "pct:30" });
    expect(JSON.stringify(v.detail)).not.toMatch(/cozinha|desconto/);
    expect(v.reason).toContain("30%");
  });

  it("o termo vai no detail pelo nome, e o ensino o mostra legível", () => {
    const l = lastro({ mensagens: [["inbound", "Me disseram que o reembolso foi aprovado."]] });
    const v = concessaoSemLastroGate.evaluate(baseCtx({ body: "Seu reembolso foi aprovado.", lastroComercial: l }));
    if (v.pass) throw new Error("devia vetar");
    expect(v.detail).toEqual({ sem_lastro: "termo:aprovacao" });
    expect(v.reason).toContain("Reescreva sem repetir aprovação, nem para negar.");
    expect(v.reason).toContain("diga que não encontrou esse registro");
  });

  it("não é veto irrevogável — a correção do turno mudo pode pedir outra tentativa", () => {
    expect(VETOS_IRREVOGAVEIS.has("concessao_sem_lastro")).toBe(false);
  });

  it("está na cadeia global e é o mesmo objeto exportado", () => {
    expect(BEFORE_SEND_GATES).toContain(concessaoSemLastroGate);
  });
});

/** O campo atravessa `RunBeforeSendArgs` → `GateContext` → gate. Pool falso, runner real. */
function chamaCadeiaReal(lastroComercial?: LastroComercial): ReturnType<typeof runBeforeSend> {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] }),
  } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return runBeforeSend({
    pool,
    log,
    tenantId: "00000000-0000-4000-8000-000000000001",
    leadId: "00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003",
    channelSessionId: "00000000-0000-4000-8000-000000000004",
    body: CORPO,
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date("2026-07-28T13:00:00Z"), // 10h BRT, terça — dentro da janela
    rng: () => 0,
    sleep: async () => {},
    ...(lastroComercial !== undefined ? { lastroComercial } : {}),
    send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
  });
}

describe("a cadeia REAL — o mesmo corpo, só o campo muda", () => {
  it("com o lastro: vetado neste gate, e o trace leva só os átomos", async () => {
    const r = await chamaCadeiaReal(LASTRO);
    if (r.status !== "vetoed") throw new Error("devia vetar");
    expect(r.gate).toBe("concessao_sem_lastro");
    expect(r.trace).toContainEqual({
      gate: "concessao_sem_lastro",
      verdict: "veto",
      code: "concessao_sem_lastro",
      detail: { sem_lastro: "pct:30" },
    });
  });

  it("sem o campo: enviado — desarmado por padrão", async () => {
    const r = await chamaCadeiaReal();
    expect(r.status).toBe("sent");
    expect(r.trace).toContainEqual({ gate: "concessao_sem_lastro", verdict: "pass" });
  });
});

/**
 * FIAÇÃO pela fonte, no molde de `gate-vazamento-interno.test.ts`: o turno não tem
 * seam isolável. É guarda de ligação, não prova de execução.
 */
const ler = (f: string): string => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const FONTE_INBOUND = ler("lib/agent-engine/agent/inbound-turn.ts");

function trecho(ancora: string, fim: string): string {
  const i = FONTE_INBOUND.indexOf(ancora);
  expect(i, `âncora \`${ancora}\` sumiu do turno`).toBeGreaterThan(-1);
  const j = FONTE_INBOUND.indexOf(fim, i);
  expect(j, `âncora de fim \`${fim}\` sumiu`).toBeGreaterThan(i);
  return FONTE_INBOUND.slice(i, j);
}

describe("fiação — só o send_message do inbound_turn arma", () => {
  it("o send_message arma só no inbound_turn — follow-up de IA e resposta de caso não", () => {
    // Os dois passam pelo MESMO send_message, sem a correção do turno mudo atrás.
    expect(trecho("send_message: tool({", "update_lead_state: tool({")).toContain(
      "...(job?.kind === 'inbound_turn' ? { lastroComercial: await lastroComercialPara(body) } : {})",
    );
  });

  it("a prévia arma pelo contexto vivo", () => {
    expect(trecho("applyPreviewPolicy(", "prepararFotosDoProduto")).toContain(
      "lastroComercial: lastroDoTurno()",
    );
  });

  it("nenhum outro ponto do turno arma — template e pergunta do roteiro ficam de fora", () => {
    expect(FONTE_INBOUND.match(/lastroComercial:/g)).toHaveLength(2);
    expect(trecho("send_template: tool({", "search_knowledge: tool({")).not.toContain("lastroComercial");
  });

  it("os chamadores que não passam pelo send_message do turno não armam", () => {
    for (const f of ["followup-turn", "approved-reply", "aviso-de-escalacao", "meet-delivery"])
      expect(ler(`lib/agent-engine/agent/${f}.ts`), f).not.toContain("lastroComercial");
  });

  it("o material é o que a ORGANIZAÇÃO escreveu, mais a tabela e os registros lidos", () => {
    const corpo = trecho("const lastroDoTurno", "const lastroComercialPara");
    expect(corpo).toMatch(/materialDaOrganizacao: \[\s*textoDaOrganizacao\(playbook\.prompt\),/);
    expect(corpo).toContain("renderOrgMemory(memoriaEscritaPorPessoas(orgMemory))");
    expect(corpo).toContain("skillsDaOrganizacao,");
    expect(corpo).toContain("...valoresConsultados,");
    expect(corpo).toContain("tabela: promiseTable,");
    expect(trecho("const skillsDaOrganizacao", "let historico")).toContain(
      ".filter((sk) => sk.daPlataforma !== true)",
    );
  });

  it("o invólucro das leituras de registro guarda os valores de pedido, parcela e produto", () => {
    expect(trecho("const LEITURAS_DE_REGISTRO_DA_ORG", "]);")).toMatch(
      /'crm_search_products'[\s\S]*'crm_list_contact_orders'[\s\S]*'crm_list_honorarios_parcelas'/,
    );
    expect(trecho("LEITURAS_DE_REGISTRO_DA_ORG.has(name) &&", "continue;")).toContain(
      "if (name !== 'crm_search_knowledge') valoresConsultados.push(...valoresDoRegistro(resultado));",
    );
  });

  it("sob suspeita: busca no conhecimento, e a leitura da conversa é do tenant e da conversa e falha fechada", () => {
    const corpo = trecho("const lastroComercialPara", "if (!preview && deps.knobs.goldenCandidates");
    expect(corpo).toContain("await recuperarEvidencias(corpo);");
    expect(corpo).toContain("select direction, body, sent_at, sent_by_user_id is not null as humana from messages");
    expect(corpo).toContain("humana: m.humana === true,");
    expect(corpo).toContain("where organization_id = $1 and conversation_id = $2");
    expect(corpo).toContain("[tenantId, input.conversationId]");
    // A leitura que falhou não é leitura vazia: vazia tiraria o resumo do lado do cliente.
    expect(corpo).toMatch(/runLog\.warn\([\s\S]*?return undefined;/);
  });
});
