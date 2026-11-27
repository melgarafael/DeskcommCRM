import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { listaAgendamentos } from "@/lib/agenda/consulta";

/**
 * #3067 fatia 3A: `listaAgendamentos` roda a leitura duas vezes quando há
 * `ownerUserId` — uma como dona/convidada, outra como adicional (`meu:...!inner`).
 * O dublê registra as chamadas de cada consulta separadamente (chave por consulta)
 * e devolve linhas diferentes para cada uma, sem nunca devolver vazio para outra
 * tabela.
 */
type Resposta = { data: unknown; error: { message: string } | null };

function banco(respostas: Record<string, Resposta>) {
  const filtros: Record<string, unknown[][]> = {};
  const cliente = {
    from(tabela: string) {
      const chamada: unknown[][] = [];
      let selectDestaConsulta = "";
      const consulta: Record<string, unknown> & {
        then: (ok: (r: Resposta) => unknown) => unknown;
      } = {
        then: (ok: (r: Resposta) => unknown) => {
          const chave =
            selectDestaConsulta.includes("meu:calendar_appointment_responsibles!inner")
              ? "calendar_appointments_adicional"
              : tabela;
          filtros[chave] = chamada;
          return Promise.resolve(respostas[chave] ?? { data: [], error: null }).then(ok);
        },
      };
      for (const metodo of [
        "select",
        "eq",
        "neq",
        "lt",
        "gt",
        "gte",
        "lte",
        "order",
        "limit",
        "in",
        "or",
        "maybeSingle",
      ]) {
        consulta[metodo] = (...args: unknown[]) => {
          if (metodo === "select") selectDestaConsulta = String(args[0] ?? "");
          chamada.push([metodo, ...args]);
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

const janela = {
  de: new Date("2026-10-07T00:00:00.000Z").toISOString(),
  ate: new Date("2026-10-07T23:59:59.999Z").toISOString(),
};

const compromisso = (id: string, starts_at: string, dono: string, responsaveis: unknown = null) => ({
  id,
  title: "Compromisso " + id,
  starts_at,
  ends_at: "2026-10-07T14:00:00.000Z",
  status: "confirmed",
  owner_user_id: dono,
  calendar_appointment_responsibles: responsaveis,
});

describe("listaAgendamentos — responsável adicional (#3067)", () => {
  it("com ownerUserId, o compromisso só-adicional aparece com responsaveis", async () => {
    const adicional = [
      compromisso("ad-1", "2026-10-07T13:00:00.000Z", "outro", [{ user_id: PESSOA }]),
    ];
    const { cliente } = banco({
      calendar_appointments: { data: [], error: null },
      calendar_appointments_adicional: { data: adicional, error: null },
    });
    const r = await listaAgendamentos(cliente, ORG, {
      ownerUserId: PESSOA,
      ...janela,
      limite: 20,
    });
    expect(r).toMatchObject({
      ok: true,
      agendamentos: [{ id: "ad-1", responsaveis: [PESSOA] }],
    });
  });

  it("o compromisso nas duas respostas aparece UMA vez", async () => {
    const compartilhado = compromisso("com-1", "2026-10-07T10:00:00.000Z", PESSOA, [
      { user_id: PESSOA },
    ]);
    const { cliente } = banco({
      calendar_appointments: { data: [compartilhado], error: null },
      calendar_appointments_adicional: { data: [compartilhado], error: null },
    });
    const r = await listaAgendamentos(cliente, ORG, {
      ownerUserId: PESSOA,
      ...janela,
      limite: 20,
    });
    expect(r).toMatchObject({ ok: true });
    const ids = (r as { agendamentos: { id: string }[] }).agendamentos.map((a) => a.id);
    expect(ids).toEqual(["com-1"]);
  });

  it("ordenado por starts_at e respeita limite com cursor", async () => {
    const linhas = [
      compromisso("c", "2026-10-07T10:00:00.000Z", PESSOA),
      compromisso("a", "2026-10-07T08:00:00.000Z", PESSOA),
      compromisso("b", "2026-10-07T09:00:00.000Z", PESSOA),
    ];
    const { cliente } = banco({
      calendar_appointments: { data: linhas, error: null },
      calendar_appointments_adicional: { data: [], error: null },
    });
    const r = await listaAgendamentos(cliente, ORG, {
      ownerUserId: PESSOA,
      ...janela,
      limite: 2,
    });
    expect(r).toMatchObject({ ok: true });
    const ag = (r as { agendamentos: { id: string; iniciaEm: string }[] }).agendamentos;
    expect(ag.map((a) => a.id)).toEqual(["a", "b"]);
    expect((r as { proximo: string | null }).proximo).toBeTruthy();
  });

  it("sem ownerUserId, só UMA consulta é feita", async () => {
    const { cliente, filtros } = banco({
      calendar_appointments: { data: [], error: null },
    });
    await listaAgendamentos(cliente, ORG, {
      ...janela,
      limite: 20,
    });
    const selects = (filtros.calendar_appointments ?? []).filter(
      (chamada) => chamada[0] === "select",
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]?.[1]).not.toContain("meu:");
  });

  it("a segunda consulta filtra organization_id e meu.user_id", async () => {
    const { cliente, filtros } = banco({
      calendar_appointments: { data: [], error: null },
      calendar_appointments_adicional: { data: [], error: null },
    });
    await listaAgendamentos(cliente, ORG, {
      ownerUserId: PESSOA,
      ...janela,
      limite: 20,
    });
    const adicional = filtros.calendar_appointments_adicional ?? [];
    const eqs = adicional.filter((c) => c[0] === "eq");
    expect(eqs).toContainEqual(["eq", "organization_id", ORG]);
    expect(eqs).toContainEqual(["eq", "meu.user_id", PESSOA]);
  });

  it("erro na segunda consulta devolve ok:false em vez de lista parcial", async () => {
    const { cliente } = banco({
      calendar_appointments: { data: [], error: null },
      calendar_appointments_adicional: { data: null, error: { message: "falhou a leitura adicional" } },
    });
    const r = await listaAgendamentos(cliente, ORG, {
      ownerUserId: PESSOA,
      ...janela,
      limite: 20,
    });
    expect(r).toMatchObject({
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: "falhou a leitura adicional",
    });
  });
});
