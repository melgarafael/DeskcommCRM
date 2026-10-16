/**
 * O CABEÇALHO DO DIA DA LINHA DO TEMPO DO CONTATO SEGUE O FUSO DE QUEM LÊ (#2934).
 *
 * ─── O defeito ────────────────────────────────────────────────────────────
 *
 * `TimelineView` agrupa os itens pelo dia LOCAL do `performed_at`
 * (`format(…, "yyyy-MM-dd")` — essa parte está certa) e depois reconstruía a
 * data do cabeçalho com `new Date(chave)`. Uma chave `aaaa-mm-dd` sem hora é
 * lida como MEIA-NOITE UTC: em Brasília (UTC-3) isso é 21h do dia ANTERIOR,
 * então `isToday`, `isYesterday` e `format` caiam um dia para trás — o que
 * aconteceu hoje aparecia sob "Ontem" e o de ontem saía com a data de
 * anteontem. Vale para todo fuso a oeste de UTC.
 *
 * ─── A prova ──────────────────────────────────────────────────────────────
 *
 * 1. Fuso FIXO (`America/Sao_Paulo`) e instante FIXO (14:30 em Brasília):
 *    nenhum caso depende de que horas a suíte roda.
 * 2. Uma GUARDA mede, no ambiente do próprio teste, que a chave lida como UTC
 *    cai no dia anterior AQUI (`new Date("2026-10-14").getDate() === 13`). Num
 *    runner em UTC — o CI, por exemplo — o defeito não se manifesta; sem a
 *    guarda o verde seria de fachada e o caso não provaria nada.
 * 3. Casos de CONTROLE em UTC e a leste de UTC (Tóquio): lá a conversão é a
 *    identidade e os rótulos são os mesmos antes e depois do conserto. É o
 *    caso que protege quem nunca viu o defeito.
 *
 * O terceiro item (12/10) existe para o caminho da DATA, não só o de
 * "Hoje"/"Ontem": com o defeito ele sai como "11/10/2026".
 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { TimelineView } from "@/components/contacts/TimelineView";

const FUSO_DO_PROCESSO = process.env.TZ;

/** 2026-10-14T17:30Z = 14:30 em Brasília, 02:30 de 15/10 em Tóquio. */
const AGORA = new Date("2026-10-14T17:30:00.000Z");

vi.mock("@/hooks/contacts/useTimeline", () => ({
  useTimeline: () => ({
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => undefined,
    refetch: () => undefined,
    data: {
      pages: [
        {
          data: [
            {
              id: "a1",
              organization_id: "org-1",
              lead_id: "l-1",
              contact_id: "c-1",
              source_module: "crm",
              source_id: null,
              type: "note",
              // 14:27 em Brasília — HOJE.
              payload: { note: "Hoje à tarde" },
              metadata: {},
              performed_at: "2026-10-14T17:27:14.000Z",
              performed_by_user_id: null,
            },
            {
              id: "a2",
              organization_id: "org-1",
              lead_id: "l-1",
              contact_id: "c-1",
              source_module: "crm",
              source_id: null,
              type: "note",
              // 12:00 em Brasília — ONTEM.
              payload: { note: "Ontem à tarde" },
              metadata: {},
              performed_at: "2026-10-13T15:00:00.000Z",
              performed_by_user_id: null,
            },
            {
              id: "a3",
              organization_id: "org-1",
              lead_id: "l-1",
              contact_id: "c-1",
              source_module: "crm",
              source_id: null,
              type: "note",
              // 10:00 em Brasília — ANTEONTEM, para o caminho da data.
              payload: { note: "Antes de ontem" },
              metadata: {},
              performed_at: "2026-10-12T13:00:00.000Z",
              performed_by_user_id: null,
            },
          ],
        },
      ],
    },
  }),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await import("date-fns/locale");
  return { useLocaleDeData: () => ptBR };
});

/** Os rótulos dos cabeçalhos, na ordem em que a tela os desenha. */
function cabecalhos(): string[] {
  return screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
}

/** Desenha a timeline no fuso pedido e devolve os rótulos do cabeçalho do dia. */
function desenharNoFuso(fuso: string): string[] {
  process.env.TZ = fuso;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
  render(<TimelineView contactId="c-1" />);
  return cabecalhos();
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

afterAll(() => {
  if (FUSO_DO_PROCESSO === undefined) delete process.env.TZ;
  else process.env.TZ = FUSO_DO_PROCESSO;
});

describe("linha do tempo do contato: o cabeçalho do dia segue o fuso de quem lê", () => {
  it("em Brasília, o que aconteceu hoje fica sob 'Hoje' (e não sob 'Ontem')", () => {
    process.env.TZ = "America/Sao_Paulo";

    // GUARDA: sem isto o caso não prova nada. Se a chave lida como UTC não
    // caísse no dia anterior AQUI, o defeito não se manifestaria e o verde
    // seria de fachada — é o que acontece num processo rodando em UTC.
    expect(process.env.TZ).toBe("America/Sao_Paulo");
    expect(new Date("2026-10-14").getDate()).toBe(13);

    expect(desenharNoFuso("America/Sao_Paulo")).toEqual(["Hoje", "Ontem", "12/10/2026"]);
  });

  it("em UTC nada muda: os mesmos rótulos de antes do conserto (controle)", () => {
    expect(desenharNoFuso("UTC")).toEqual(["Hoje", "Ontem", "12/10/2026"]);
  });

  it("a leste de UTC (Tóquio) também não desloca (controle)", () => {
    // Em Tóquio, meia-noite UTC é 09:00 do MESMO dia local: este fuso não
    // reproduz o defeito, então ele é controle — não prova o conserto.
    expect(desenharNoFuso("Asia/Tokyo")).toEqual(["Hoje", "Ontem", "12/10/2026"]);
  });
});
