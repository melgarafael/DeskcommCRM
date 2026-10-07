/**
 * O LINK DO MEET VIAJA PELA PROJEÇÃO, NÃO POR INJEÇÃO NO CORPO (#2063).
 *
 * `localDoEvento` é o único lugar que decide o campo `location` do evento do
 * Google — é ele que o `delta` compara e que um PATCH posterior publica. Enquanto
 * o ramo `google_meet` devolvia só `location_details`, o link criado pela API do
 * Meet (aberto, #2063) ou o "confiável" do Calendar não aparecia em NENHUM
 * caminho posterior:
 *
 *   - o PATCH do local não tinha diferença na projeção, então não havia o que
 *     publicar;
 *   - o PATCH que é só de reunião saía pelo `return` antecipado de
 *     `sync-executor.ts` (`!shared && !fields.length && !conferenceRequestId`);
 *   - o retry do POST depois que o espaço já está `ready` voltava a corpo sair
 *     daqui — e saía sem o link.
 *
 * A régua nova é a MESMA do `video_link` logo acima: com link, o link É o local;
 * sem link (primeira passada, antes de nascer) sobra `location_details`.
 * Injetar `location` dentro de `send()` faria o link depender de qual caminho o
 * executor tomou — por isso a correção é aqui.
 */
import { describe, expect, it } from "vitest";

import {
  type AgendamentoParaGoogle,
  paraEventoDoGoogle,
} from "@/lib/agenda/google/evento";

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
  it("com o link já criado, o link É o local", () => {
    expect(local({ meeting_url: LINK })).toBe(LINK);
  });

  it("o link vence os detalhes, como no video_link", () => {
    // Mesma régua dos dois ramos: quem lê o calendário clica no link, e os
    // detalhes continuam disponíveis na descrição do compromisso.
    expect(local({ meeting_url: LINK, location_details: "Atendimento online" })).toBe(LINK);
    expect(local({ meeting_url: LINK, location_details: "Atendimento online" })).toBe(
      local({
        location_kind: "video_link",
        meeting_url: LINK,
        location_details: "Atendimento online",
      }),
    );
  });

  it("controla: antes de nascer o link, sobra o detalhe de local", () => {
    expect(local({ meeting_url: null })).toBe("Atendimento online");
  });

  it("controla: sem link e sem detalhe, não há local nenhum", () => {
    expect(paraEventoDoGoogle(agendamento({ meeting_url: null, location_details: null }))).not.toHaveProperty(
      "location",
    );
  });
});
