import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { renderCompromissos } from "@/lib/agent-engine/agent/compromissos-do-contato";
import { agendaNoFechamento } from "@/lib/agent-engine/agent/abertura/agenda-no-fechamento";

const reserva = {
  id: "reserva-1",
  title: "Consulta",
  starts_at: new Date("2030-07-03T17:00:00Z"),
  ends_at: new Date("2030-07-03T17:30:00Z"),
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
};
const tools = (nome: string): ModelMessage[] => [
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "1",
        toolName: nome,
        output: { type: "json", value: { remarcado: true } },
      },
    ],
  },
];

describe("a reserva chega à IA no próprio fuso", () => {
  it.each([
    ["America/Sao_Paulo", "14:00", "2030-07-03T14:00:00-03:00"],
    ["Europe/Lisbon", "18:00", "2030-07-03T18:00:00+01:00"],
    ["Asia/Kolkata", "22:30", "2030-07-03T22:30:00+05:30"],
    ["UTC", "17:00", "2030-07-03T17:00:00+00:00"],
    ["Pacific/Auckland", "05:00", "2030-07-04T05:00:00+12:00"],
  ])("%s conserva o instante e apresenta %s local", (time_zone, hora, iso) => {
    const texto = renderCompromissos([{ ...reserva, time_zone }]);
    expect(texto).toContain(`às ${hora}`);
    expect(texto).toContain(iso);
    expect(new Date(iso).getTime()).toBe(reserva.starts_at.getTime());
    expect(texto).not.toContain("GMT+0000");
  });

  it("não converte novamente uma string que já tem offset local", () => {
    expect(
      renderCompromissos([
        {
          ...reserva,
          starts_at: "2030-07-03T14:00:00-03:00",
          ends_at: "2030-07-03T14:30:00-03:00",
        },
      ]),
    ).toBe(renderCompromissos([reserva]));
  });

  it("o horário de verão depende da data e do fuso da reserva", () => {
    const inverno = renderCompromissos([
      {
        ...reserva,
        starts_at: "2030-01-03T17:00:00Z",
        ends_at: null,
        time_zone: "Europe/Lisbon",
      },
    ]);
    expect(inverno).toContain("às 17:00");
    expect(inverno).toContain("2030-01-03T17:00:00+00:00");
  });
});

describe("o fechamento lê o estado depois das ações", () => {
  const montar = (
    rows: unknown[],
    mensagens = tools("crm_reschedule_appointment"),
    abertura = "às 17:30",
  ) => {
    const chamadas: unknown[][] = [];
    return {
      chamadas,
      executar: () =>
        agendaNoFechamento({
          db: {
            query: async (...args: unknown[]) => {
              chamadas.push(args);
              return { rows };
            },
          } as never,
          organizationId: "org-A",
          contactId: "contato-A",
          agora: new Date("2030-07-01T12:00:00Z"),
          blocoDaAbertura: abertura,
          mensagens,
        }),
    };
  };

  it("remarcação para 17h substitui a referência de 17h30 da abertura", async () => {
    const m = montar([{ ...reserva, starts_at: "2030-07-03T20:00:00Z", ends_at: null }]);
    const texto = await m.executar();
    expect(texto).toContain("às 17:00");
    expect(texto).not.toContain("17:30");
    expect(m.chamadas[0]?.[1]).toEqual(["org-A", "contato-A", "2030-07-01T12:00:00.000Z", 6]);
  });

  it.each(["crm_book_appointment", "crm_find_and_book_appointment"])(
    "criação via %s aparece mesmo com abertura vazia",
    async (nome) => {
      expect(await montar([reserva], tools(nome), "").executar()).toContain("às 14:00");
    },
  );

  it("cancelamento remove a referência ativa, sem inferir vaga livre", async () => {
    const texto = await montar([], tools("crm_cancel_appointment")).executar();
    expect(texto).toContain("Nenhum compromisso ativo e futuro");
    expect(texto).toContain("não informa horários livres");
    expect(texto).not.toContain("às 17:30");
  });

  it("uma consulta recusada não prova reserva: a leitura vigente continua vazia", async () => {
    expect(await montar([], tools("crm_book_appointment"), "").executar()).toContain(
      "Nenhum compromisso ativo",
    );
  });

  it("turno sem agenda não acrescenta consulta nem texto", async () => {
    const m = montar([], tools("crm_search_products"), "");
    expect(await m.executar()).toBe("");
    expect(m.chamadas).toEqual([]);
  });

  it("erro de leitura não é convertido em ausência de reserva", async () => {
    await expect(
      agendaNoFechamento({
        db: {
          query: async () => {
            throw new Error("banco indisponível");
          },
        } as never,
        organizationId: "org-A",
        contactId: "contato-A",
        agora: new Date(),
        blocoDaAbertura: "reserva",
        mensagens: [],
      }),
    ).rejects.toThrow("banco indisponível");
  });
});
