/**
 * A falha de envio pelo número oficial chega em três formatos, e os três têm de
 * dar o MESMO código — é por ele que a campanha decide se segue para a próxima
 * pessoa ou se para inteira (modelo pausado, número restringido, pagamento).
 */
import { describe, expect, it } from "vitest";

import { motivoDaFalhaDaMensagem } from "@/lib/inbox/motivo-da-falha";
import {
  codigoDaPlataforma,
  ehLimiteDeVelocidade,
  falhaDoEnvioInteiro,
  fraseDaFalha,
  recusaDoEnvioDeModelo,
} from "./erro-da-plataforma";

describe("codigoDaPlataforma", () => {
  it("oficial direto: o número vem em error_code", () => {
    expect(codigoDaPlataforma("131050", "Unable to deliver")).toBe("131050");
  });

  it("parceiro, pelo webhook: o rótulo do adapter em error_code e o número no começo do texto", () => {
    expect(codigoDaPlataforma("zernio_error", "131049 — Healthy ecosystem — …")).toBe("131049");
  });

  it("recusa síncrona: o marcador ganha do status HTTP que abre o texto", () => {
    expect(
      codigoDaPlataforma("zernio_error", "zernio_template_failed: 400 platform_api_error: x [plataforma:132015]"),
    ).toBe("132015");
    // Sem marcador, o 400 do envelope NÃO é lido como código.
    expect(codigoDaPlataforma("zernio_error", "zernio_template_failed: 400 INVALID_TEMPLATE_PARAMS: faltam")).toBe(
      "INVALID_TEMPLATE_PARAMS",
    );
  });

  it("recusa síncrona do envio de modelo: o código depois do prefixo do canal", () => {
    expect(codigoDaPlataforma("meta_error", "meta_132000: (#132000) Number of parameters does not match")).toBe("132000");
    expect(codigoDaPlataforma("datafy_error", "datafy_132015: Template is paused")).toBe("132015");
    // Código de um dígito também é da plataforma (4 = limite de chamadas do app), e não pausa.
    expect(codigoDaPlataforma("meta_error", "meta_4: (#4) Application request limit reached")).toBe("4");
    // Sem código na resposta (`<canal>_erro`) ou só o rótulo do adapter: nada a ler.
    expect(codigoDaPlataforma("meta_error", "meta_erro: build_failed")).toBeNull();
    expect(codigoDaPlataforma("zernio_error", "zernio_template_failed: timeout")).toBeNull();
  });

  it("recusa do pré-voo deste sistema", () => {
    expect(codigoDaPlataforma("zernio_error", 'template_not_approved: "x" (es) está PAUSED')).toBe("template_not_approved");
  });

  it("sem código nenhum: null", () => {
    expect(codigoDaPlataforma("send_failed", "timeout")).toBeNull();
    expect(codigoDaPlataforma(null, null)).toBeNull();
  });
});

describe("falhaDoEnvioInteiro", () => {
  it("modelo pausado, número restringido e pagamento param a campanha", () => {
    for (const c of ["132015", "132016", "131048", "131042", "368", "message_allowance_exceeded", "template_not_approved"]) {
      expect(falhaDoEnvioInteiro(c), c).toBe(true);
    }
  });

  it("o que é da PESSOA não para: ela desligou o marketing, não tem WhatsApp, passou do limite de promoções", () => {
    for (const c of ["131050", "131026", "131049", "130472", null]) {
      expect(falhaDoEnvioInteiro(c), String(c)).toBe(false);
    }
  });
});

describe("fraseDaFalha", () => {
  it("código conhecido vira frase; desconhecido devolve o texto cru da plataforma", () => {
    expect(fraseDaFalha("131050", "x")).toMatch(/desligou as mensagens de marketing/);
    expect(fraseDaFalha("999999", "Algo raro")).toBe("Algo raro");
    expect(fraseDaFalha(null, "  ")).toBeNull();
  });
});

describe("ehLimiteDeVelocidade", () => {
  it("o provedor e a plataforma pedindo para desacelerar: a mensagem volta para a fila", () => {
    expect(ehLimiteDeVelocidade("130429", "130429 Rate limit hit")).toBe(true);
    expect(ehLimiteDeVelocidade(null, "zernio_template_failed: 429 rate_limited: Rate limit exceeded")).toBe(true);
    expect(ehLimiteDeVelocidade(null, "zernio_template_failed: 429 Too Many Requests")).toBe(true);
  });

  it("falha de verdade não é confundida com pressa", () => {
    // 131056 é por destinatário e o adaptador já o devolve como fila; 131050 e
    // 132015 são desfechos — reenviar repetiria a mesma recusa.
    expect(ehLimiteDeVelocidade("131056", "131056 Too many messages")).toBe(false);
    expect(ehLimiteDeVelocidade("131050", "zernio_template_failed: 400 [plataforma:131050]")).toBe(false);
    expect(ehLimiteDeVelocidade("132015", "zernio_template_failed: 400 [plataforma:132015]")).toBe(false);
    // Um telefone com 429 no meio não é o status HTTP.
    expect(ehLimiteDeVelocidade(null, "zernio_template_failed: 400 número +5511987654321 inválido")).toBe(false);
  });
});

// O segundo canal que usa `send-template-for-session.ts` (`errorPrefix: "datafy"`).
// Mora aqui porque o nome do provider não pode aparecer fora de `lib/channels/`.
describe("recusaDoEnvioDeModelo: o prefixo que o envio de modelo grava", () => {
  it.each([
    ["datafy_132000: Parameter mismatch", { codigo: "132000", textoDoProvedor: "Parameter mismatch" }],
    ["meta_100: Parameter name is missing or empty", { codigo: "100", textoDoProvedor: "Parameter name is missing or empty" }],
    ["datafy_erro: build_failed", { codigo: "erro", textoDoProvedor: "build_failed" }],
    ["meta_4: (#4) Application request limit reached", { codigo: "4", textoDoProvedor: "(#4) Application request limit reached" }],
    ["template_missing: promo (pt_BR) não está no espelho", { codigo: "template_missing", textoDoProvedor: "promo (pt_BR) não está no espelho" }],
  ])("%s", (texto, esperado) => {
    expect(recusaDoEnvioDeModelo(texto)).toEqual(esperado);
  });

  it("o texto do provedor sai cortado em 300 caracteres, como fraseDaFalha", () => {
    expect(recusaDoEnvioDeModelo(`meta_131009: ${"a".repeat(500)}`)?.textoDoProvedor).toBe("a".repeat(300));
  });

  it.each(["template_missing_values: 1", "400 Bad Request", "131026 — Undeliverable", "", null])(
    "não é recusa do envio de modelo: %s",
    (texto) => {
      expect(recusaDoEnvioDeModelo(texto)).toBeNull();
    },
  );

  it("a tela da conversa: datafy_<n> com frase nossa e sem frase nossa", () => {
    const t = (s: string) => s;
    expect(motivoDaFalhaDaMensagem({ error_code: "datafy_error", error_message: "datafy_132000: Parameter mismatch" }, t))
      .toBe("Os valores enviados não batem com as variáveis do modelo.");
    expect(motivoDaFalhaDaMensagem({ error_code: "datafy_error", error_message: "datafy_100: Parameter name is missing or empty" }, t))
      .toBe("(#100) Parameter name is missing or empty");
  });
});

// O desfecho de status do parceiro (`zernio/webhook.ts`) grava `zernio_error` e
// `<código> — <título> — <explicação>`. A main mostrava esse texto na dica do selo.
describe("a tela da conversa: desfecho do parceiro com código sem frase nossa", () => {
  const t = (s: string) => s;
  it.each([
    "131000 — Something went wrong — Message failed to send due to an unknown error.",
    "131053 — Media upload error — Unable to download the media.",
  ])("%s: o texto gravado, não 'Confira a conexão'", (texto) => {
    expect(motivoDaFalhaDaMensagem({ error_code: "zernio_error", error_message: texto }, t)).toBe(texto);
  });

  it("código com frase nossa: a frase (controle)", () => {
    expect(motivoDaFalhaDaMensagem({ error_code: "zernio_error", error_message: "131026 — Message undeliverable — x" }, t))
      .toMatch(/^Não foi possível entregar/);
  });

  it("sem o formato do desfecho, a frase do canal segue (500 do serviço)", () => {
    expect(motivoDaFalhaDaMensagem({ error_code: "zernio_error", error_message: "500 Internal Server Error" }, t))
      .toBe("O canal recusou o envio. Confira a conexão em Conexões.");
  });
});
