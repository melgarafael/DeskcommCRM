/**
 * A POLÍTICA DE QUEDA DA ASSINATURA É O QUE O ITEM 3 DA ISSUE #1639 PEDE.
 *
 * A issue descreve o caminho novo em quatro itens, e três deles dependem de
 * decisões que o mantenedor ainda não tomou (como o login do Codex é obtido,
 * guardado e renovado; onde mora o token; se nasce desligado). O item 3 é o
 * único escrito por inteiro — e é o que dói: uma queda mal classificada troca a
 * conta da empresa errada, manda o mesmo corpo recusado para outra credencial, ou
 * deixa o cliente sem resposta.
 *
 * Cada caso aqui é um formato de falha REAL do caminho por assinatura: janela de
 * uso estourada, token do login vencido, assinatura inativa, 5xx do provedor e
 * rede — mais o 4xx que NÃO é da credencial e que, por isso, não cai.
 */
import { describe, expect, it } from "vitest";

import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";
import {
  PROVEDOR_DE_RESERVA_DA_ASSINATURA,
  PROVEDOR_POR_ASSINATURA,
  classificarFalhaDaAssinatura,
  decidirQuedaDaAssinatura,
  decidirQuedaDoProvedor,
  provedorDeReserva,
  type DecisaoDaQueda,
  type MotivoDaQueda,
} from "@/lib/ai/pontos/reserva-da-assinatura";

describe("classificarFalhaDaAssinatura — o que aconteceu", () => {
  const casos: [string, number | null, string | null, MotivoDaQueda | null][] = [
    ["janela de uso estourada", 429, null, "limite_de_uso"],
    ["crédito esgotado devolve 402", 402, null, "limite_de_uso"],
    ["400 de payload: a chamada é que está errada", 400, "invalid tool schema", null],
    ["404 de rota desconhecida", 404, "not found", null],
    ["422 de parâmetro", 422, "unprocessable", null],
    ["401 sem sinal de expiração: assinatura recusada", 401, "invalid api key", "sem_autorizacao"],
    ["403 idem", 403, "forbidden", "sem_autorizacao"],
    ["401 dizendo que venceu", 401, "token expired", "token_expirado"],
    ["401 dizendo que expirou, em português", 401, "login expirado", "token_expirado"],
    ["401 de refresh recusado", 401, "invalid_grant", "token_expirado"],
    ["500 do provedor", 500, null, "falha_do_provedor"],
    ["503 do provedor", 503, null, "falha_do_provedor"],
    ["sem resposta: rede", null, null, "rede"],
    ["sem resposta com detalhe de rede", null, "fetch failed", "rede"],
  ];

  it.each(casos)("%s", (_nome, status, detalhe, esperado) => {
    expect(classificarFalhaDaAssinatura(status, detalhe)).toBe(esperado);
  });

  it("200 e 201 não são queda", () => {
    expect(classificarFalhaDaAssinatura(200)).toBeNull();
    expect(classificarFalhaDaAssinatura(201, "created")).toBeNull();
  });
});

describe("decidirQuedaDaAssinatura — para onde vai", () => {
  it("com reserva, cai para a chave de API da organização", () => {
    const decisao = decidirQuedaDaAssinatura({ motivo: "limite_de_uso", temChaveDeReserva: true });
    expect(decisao).toEqual({
      acao: "tentar_reserva",
      provedorDeReserva: PROVEDOR_DE_RESERVA_DA_ASSINATURA,
      motivo: "limite_de_uso",
    });
  });

  it("vida longa ao 429: a queda vale para os cinco motivos", () => {
    const motivos: MotivoDaQueda[] = [
      "limite_de_uso",
      "token_expirado",
      "sem_autorizacao",
      "falha_do_provedor",
      "rede",
    ];
    for (const motivo of motivos) {
      const decisao = decidirQuedaDaAssinatura({ motivo, temChaveDeReserva: true });
      expect(decisao?.acao, `${motivo} deveria cair para a reserva`).toBe("tentar_reserva");
    }
  });

  it("sem chave de reserva, a conversa vai para um humano — nunca fica calada", () => {
    const decisao = decidirQuedaDaAssinatura({ motivo: "token_expirado", temChaveDeReserva: false });
    expect(decisao).toEqual({ acao: "passar_para_humano", motivo: "token_expirado" });
    // O motivo é o que o chamador registra no painel para explicar a troca.
    expect(decisao && "motivo" in decisao ? decisao.motivo : null).toBe("token_expirado");
  });

  it("sem falha não há decisão", () => {
    expect(decidirQuedaDaAssinatura({ motivo: null, temChaveDeReserva: true })).toBeNull();
    expect(decidirQuedaDaAssinatura({ motivo: null, temChaveDeReserva: false })).toBeNull();
  });
});

describe("decidirQuedaDoProvedor — quem tem direito a cair", () => {
  it("a assinatura que falhou cai para a chave da organização", () => {
    const decisao = decidirQuedaDoProvedor({
      provider: PROVEDOR_POR_ASSINATURA,
      status: 429,
      temChaveDeReserva: true,
    });
    expect(decisao?.acao).toBe("tentar_reserva");
  });

  it("o 400 NÃO cai, mesmo com reserva cadastrada", () => {
    // O corpo recusado seria recusado de novo pela outra credencial: duas
    // chamadas para colher dois erros, e o defeito nosso sai de vista.
    const decisao: DecisaoDaQueda | null = decidirQuedaDoProvedor({
      provider: PROVEDOR_POR_ASSINATURA,
      status: 400,
      detalhe: "invalid request",
      temChaveDeReserva: true,
    });
    expect(decisao).toBeNull();
  });

  it("provedor nativo que falha segue com o desfecho de sempre — não cai para chave alheia", () => {
    for (const id of IDS_DE_PROVEDOR) {
      expect(
        decidirQuedaDoProvedor({ provider: id, status: 401, temChaveDeReserva: true }),
        `${id} não é proveniente do caminho por assinatura e não pode cair para outra credencial`,
      ).toBeNull();
    }
  });

  it("o provedor desconhecido também não cai", () => {
    expect(
      decidirQuedaDoProvedor({ provider: "openai-assinatura-antiga", status: 429, temChaveDeReserva: true }),
    ).toBeNull();
  });
});

describe("a reserva é um par declarado, e a queda é assimétrica", () => {
  it("a assinatura tem reserva, e é a chave de API da OpenAI", () => {
    expect(provedorDeReserva(PROVEDOR_POR_ASSINATURA)).toBe("openai");
    expect(PROVEDOR_DE_RESERVA_DA_ASSINATURA).toBe("openai");
  });

  it("o id da assinatura é NOVO — não se disfarça de `openai`", () => {
    // Se os dois fossem o mesmo id, a reserva seria o caminho que falhou: a
    // queda cairia em si mesma e o cliente ficaria sem resposta.
    expect(PROVEDOR_POR_ASSINATURA).not.toBe(PROVEDOR_DE_RESERVA_DA_ASSINATURA);
  });

  it("`openai` não tem reserva: a queda nunca é da chave para a assinatura", () => {
    expect(provedorDeReserva("openai")).toBeNull();
    expect(provedorDeReserva("anthropic")).toBeNull();
    expect(provedorDeReserva("custom")).toBeNull();
  });
});
