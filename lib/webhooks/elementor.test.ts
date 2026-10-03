import { describe, it, expect } from "vitest";

import { isElementorPayload, mapElementorPayload } from "@/lib/webhooks/elementor";
import { isRdStationPayload } from "@/lib/webhooks/rdstation";
import { isRespondiPayload } from "@/lib/webhooks/respondi";
import { mapInboundPayload } from "@/lib/webhooks/inbound";

/**
 * Envio real da ação "Webhook" do Elementor Pro (form-urlencoded, colchetes),
 * SANITIZADO: nome/e-mail/telefone trocados por valores fictícios; mesma
 * ESTRUTURA e mesmos NOMES DE CAMPO do envio observado em 2026-09-30.
 *
 * Note o id `Telefone` com T maiúsculo — é id livre, escolhido por quem montou o
 * formulário, e é por isso que o telefone se acha pelo TIPO (`tel`).
 */
function envio(over: Record<string, string> = {}): Record<string, string> {
  return {
    "form[id]": "57e8a20",
    "form[name]": "form conversao",
    "fields[name][id]": "name",
    "fields[name][type]": "text",
    "fields[name][title]": "Nome",
    "fields[name][value]": "Maria Teste",
    "fields[name][required]": "1",
    "fields[email][id]": "email",
    "fields[email][type]": "email",
    "fields[email][title]": "E-mail",
    "fields[email][value]": "maria.teste@example.com",
    "fields[email][required]": "1",
    "fields[Telefone][id]": "Telefone",
    "fields[Telefone][type]": "tel",
    "fields[Telefone][title]": "Telefone",
    "fields[Telefone][value]": "11988887777",
    "fields[servico][id]": "servico",
    "fields[servico][type]": "select",
    "fields[servico][title]": "Selecione o serviço você precisa",
    "fields[servico][value]": "projeto_customizado",
    "fields[idv][id]": "idv",
    "fields[idv][type]": "select",
    "fields[idv][title]": "Sobre a Identidade Visual",
    "fields[idv][value]": "idv_atualizar",
    "fields[idv][raw_value]": "idv_atualizar",
    "fields[idv][required]": "1",
    "fields[message][id]": "message",
    "fields[message][type]": "textarea",
    "fields[message][title]": "Mensagem",
    "fields[message][value]": "Quero um orçamento",
    ...over,
  };
}

describe("isElementorPayload", () => {
  it("reconhece o envio do Elementor", () => expect(isElementorPayload(envio())).toBe(true));

  it("reconhece a forma aninhada equivalente", () => {
    expect(
      isElementorPayload({
        form: { id: "57e8a20", name: "form conversao" },
        fields: { name: { id: "name", type: "text", title: "Nome", value: "Maria Teste" } },
      }),
    ).toBe(true);
  });

  it("não captura payload de outra origem", () => {
    expect(isElementorPayload({ nome: "Ana", telefone: "11998765432" })).toBe(false);
    expect(isElementorPayload({ fields: { foo: "bar" } })).toBe(false);
    expect(isElementorPayload({ "fields[x][value]": "solto, sem id nem type" })).toBe(false);
    expect(isElementorPayload({ leads: [{ id: "1", name: "A" }] })).toBe(false);
    expect(isElementorPayload(null)).toBe(false);
    expect(isElementorPayload("texto")).toBe(false);
  });

  it("e o envio do Elementor não é de outra origem", () => {
    expect(isRespondiPayload(envio())).toBe(false);
    expect(isRdStationPayload(envio())).toBe(false);
  });
});

describe("mapElementorPayload", () => {
  it("acha nome, telefone e e-mail", () => {
    const m = mapElementorPayload(envio());
    expect(m).toMatchObject({
      name: "Maria Teste",
      phone: "+5511988887777",
      email: "maria.teste@example.com",
    });
  });

  it("o telefone se acha pelo tipo `tel`, não pelo id (Telefone ≠ telefone)", () => {
    const m = mapElementorPayload(
      envio({ "fields[Telefone][id]": "campo_xyz_9", "fields[campo_xyz_9][id]": "campo_xyz_9" }),
    );
    expect(m.phone).toBe("+5511988887777");
  });

  it("o e-mail se acha pelo tipo `email`, mesmo com id livre", () => {
    const base = envio();
    delete base["fields[email][id]"];
    const m = mapElementorPayload({
      ...base,
      "fields[contato][id]": "contato",
      "fields[contato][type]": "email",
      "fields[contato][value]": "outro@example.com",
      "fields[email][type]": "text",
      "fields[email][value]": "",
    });
    expect(m.email).toBe("outro@example.com");
  });

  it("o nome cai no rótulo quando o id não diz nome", () => {
    const base = envio();
    for (const k of Object.keys(base)) if (k.startsWith("fields[name]")) delete base[k];
    const m = mapElementorPayload({
      ...base,
      "fields[campo_1][id]": "campo_1",
      "fields[campo_1][type]": "text",
      "fields[campo_1][title]": "Seu nome completo",
      "fields[campo_1][value]": "José da Silva",
    });
    expect(m.name).toBe("José da Silva");
  });

  it("os demais campos viram custom_fields pelo id, com o nome do formulário", () => {
    const m = mapElementorPayload(envio());
    expect(m.custom_fields).toEqual({
      servico: "projeto_customizado",
      idv: "idv_atualizar",
      message: "Quero um orçamento",
      elementor_form_id: "57e8a20",
      elementor_form_name: "form conversao",
    });
  });

  it("`required` e `raw_value` não são dado do lead", () => {
    const campos = Object.keys(mapElementorPayload(envio()).custom_fields);
    expect(campos).not.toContain("required");
    expect(campos).not.toContain("raw_value");
    expect(Object.values(mapElementorPayload(envio()).custom_fields)).not.toContain("1");
  });

  it("campo vazio não vira custom_field", () => {
    const m = mapElementorPayload(envio({ "fields[message][value]": "  " }));
    expect(m.custom_fields).not.toHaveProperty("message");
  });

  it("campo oculto utm_* vai para source_metadata, como no caminho genérico", () => {
    const m = mapElementorPayload(
      envio({
        "fields[utm_source][id]": "utm_source",
        "fields[utm_source][type]": "hidden",
        "fields[utm_source][value]": "instagram",
      }),
    );
    expect(m.source_metadata).toEqual({ utm_source: "instagram" });
    expect(m.custom_fields).not.toHaveProperty("utm_source");
  });

  it("telefone que não normaliza fica como raw_phone, sem virar telefone", () => {
    const m = mapElementorPayload(envio({ "fields[Telefone][value]": "12345" }));
    expect(m.phone).toBeNull();
    expect(m.source_metadata.raw_phone).toBe("12345");
  });

  it("lista (checkbox) na forma aninhada é juntada", () => {
    const m = mapElementorPayload({
      fields: {
        name: { id: "name", type: "text", title: "Nome", value: "Ana" },
        interesses: { id: "interesses", type: "checkbox", title: "Interesses", value: ["a", "b"] },
      },
    });
    expect(m.custom_fields.interesses).toBe("a, b");
  });

  it("não tem identificador único do envio", () =>
    expect(mapElementorPayload(envio()).externalId).toBeNull());
});

describe("o defeito que este arquivo conserta", () => {
  it("o mapeador genérico não acha NADA neste envio (recusa 400 na rota)", () => {
    const m = mapInboundPayload(envio());
    expect(m.name).toBeNull();
    expect(m.phone).toBeNull();
    expect(m.email).toBeNull();
  });
});
