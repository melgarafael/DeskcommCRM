/**
 * A busca do funil acha o card pelo telefone do contato (#3669, fatia 2a).
 *
 * O telefone é gravado como "+5511999998888" e a pessoa digita como lê:
 * "(11) 99999-8888". Busca feita só de dígitos e pontuação compara por dígitos;
 * busca com letra segue sendo texto, senão "Pedido 2" casaria todo telefone.
 */
import { describe, expect, it } from "vitest";

import { applyFilters } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

const card = (id: string, extra: Partial<Lead>): Lead =>
  ({ id, title: "Negócio", description: null, status: "open", tags: [], ...extra }) as Lead;

const leads = [
  card("com-telefone", { contact_phone: "+5511999998888" }),
  card("outro", { contact_phone: "+5521333334444" }),
];
const buscar = (search: string) => applyFilters(leads, { search }).map((l) => l.id);

describe("applyFilters — busca pelo telefone", () => {
  it("acha pelos dígitos escritos com máscara", () => {
    expect(buscar("(11) 99999-8888")).toEqual(["com-telefone"]);
  });

  it("acha pelo telefone como foi gravado", () => {
    expect(buscar("+5511999998888")).toEqual(["com-telefone"]);
  });

  it("busca com letra não compara por dígitos", () => {
    expect(buscar("Pedido 9")).toEqual([]);
  });
});
