/**
 * A leitura da ocupação do Outlook (#1754): o que bloqueia horário, o que não
 * bloqueia e o que NUNCA pode virar "agenda livre" por engano.
 */
import { describe, expect, it, vi } from "vitest";

import type { AppDaMicrosoft } from "@/lib/agenda/microsoft/config";
import { FORMATO_DO_DIRETORIO } from "@/lib/agenda/microsoft/config";
import { EventoIlegivel, ocupacaoDoEvento } from "@/lib/agenda/microsoft/evento";
import { ErroDoGraph, graphDaMicrosoft, TETO_DE_PAGINAS } from "@/lib/agenda/microsoft/graph";
import {
  desfechoDaRecusa,
  lerRespostaDoToken,
  temPermissaoDeAgenda,
  urlDeConsentimento,
} from "@/lib/agenda/microsoft/oauth";

const FUSO = "America/Sao_Paulo";
const base = {
  id: "ev-1",
  start: { dateTime: "2026-12-01T13:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-12-01T14:00:00.0000000", timeZone: "UTC" },
  showAs: "busy",
};

describe("evento do Outlook como ocupação", () => {
  it("ocupado: horário em UTC, sem o assunto", () => {
    const lido = ocupacaoDoEvento({ ...base, subject: "segredo" } as typeof base, FUSO);
    expect(lido).toMatchObject({
      starts_at: "2026-12-01T13:00:00.000Z",
      ends_at: "2026-12-01T14:00:00.000Z",
      status: "confirmed",
      transparency: "opaque",
    });
    expect(JSON.stringify(lido)).not.toContain("segredo");
  });

  it.each(["free", "workingElsewhere"])("%s não bloqueia", (showAs) => {
    expect(ocupacaoDoEvento({ ...base, showAs }, FUSO)?.transparency).toBe("transparent");
  });

  it.each(["busy", "oof", "unknown", "algo_novo"])("%s bloqueia", (showAs) => {
    expect(ocupacaoDoEvento({ ...base, showAs }, FUSO)?.transparency).toBe("opaque");
  });

  it("talvez ocupa e sai como tentative", () => {
    expect(ocupacaoDoEvento({ ...base, showAs: "tentative" }, FUSO)).toMatchObject({
      status: "tentative",
      transparency: "opaque",
    });
  });

  it("cancelado e duração zero não ocupam", () => {
    expect(ocupacaoDoEvento({ ...base, isCancelled: true }, FUSO)).toBeNull();
    expect(ocupacaoDoEvento({ ...base, end: base.start }, FUSO)).toBeNull();
  });

  it("dia inteiro vale o dia no fuso de quem atende, não em UTC", () => {
    const lido = ocupacaoDoEvento(
      {
        ...base,
        isAllDay: true,
        start: { dateTime: "2026-12-01T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-12-02T00:00:00.0000000", timeZone: "UTC" },
      },
      FUSO,
    );
    expect(lido).toMatchObject({
      starts_at: "2026-12-01T03:00:00.000Z",
      ends_at: "2026-12-02T03:00:00.000Z",
      is_all_day: true,
    });
  });

  it("horário ilegível LANÇA em vez de sumir da grade", () => {
    expect(() => ocupacaoDoEvento({ ...base, start: { dateTime: "ontem" } }, FUSO)).toThrow(EventoIlegivel);
    expect(() => ocupacaoDoEvento({ ...base, end: undefined }, FUSO)).toThrow(EventoIlegivel);
  });
});

describe("Microsoft Graph", () => {
  const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

  it("segue a paginação e junta as páginas", async () => {
    const buscar = vi
      .fn()
      .mockResolvedValueOnce(
        resposta({ value: [base], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/x?p=2" }),
      )
      .mockResolvedValueOnce(resposta({ value: [{ ...base, id: "ev-2" }] }));
    const itens = await graphDaMicrosoft("t", buscar).ocupacao("cal", "a", "b");
    expect(itens.map((i) => i.id)).toEqual(["ev-1", "ev-2"]);
  });

  it("não manda o token para endereço fora do Graph", async () => {
    const buscar = vi
      .fn()
      .mockResolvedValue(resposta({ value: [], "@odata.nextLink": "https://graph.microsoft.com.evil.test/v1.0/x" }));
    await expect(graphDaMicrosoft("t", buscar).ocupacao("cal", "a", "b")).rejects.toThrow(ErroDoGraph);
    expect(buscar).toHaveBeenCalledTimes(1);
  });

  it("paginação sem fim FALHA: meia agenda não vira cobertura", async () => {
    const buscar = vi.fn().mockImplementation(async () =>
      resposta({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/x" }),
    );
    await expect(graphDaMicrosoft("t", buscar).ocupacao("cal", "a", "b")).rejects.toThrow(ErroDoGraph);
    expect(buscar).toHaveBeenCalledTimes(TETO_DE_PAGINAS);
  });

  it("recusa do Graph carrega o status", async () => {
    const buscar = vi.fn().mockResolvedValue(resposta({}, 429));
    await expect(graphDaMicrosoft("t", buscar).agendas()).rejects.toMatchObject({ status: 429 });
  });
});

describe("OAuth da Microsoft", () => {
  const app: AppDaMicrosoft = {
    clientId: "cliente",
    clientSecret: "segredo-do-app",
    tenant: "common",
    redirectUri: "https://crm.exemplo/api/v1/agenda/microsoft/callback",
  };

  it("pede só leitura, deixa escolher a conta e não leva o segredo na URL", () => {
    const url = new URL(urlDeConsentimento(app, { state: "s" }));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toContain("Calendars.Read");
    expect(url.searchParams.get("scope")).not.toContain("ReadWrite");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.toString()).not.toContain("segredo-do-app");
  });

  it("separa o que a pessoa resolve do que o instalador resolve", () => {
    const agora = new Date("2026-12-01T00:00:00Z");
    expect(lerRespostaDoToken({ error: "invalid_grant" }, 400, agora)).toMatchObject({ motivo: "reautenticar" });
    expect(lerRespostaDoToken({ error: "invalid_client" }, 401, agora)).toMatchObject({ motivo: "credencial" });
    expect(lerRespostaDoToken(null, 503, agora)).toMatchObject({ motivo: "transitorio" });
    expect(lerRespostaDoToken({ access_token: "a", expires_in: 3600 }, 200, agora)).toMatchObject({
      ok: true,
      token: { refreshToken: null, expiraEm: "2026-12-01T01:00:00.000Z" },
    });
  });

  it("reconhece a aprovação do administrador", () => {
    expect(desfechoDaRecusa("access_denied", "AADSTS90094: admin consent is required")).toBe(
      "precisa_do_administrador",
    );
    expect(desfechoDaRecusa("access_denied", "o usuário cancelou")).toBe("conexao_cancelada");
  });

  it("confere a permissão de agenda nas duas grafias", () => {
    expect(temPermissaoDeAgenda(["https://graph.microsoft.com/Calendars.Read"])).toBe(true);
    expect(temPermissaoDeAgenda(["Calendars.Read", "User.Read"])).toBe(true);
    expect(temPermissaoDeAgenda(["User.Read"])).toBe(false);
  });

  it("o diretório não aceita pedaço de URL", () => {
    expect(FORMATO_DO_DIRETORIO.test("common")).toBe(true);
    expect(FORMATO_DO_DIRETORIO.test("empresa.onmicrosoft.com")).toBe(true);
    expect(FORMATO_DO_DIRETORIO.test("a/b")).toBe(false);
    expect(FORMATO_DO_DIRETORIO.test("a.com?x=1")).toBe(false);
  });
});
