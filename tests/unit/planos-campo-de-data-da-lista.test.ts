/**
 * Tarefas › Planos (#4717 item 4): o passo que conta de um campo de data
 * escolhe o campo numa LISTA, não digitando a chave. A lista é a união dos
 * campos de DATA do NEGÓCIO de todos os funis — uma opção por chave.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));

import { camposDeDataDosFunis } from "@/app/app/tasks/planos/_client";

const campo = (key: string, label: string, type = "date", scope?: string) => ({
  key,
  label,
  type,
  ...(scope ? { escopo: scope } : {}),
});

describe("camposDeDataDosFunis", () => {
  it("junta os funis, uma opção por chave, e deixa de fora o que não é data do negócio", () => {
    const lista = camposDeDataDosFunis([
      {
        name: "Viagens",
        settings: {
          fields: [
            campo("data_da_viagem", "Data da viagem"),
            campo("destino", "Destino", "text"),
            campo("aniversario", "Aniversário", "date", "contato"),
          ],
        },
      },
      { name: "Grupos", settings: { fields: [campo("data_da_viagem", "Data da viagem")] } },
      { name: "Sem campos", settings: {} },
    ]);

    expect(lista).toEqual([{ chave: "data_da_viagem", rotulo: "Data da viagem — Viagens, Grupos" }]);
  });
});
