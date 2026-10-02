import { describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

/**
 * A PORTA NEUTRA DO E-MAIL DE PRAZO DA LGPD (acabamento 7 do PR 1; spec da
 * cobrança §4 "LGPD: nunca bloqueada").
 *
 * O e-mail sai num momento e é clicado em outro. Link escolhido no ENVIO erra
 * quando a empresa muda de estado no meio (ativa no envio, suspensa no clique:
 * o layout de `/app` desviava ao hub sem o pedido). Esta rota não escolhe nada:
 * entrega o pedido ao hub, que decide NO CLIQUE com as duas réguas.
 */
vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));

import { GET } from "./route";

const ID = "22222222-2222-4222-8222-222222222222";
const abrir = (id: string) =>
  GET(new Request(`https://crm.test/lgpd/pedido/${id}`), { params: Promise.resolve({ id }) });

describe("/lgpd/pedido/<id>: a porta do e-mail decide no clique", () => {
  it("pedido válido vai ao hub com ?pedido=, que devolve ao pedido quem opera", async () => {
    await expect(abrir(ID)).rejects.toThrow(`NEXT_REDIRECT:/account-suspended?pedido=${ID}`);
  });

  it("id que não é uuid vai a /app (o valor nunca entra no destino)", async () => {
    await expect(abrir("..%2Fadmin")).rejects.toThrow(/^NEXT_REDIRECT:\/app$/);
  });

  // O hub é público e o `requireAuth` dele manda ao /login SEM `next`. Esta porta
  // não pode ser: é o proxy que, sem sessão, grava `next=/lgpd/pedido/<id>` e
  // traz o DPO de volta ao pedido depois do login.
  it("não é rota pública: o login preserva o pedido", () => {
    expect(isPublicPath(`/lgpd/pedido/${ID}`)).toBe(false);
  });
});
