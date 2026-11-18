// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ligarPeloTelefone } from "@/hooks/leads/useParticipantesDoNegocio";
import { ApiError } from "@/lib/api/types";
import type { apiClient } from "@/lib/api/client";

/**
 * "+ TELEFONE" NO DOSSIÊ (#3669, fatia 1): acha ou cria o contato pelo número
 * e o liga ao negócio — com DUAS rotas que já existem e nenhuma regra nova.
 *
 * O "acha" é o 409 `contact_exists` do cadastro (#3084), que devolve o
 * `contact_id` relido pelo servidor. Se a tela buscasse o número por conta
 * própria, haveria duas réguas de telefone (formato nacional da #3301, nono
 * dígito do `canonicalPhoneBR`) para divergir — e a divergência é um contato
 * duplicado, que é exatamente o problema da issue.
 */
const LEAD = "l-1";

function api(primeira: () => Promise<unknown>) {
  const post = vi.fn(async (caminho: string) => {
    if (caminho === "/api/v1/contacts") return primeira();
    return { data: { ok: true } };
  });
  return { post: post as never as typeof apiClient.post, chamadas: post };
}

describe("ligarPeloTelefone", () => {
  it("⭐ número novo: cria o contato com o número digitado e o liga com o papel", async () => {
    const { post, chamadas } = api(async () => ({ data: { contact: { id: "c-novo" } } }));

    const r = await ligarPeloTelefone(
      LEAD,
      { telefone: "(11) 98765-4321", nome: "Ana Compras", papel: "Comprador" },
      { post },
    );

    expect(r).toEqual({ contact_id: "c-novo", jaExistia: false });
    // O número vai CRU: quem normaliza é o cadastro, com a régua do país.
    expect(chamadas.mock.calls).toEqual([
      ["/api/v1/contacts", { phone_number: "(11) 98765-4321", name: "Ana Compras" }],
      [`/api/v1/leads/${LEAD}/contatos-relacionados`, { contact_id: "c-novo", papel: "Comprador" }],
    ]);
  });

  it("⭐ número que já tem contato: usa o id que o 409 do cadastro devolve", async () => {
    const { post, chamadas } = api(async () => {
      throw new ApiError(409, "contact_exists", { contact_id: "c-existente" }, "req-1");
    });

    const r = await ligarPeloTelefone(LEAD, { telefone: "1133224455" }, { post });

    expect(r).toEqual({ contact_id: "c-existente", jaExistia: true });
    expect(chamadas.mock.calls[1]).toEqual([
      `/api/v1/leads/${LEAD}/contatos-relacionados`,
      { contact_id: "c-existente", papel: null },
    ]);
  });

  it("sem nome, o cadastro recebe só o número (não um nome vazio)", async () => {
    const { post, chamadas } = api(async () => ({ data: { contact: { id: "c-novo" } } }));
    await ligarPeloTelefone(LEAD, { telefone: "11987654321", nome: null }, { post });
    expect(chamadas.mock.calls[0]).toEqual(["/api/v1/contacts", { phone_number: "11987654321" }]);
  });

  it("telefone inválido (422) para ali: nenhum vínculo é tentado", async () => {
    const erro = new ApiError(422, "validation_failed", undefined, "req-2");
    const { post, chamadas } = api(async () => {
      throw erro;
    });

    await expect(ligarPeloTelefone(LEAD, { telefone: "123" }, { post })).rejects.toBe(erro);
    expect(chamadas).toHaveBeenCalledTimes(1);
  });

  it("409 sem `contact_id` não vira vínculo com id inventado", async () => {
    const erro = new ApiError(409, "contact_exists", {}, "req-3");
    const { post, chamadas } = api(async () => {
      throw erro;
    });

    await expect(ligarPeloTelefone(LEAD, { telefone: "11987654321" }, { post })).rejects.toBe(erro);
    expect(chamadas).toHaveBeenCalledTimes(1);
  });
});
