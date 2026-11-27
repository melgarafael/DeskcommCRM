import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { coletaOQueOcupa } from "@/lib/agenda/consulta";

/**
 * #3067: na agenda sem serviço, quem é responsável ADICIONAL está ocupado.
 * O dublê registra os filtros de cada tabela: sem o filtro de organização ou de
 * pessoa a leitura devolveria o compromisso de outro, e o caso não veria.
 */
type Resposta = { data: unknown; error: { message: string } | null };

function banco(respostas: Record<string, Resposta>) {
  const filtros: Record<string, unknown[][]> = {};
  const cliente = {
    from(tabela: string) {
      const registro: unknown[][] = (filtros[tabela] = []);
      const consulta: Record<string, unknown> = {
        then: (ok: (r: Resposta) => unknown) =>
          Promise.resolve(respostas[tabela] ?? { data: [], error: null }).then(ok),
      };
      for (const metodo of ["select", "eq", "neq", "lt", "gt"]) {
        consulta[metodo] = (...args: unknown[]) => {
          registro.push([metodo, ...args]);
          return consulta;
        };
      }
      return consulta;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return { cliente: cliente as unknown as SupabaseClient, filtros };
}

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const PESSOA = "bbbbbbbb-0000-4000-8000-00000000000b";
const IGNORADO = "ffffffff-0000-4000-8000-00000000000f";
const janela = {
  donoId: PESSOA,
  de: new Date("2026-10-07T12:00:00.000Z"),
  ate: new Date("2026-10-07T18:00:00.000Z"),
};
const compromisso = (status: string) => ({
  starts_at: "2026-10-07T13:00:00.000Z",
  ends_at: "2026-10-07T14:00:00.000Z",
  status,
});

describe("coletaOQueOcupa — responsável adicional (#3067)", () => {
  it("o compromisso em que a pessoa é só adicional ocupa o horário", async () => {
    const { cliente } = banco({
      calendar_appointment_responsibles: {
        data: [{ calendar_appointments: compromisso("confirmed") }],
        error: null,
      },
    });
    const r = await coletaOQueOcupa(cliente, ORG, janela);
    expect(r).toMatchObject({
      ok: true,
      ocupados: [
        { inicio: new Date("2026-10-07T13:00:00.000Z"), fim: new Date("2026-10-07T14:00:00.000Z") },
      ],
    });
  });

  it("compromisso cancelado não ocupa quem é adicional", async () => {
    const { cliente } = banco({
      calendar_appointment_responsibles: {
        data: [{ calendar_appointments: compromisso("cancelled") }],
        error: null,
      },
    });
    expect(await coletaOQueOcupa(cliente, ORG, janela)).toMatchObject({ ok: true, ocupados: [] });
  });

  it("filtra a organização, a pessoa, a janela e o compromisso ignorado", async () => {
    const { cliente, filtros } = banco({});
    await coletaOQueOcupa(cliente, ORG, { ...janela, ignorarAgendamentoId: IGNORADO });
    expect(filtros.calendar_appointment_responsibles).toEqual([
      ["select", "calendar_appointments!inner(starts_at, ends_at, status)"],
      ["eq", "organization_id", ORG],
      ["eq", "user_id", PESSOA],
      ["lt", "calendar_appointments.starts_at", janela.ate.toISOString()],
      ["gt", "calendar_appointments.ends_at", janela.de.toISOString()],
      ["neq", "appointment_id", IGNORADO],
    ]);
  });

  it("erro na leitura dos adicionais recusa em vez de dizer que está livre", async () => {
    const { cliente } = banco({
      calendar_appointment_responsibles: { data: null, error: { message: "falhou a leitura" } },
    });
    expect(await coletaOQueOcupa(cliente, ORG, janela)).toEqual({ ok: false, erro: "falhou a leitura" });
  });
});
