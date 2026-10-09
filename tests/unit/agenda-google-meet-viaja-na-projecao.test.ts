/**
 * O LINK DO ESPAÇO ABERTO VIAJA PELA PROJEÇÃO; O DO CALENDAR NÃO (#2063).
 *
 * `localDoEvento` é o único lugar que decide o campo `location` do evento do
 * Google — é ele que o `delta` compara e que um PATCH posterior publica. As
 * duas regras da main continuam valendo neste arquivo, e é este o contrato que
 * o review de 08/10 pediu de volta:
 *
 *   1. o link do Meet do Calendar nasce DEPOIS da publicação e NÃO entra na
 *      projeção. Se entrasse, a projeção de TODO compromisso com Meet já
 *      publicado mudaria na primeira passada do cron, cada um viraria
 *      `publish` e sairia um PATCH `sendUpdates=all` para os convidados —
 *      inclusive compromissos passados e com a opção desligada;
 *   2. o link do espaço ABERTO (#2063, `spaces.create` com `accessType: OPEN`)
 *      entra, e SÓ ele, pelo marcador `meet_aberto`. Com o marcador o link É o
 *      local, mesma régua do `video_link`; sem ele sobra `location_details`,
 *      como sempre.
 *
 * O marcador não é coluna nova: o executor o resolve de um registro que já
 * existe (`google_base_projection.local.location`, o hash do `location`
 * publicado) — ver `espacoAbertoPublicado` em `sync-executor.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  type AgendamentoParaGoogle,
  paraEventoDoGoogle,
} from "@/lib/agenda/google/evento";
import {
  checkpoint,
  compare,
  groups,
  localProjection,
} from "@/lib/agenda/google/sync-model";

const LINK = "https://meet.google.com/abc-defg-hij";

function agendamento(sobrescreve: Partial<AgendamentoParaGoogle> = {}): AgendamentoParaGoogle {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    organization_id: "11111111-1111-4111-8111-111111111111",
    title: "Consulta de avaliação",
    starts_at: "2026-09-02T17:00:00.000Z",
    ends_at: "2026-09-02T17:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    location_kind: "google_meet",
    location_details: "Atendimento online",
    ...sobrescreve,
  };
}

const local = (a: Partial<AgendamentoParaGoogle>) => paraEventoDoGoogle(agendamento(a)).location;

describe("local do evento — ramo google_meet (#2063)", () => {
  it("sem o marcador, o link do Meet do Calendar NÃO entra na projeção", () => {
    // As duas regras da main, juntas: o corpo com o link é IDÊNTICO ao sem ele.
    expect(paraEventoDoGoogle(agendamento({ meeting_url: LINK }))).toEqual(
      paraEventoDoGoogle(agendamento({ meeting_url: null })),
    );
    expect(local({ meeting_url: LINK })).toBe("Atendimento online");
  });

  it("com o marcador do espaço aberto, o link É o local", () => {
    expect(local({ meeting_url: LINK, meet_aberto: true })).toBe(LINK);
  });

  it("o marcador vence os detalhes, como no video_link", () => {
    expect(local({ meeting_url: LINK, meet_aberto: true, location_details: "Atendimento online" })).toBe(LINK);
    expect(local({ meeting_url: LINK, meet_aberto: true, location_details: "Atendimento online" })).toBe(
      local({
        location_kind: "video_link",
        meeting_url: LINK,
        location_details: "Atendimento online",
      }),
    );
  });

  it("controla: marcador sem link ainda não inventa local", () => {
    // Primeira passada do caminho aberto, antes de o espaço nascer.
    expect(local({ meeting_url: null, meet_aberto: true })).toBe("Atendimento online");
  });

  it("controla: sem link e sem detalhe, não há local nenhum", () => {
    expect(paraEventoDoGoogle(agendamento({ meeting_url: null, location_details: null }))).not.toHaveProperty(
      "location",
    );
  });
});

describe("a projeção não muda sozinha (#2063 — a regra que o review mediu)", () => {
  it("o link do Calendar que chega depois não torna a projeção publicável", () => {
    const publicado = localProjection(agendamento({ meeting_url: null }));
    const base = checkpoint(null, publicado, publicado, groups, true);
    // A passada seguinte: o Meet do Calendar nasceu, o link chegou ao
    // `meeting_url`, e o marcador continua ausente — como sempre.
    const proxima = localProjection(agendamento({ meeting_url: LINK }));
    const remoto = { ...publicado, outbound: { ...publicado.outbound } };
    const decisao = compare(base, proxima, remoto);
    // `converged` sem grupo sujo: nenhuma escrita, nenhum "evento alterado".
    expect(decisao.kind).toBe("converged");
    expect(decisao.groups).toEqual([]);
  });

  it("o link do espaço aberto publicado converge na passada seguinte", () => {
    const aberto = localProjection(agendamento({ meeting_url: LINK, meet_aberto: true }));
    const eco = { ...aberto, outbound: { ...aberto.outbound } };
    const base = checkpoint(null, aberto, eco, groups, true);
    expect(aberto.outbound.location).toBe(localProjection(agendamento({ location_details: LINK })).outbound.location);
    const proxima = localProjection(agendamento({ meeting_url: LINK, meet_aberto: true }));
    const decisao = compare(base, proxima, eco);
    expect(decisao.kind).toBe("converged");
    expect(decisao.groups).toEqual([]);
  });
});
