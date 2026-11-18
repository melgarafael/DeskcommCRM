import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CAMINHOS_DO_HOTMART, isHotmartPayload, mapHotmartPayload } from "@/lib/webhooks/hotmart";
import { isElementorPayload } from "@/lib/webhooks/elementor";
import { isRdStationPayload } from "@/lib/webhooks/rdstation";
import { isRespondiPayload } from "@/lib/webhooks/respondi";
import { mapInboundPayload } from "@/lib/webhooks/inbound";

/**
 * O corpo REAL do webhook 2.0.0 (`PURCHASE_APPROVED`), como a documentação do
 * Hotmart o descreve e como ele chega na rota, SANITIZADO: nome, e-mail,
 * telefone, transação e produto trocados por valores fictícios; mesma
 * ESTRUTURA e mesmos NOMES DE CAMPO. O arquivo é o mesmo que a rota usa no
 * teste de caminho completo (`app/api/v1/webhooks/in/[token]/route.test.ts`).
 */
const FIXTURE = readFileSync("tests/fixtures/webhooks/hotmart-compra-aprovada.json", "utf8");

function corpo(): Record<string, unknown> {
  return JSON.parse(FIXTURE) as Record<string, unknown>;
}

/** O `data` do fixture, mutável — cada caso troca só o que mede. */
function comData(mudar: (data: Record<string, unknown>) => void): Record<string, unknown> {
  const c = corpo();
  mudar(c.data as Record<string, unknown>);
  return c;
}

describe("isHotmartPayload", () => {
  it("reconhece o aviso de compra do fixture", () => {
    expect(isHotmartPayload(corpo())).toBe(true);
  });

  it("reconhece qualquer evento da família PURCHASE_*", () => {
    for (const evento of ["PURCHASE_COMPLETE", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK"]) {
      expect(isHotmartPayload({ ...corpo(), event: evento })).toBe(true);
    }
  });

  it("não captura payload de outra origem", () => {
    // O genérico (formulário plano, Zapier, n8n, o "Enviar lead de teste").
    expect(isHotmartPayload({ nome: "Ana", telefone: "11998765432", email: "ana@example.com" })).toBe(false);
    expect(isHotmartPayload(null)).toBe(false);
    expect(isHotmartPayload("texto")).toBe(false);
    expect(isHotmartPayload([])).toBe(false);
    // Evento fora da família de compra, mesmo com `data`.
    expect(isHotmartPayload({ event: "SUBSCRIPTION_CANCELLATION", data: { buyer: {} } })).toBe(false);
    // Sem bloco `data` não é o envelope do Hotmart 2.0.0.
    expect(isHotmartPayload({ event: "PURCHASE_APPROVED", buyer: { name: "Ana" } })).toBe(false);
    // `data` sem nenhum dos blocos do evento.
    expect(isHotmartPayload({ event: "PURCHASE_APPROVED", data: { foo: 1 } })).toBe(false);
  });

  it("não é confundido com as formas dos três leitores que já existem", () => {
    expect(isRespondiPayload(corpo())).toBe(false);
    expect(isRdStationPayload(corpo())).toBe(false);
    expect(isElementorPayload(corpo())).toBe(false);
  });
});

describe("mapHotmartPayload — a identidade está dentro dos blocos", () => {
  it("⭐ extrai nome, telefone e e-mail do bloco `data.buyer`", () => {
    const mapped = mapHotmartPayload(corpo());

    expect(mapped.name).toBe("Comprador De Teste");
    expect(mapped.email).toBe("comprador.teste@exemplo.com.br");
    // `checkout_phone` (999999999) + `checkout_phone_code` (31), compostos.
    expect(mapped.phone).toBe("+5531999999999");
  });

  it("⭐ o genérico continua devolvendo vazio para a MESMA carga — é o defeito da issue", () => {
    const generico = mapInboundPayload(corpo());
    expect(generico.name).toBeNull();
    expect(generico.phone).toBeNull();
    expect(generico.email).toBeNull();
  });

  it("a transação é a identidade da compra (`PURCHASE_APPROVED` e `COMPLETE` no mesmo card)", () => {
    const aprovada = mapHotmartPayload(corpo());
    const completa = mapHotmartPayload({ ...corpo(), event: "PURCHASE_COMPLETE" });

    expect(aprovada.externalId).toBe("hotmart:HP00000000000001");
    expect(completa.externalId).toBe(aprovada.externalId);
  });

  it("leva os metadados NOMEADOS da compra — e só eles", () => {
    const { custom_fields } = mapHotmartPayload(corpo());

    expect(custom_fields).toEqual({
      hotmart_event: "PURCHASE_APPROVED",
      hotmart_transaction: "HP00000000000001",
      hotmart_status: "APPROVED",
      hotmart_produto: "Curso de Exemplo",
      hotmart_oferta: "n82b9jqz",
      hotmart_preco: "150.6",
      hotmart_moeda: "BRL",
    });
    // Não é varredura: o resto do envelope (endereço, documento, afiliado,
    // produtor, comissões) não vira campo do card.
    expect(Object.keys(custom_fields).some((k) => k.startsWith("data."))).toBe(false);
  });

  it("sem ambiguidade não grava a escolha — o metadado é sinal, não ruído", () => {
    expect(mapHotmartPayload(corpo()).source_metadata).toEqual({});
  });
});

describe("mapHotmartPayload — caminho ausente não inventa valor", () => {
  it("⭐ carga sem o bloco `buyer` devolve vazio sem erro", () => {
    const semComprador = comData((data) => {
      delete data.buyer;
    });

    const mapped = mapHotmartPayload(semComprador);

    expect(mapped.name).toBeNull();
    expect(mapped.phone).toBeNull();
    expect(mapped.email).toBeNull();
    // O evento em si continua legível: o que falta é a identidade, não a compra.
    expect(mapped.custom_fields.hotmart_transaction).toBe("HP00000000000001");
    expect(mapped.externalId).toBe("hotmart:HP00000000000001");
  });

  it("comprador SEM telefone e SEM e-mail: só o nome, nada inventado", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        const buyer = data.buyer as Record<string, unknown>;
        delete buyer.checkout_phone;
        delete buyer.checkout_phone_code;
        delete buyer.email;
      }),
    );

    expect(mapped.name).toBe("Comprador De Teste");
    expect(mapped.phone).toBeNull();
    expect(mapped.email).toBeNull();
    expect(mapped.source_metadata.raw_phone).toBeUndefined();
  });

  it("sem `checkout_phone_code` o número não ganha DDD de lugar nenhum", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        delete (data.buyer as Record<string, unknown>).checkout_phone_code;
      }),
    );

    // 9 dígitos não formam telefone brasileiro: fica o rastro, não um número
    // remendado com o DDD de outro caminho.
    expect(mapped.phone).toBeNull();
    expect(mapped.source_metadata.raw_phone).toBe("999999999");
  });

  it("carga vazia não lança", () => {
    expect(() => mapHotmartPayload({})).not.toThrow();
    expect(mapHotmartPayload({}).name).toBeNull();
  });
});

describe("mapHotmartPayload — telefone", () => {
  it("⭐ comprador de fora: número internacional com DDI é reconhecido", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        const buyer = data.buyer as Record<string, unknown>;
        buyer.checkout_phone = "+351912345678";
        buyer.checkout_phone_code = undefined;
        (buyer.address as Record<string, unknown>).country_iso = "PT";
        (data.purchase as Record<string, unknown>).checkout_country = { name: "Portugal", iso: "PT" };
      }),
    );

    expect(mapped.phone).toBe("+351912345678");
  });

  it("⭐ comprador de fora SEM o `+`: o código do país vem junto e a forma é reconhecida", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        const buyer = data.buyer as Record<string, unknown>;
        buyer.checkout_phone = "351912345678";
        buyer.checkout_phone_code = undefined;
        (buyer.address as Record<string, unknown>).country_iso = "PT";
      }),
    );

    expect(mapped.phone).toBe("+351912345678");
  });

  it("brasileiro cujo `checkout_phone` já traz o 55 não recebe o DDD de novo", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        (data.buyer as Record<string, unknown>).checkout_phone = "5531999999999";
      }),
    );

    expect(mapped.phone).toBe("+5531999999999");
  });
});

describe("mapHotmartPayload — dois caminhos, um vencedor declarado", () => {
  it("⭐ nome completo vence as partes, e a escolha fica registrada", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        (data.buyer as Record<string, unknown>).name = "Comprador de Teste Silva";
      }),
    );

    expect(mapped.name).toBe("Comprador de Teste Silva");
    expect(mapped.source_metadata.hotmart_campo_ambiguo).toBe(`nome:${CAMINHOS_DO_HOTMART.nome}`);
  });

  it("sem `name`, as partes declaradas compõem o nome", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        delete (data.buyer as Record<string, unknown>).name;
      }),
    );

    expect(mapped.name).toBe("Comprador De Teste");
    expect(mapped.source_metadata.hotmart_campo_ambiguo).toBeUndefined();
  });

  it("país do comprador vence o país do checkout quando os dois discordam", () => {
    const mapped = mapHotmartPayload(
      comData((data) => {
        (data.purchase as Record<string, unknown>).checkout_country = { name: "Brasil", iso: "BR" };
        (data.buyer as Record<string, unknown>).address = { country_iso: "PT" };
        (data.buyer as Record<string, unknown>).checkout_phone = "351912345678";
        (data.buyer as Record<string, unknown>).checkout_phone_code = undefined;
      }),
    );

    expect(mapped.phone).toBe("+351912345678");
    expect(mapped.source_metadata.hotmart_campo_ambiguo).toBe(
      `pais:${CAMINHOS_DO_HOTMART.paisDoComprador}`,
    );
  });
});

describe("os caminhos declarados são a lista fechada", () => {
  it("todo caminho tem raiz `event` ou `data.` — nada de varredura de topo", () => {
    for (const caminho of Object.values(CAMINHOS_DO_HOTMART)) {
      expect(caminho === "event" || caminho.startsWith("data.")).toBe(true);
    }
  });

  it("o bloco de identidade é o do comprador (`data.buyer`), não um bloco qualquer", () => {
    expect(CAMINHOS_DO_HOTMART.nome.startsWith("data.buyer.")).toBe(true);
    expect(CAMINHOS_DO_HOTMART.email.startsWith("data.buyer.")).toBe(true);
    expect(CAMINHOS_DO_HOTMART.telefone.startsWith("data.buyer.")).toBe(true);
  });
});
