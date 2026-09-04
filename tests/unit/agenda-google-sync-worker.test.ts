/**
 * A VOLTA: o que o Google diz que ocupa entra no sistema.
 *
 * Antes desta rodada, `git grep` por `calendar_external_events` achava só
 * leitura — o pedido do dono do produto diz "ida e volta" e havia só ida, e o
 * tradutor aprovado numa revisão independente não traduzia nada porque ninguém
 * o chamava.
 *
 * O caso que dá nome ao arquivo não é o caminho feliz: é o ANTI-ECO. Um
 * agendamento nosso vira evento no Google e VOLTA nesta listagem; gravá-lo faria
 * o MESMO compromisso ocupar dois horários. E medido antes de escrever: nem
 * `ocupados.ts` nem `consulta.ts` descontam evento externo que seja nosso — os
 * dois contam tudo o que está na tabela. Logo o filtro tem de ser na ESCRITA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { idDeEventoDoGoogle } from "@/lib/agenda/google/escrita";
import { sincronizarAgendasDoGoogle } from "@/app/api/v1/cron/agenda-google-sync/route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => "ya29.token") }));

const AGORA = new Date("2026-08-26T12:00:00.000Z");

let gravados: Array<Record<string, unknown>> = [];
/** O que já está na tabela para este calendário, quando o teste simula histórico. */
let jaGuardados: Array<{ external_event_id: string }> = [];
let apagados: string[] = [];
let removidos: number;
let tokensGravados: Array<string | null>;

const FUSO_DA_ORG = "America/Sao_Paulo";
const ORG_DO_TESTE = "org-1";

function admin() {
  return {
    from: (tabela: string) => {
      const cadeia: Record<string, unknown> = {
        upsert: async (linha: Record<string, unknown>) => {
          gravados.push(linha);
          return { error: null };
        },
        select: () => {
          const c: Record<string, unknown> = {
            eq: () => c,
            // `organizations` é lida com `.in(...)` para resolver o fuso de fallback do sync.
            in: () =>
              tabela === "organizations"
                ? { then: (r: (v: unknown) => void) => r({ data: [{ id: ORG_DO_TESTE, timezone: FUSO_DA_ORG }], error: null }) }
                : { then: (r: (v: unknown) => void) => r({ data: [], error: null }) },
            then: (resolver: (v: unknown) => void) => resolver({ data: jaGuardados, error: null }),
          };
          return c;
        },
        delete: () => {
          removidos += 1;
          let ultimoId = "";
          const d: Record<string, unknown> = {
            eq: (coluna: string, valor: string) => {
              if (coluna === "external_event_id") {
                ultimoId = valor;
                apagados.push(valor);
              }
              return d;
            },
            then: (resolver: (v: unknown) => void) => resolver({ error: null, id: ultimoId }),
          };
          return d;
        },
        update: (campos: Record<string, unknown>) => ({
          eq: async () => {
            if (tabela === "calendar_connection_calendars") tokensGravados.push((campos.sync_token as string) ?? null);
            return { error: null };
          },
        }),
      };
      return cadeia as never;
    },
  } as never;
}

function calendario(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: "cal-1",
    organization_id: "org-1",
    connection_id: "conn-1",
    external_calendar_id: "ana@clinica.com.br",
    sync_token: null,
    fuso: "America/Sao_Paulo",
    access_token_encrypted: "\\xACCESS",
    ...sobrescreve,
  } as never;
}

function pagina(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as unknown as Response;
}

const eventoDeTerceiro = {
  id: "evt-alheio",
  summary: "Reunião do condomínio",
  iCalUID: "abc@google.com",
  start: { dateTime: "2026-09-02T14:00:00-03:00" },
  end: { dateTime: "2026-09-02T15:00:00-03:00" },
};

beforeEach(() => {
  gravados = [];
  jaGuardados = [];
  apagados = [];
  removidos = 0;
  tokensGravados = [];
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(audit).mockClear();
  vi.mocked(decryptWebhookSecret).mockResolvedValue("ya29.token");
});
afterEach(() => vi.unstubAllGlobals());

describe("sincronizarAgendasDoGoogle", () => {
  it("grava o evento de terceiro traduzido, com a identidade junto", async () => {
    vi.mocked(fetch).mockResolvedValue(pagina({ items: [eventoDeTerceiro], nextSyncToken: "T1" }));

    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });

    expect(r.gravados).toBe(1);
    expect(gravados[0]).toMatchObject({
      external_event_id: "evt-alheio",
      starts_at: "2026-09-02T17:00:00.000Z",
      transparency: "opaque",
      ical_uid: "abc@google.com",
    });
  });

  it("calendário SEM fuso cai no fuso da ORGANIZAÇÃO, nunca em UTC", async () => {
    // O defeito que este caso fecha: `cal.fuso` era cravado em `null` no mapeamento da
    // rota, e o fallback `|| "UTC"` disparava SEMPRE. Em `America/Sao_Paulo` um evento de
    // DIA INTEIRO lido como UTC começa à meia-noite UTC — 21h do dia ANTERIOR na parede da
    // pessoa —, então a agenda bloqueia a noite do dia errado e recusa hora que existe.
    //
    // Aqui o calendário vem sem fuso (é o estado real: ninguém grava `time_zone` ainda) e o
    // esperado é o instante da meia-noite EM SÃO PAULO: 03:00Z. Se o fallback voltasse a
    // ser UTC, este número viraria 00:00Z — e é essa diferença de três horas que o caso
    // vigia, não a mera presença de um campo.
    const diaInteiro = {
      ...eventoDeTerceiro,
      id: "evt-dia-inteiro",
      iCalUID: "dia-inteiro@google.com",
      start: { date: "2026-09-02" },
      end: { date: "2026-09-03" },
    };
    vi.mocked(fetch).mockResolvedValue(pagina({ items: [diaInteiro], nextSyncToken: "T1" }));

    const r = await sincronizarAgendasDoGoogle(admin(), {
      agora: AGORA,
      // `calendario()` devolve `as never`, e espalhar `never` é TS2698 — o helper
      // já tem o parâmetro de sobrescrita, que é a afordância certa aqui.
      calendarios: [calendario({ fuso: null })],
    });

    expect(r.gravados).toBe(1);
    expect(gravados[0]).toMatchObject({ external_event_id: "evt-dia-inteiro", starts_at: "2026-09-02T03:00:00.000Z" });
  });

  it("O ANTI-ECO: o que NÓS criamos não vira evento externo", async () => {
    // Sem este filtro o mesmo compromisso ocupa dois horários — a linha externa
    // e o `calendar_appointments`. E no caso mais comum, a pessoa MOVER o
    // compromisso no Google, o externo ocupa o horário novo enquanto o
    // agendamento continua ocupando o antigo, sem nada que os ligue.
    const nosso = {
      ...eventoDeTerceiro,
      // ⚠️ O anti-eco migrou do iCalUID para o ID.
      //
      // Mandar `iCalUID` junto do `id` no insert é o que o Google recusava com
      // 400 (medido em produção em 2026-09-01), então o uid saiu do corpo — e o
      // reconhecimento passou para o prefixo do id, que é nosso por construção.
      // O uid que o evento traz agora é o que o GOOGLE gera, e ele NÃO nos
      // identifica: é justamente por isso que o id precisa fazer esse trabalho.
      iCalUID: "gerado-pelo-google@google.com",
      id: idDeEventoDoGoogle("22222222-2222-4222-8222-222222222222"),
    };
    vi.mocked(fetch).mockResolvedValue(pagina({ items: [nosso, eventoDeTerceiro], nextSyncToken: "T1" }));

    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });

    expect(r.nossosIgnorados).toBe(1);
    expect(r.gravados).toBe(1);
    expect(gravados.map((g) => g.external_event_id)).toEqual(["evt-alheio"]);
  });

  it("evento cancelado no Google sai da tabela", async () => {
    vi.mocked(fetch).mockResolvedValue(
      pagina({ items: [{ id: "evt-morto", status: "cancelled" }], nextSyncToken: "T1" }),
    );
    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });
    expect(r.removidos).toBe(1);
    expect(gravados).toEqual([]);
  });

  it("`410 fullSyncRequired` limpa o token e refaz NA MESMA rodada", async () => {
    // Sem isto o worker repetiria a mesma requisição com o mesmo token morto
    // para sempre, e a agenda congelaria em silêncio — o defeito que a
    // referência do cal.com carrega até hoje.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        pagina({ error: { code: 410, errors: [{ reason: "fullSyncRequired" }] } }, 410),
      )
      .mockResolvedValueOnce(pagina({ items: [eventoDeTerceiro], nextSyncToken: "T-NOVO" }));

    const r = await sincronizarAgendasDoGoogle(admin(), {
      agora: AGORA,
      calendarios: [calendario({ sync_token: "MORTO" })],
    });

    expect(r.ressincronizados).toBe(1);
    expect(r.gravados).toBe(1);
    // O token limpo primeiro, o novo depois.
    expect(tokensGravados).toEqual([null, "T-NOVO"]);
  });

  it("evento-mestre de série é RECUSADO, não gravado pela metade", async () => {
    // Ele descreve só a primeira ocorrência: gravá-lo esconderia as outras e a
    // agenda diria "livre" em cima de compromisso semanal.
    vi.mocked(fetch).mockResolvedValue(
      pagina({
        items: [{ ...eventoDeTerceiro, id: "evt-serie", recurrence: ["RRULE:FREQ=WEEKLY"] }],
        nextSyncToken: "T1",
      }),
    );
    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });
    expect(r.recusados).toBe(1);
    expect(gravados).toEqual([]);
  });

  it("cifra indisponível não grava nada e não rebaixa nada", async () => {
    vi.mocked(decryptWebhookSecret).mockResolvedValue(null);
    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });
    expect(r.falhas).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("A RECONCILIAÇÃO: leitura completa apaga o que não veio — o fantasma", async () => {
    // No sync incremental o Google manda lápide para o que foi apagado. No
    // COMPLETO não há lápide: o evento apagado simplesmente NÃO VEM, e a linha
    // antiga fica ocupando horário para sempre. A poda por prazo não alcança
    // isso — ela apaga o VELHO, e este evento pode ser de semana que vem.
    jaGuardados = [{ external_event_id: "evt-alheio" }, { external_event_id: "evt-fantasma" }];
    vi.mocked(fetch).mockResolvedValue(pagina({ items: [eventoDeTerceiro], nextSyncToken: "T1" }));

    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });

    expect(r.reconciliados).toBe(1);
    expect(apagados).toContain("evt-fantasma");
    // Controle: o que VEIO na lista não pode ser apagado junto.
    expect(apagados).not.toContain("evt-alheio");
  });

  it("leitura INCREMENTAL não reconcilia — ausência ali não é apagamento", async () => {
    // Com `syncToken`, o Google manda só o que MUDOU. Um evento que não veio
    // simplesmente não mudou; apagá-lo destruiria a agenda inteira a cada tick.
    jaGuardados = [{ external_event_id: "evt-que-nao-mudou" }];
    vi.mocked(fetch).mockResolvedValue(pagina({ items: [], nextSyncToken: "T2" }));

    const r = await sincronizarAgendasDoGoogle(admin(), {
      agora: AGORA,
      calendarios: [calendario({ sync_token: "T1" })],
    });

    expect(r.reconciliados).toBe(0);
    expect(apagados).toEqual([]);
  });

  it("leitura TRUNCADA não reconcilia — ausência ali significa `não li`", async () => {
    // Apagar por não ter lido é destruir dado por falta de paciência.
    jaGuardados = [{ external_event_id: "evt-que-estava-na-pagina-que-eu-nao-li" }];
    vi.mocked(fetch).mockResolvedValue(pagina({ items: [eventoDeTerceiro], nextPageToken: "sempre" }));

    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });

    expect(r.reconciliados).toBe(0);
    expect(apagados).toEqual([]);
  });

  it("rodada sem calendário não audita", async () => {
    const r = await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [] });
    expect(r.calendarios).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a contagem do anti-eco vai para o audit — é a prova de que ele agiu", async () => {
    const nosso = { ...eventoDeTerceiro, id: idDeEventoDoGoogle("x"), iCalUID: "gerado@google.com" };
    vi.mocked(fetch).mockResolvedValue(pagina({ items: [nosso, eventoDeTerceiro], nextSyncToken: "T1" }));
    await sincronizarAgendasDoGoogle(admin(), { agora: AGORA, calendarios: [calendario()] });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.google.sync_executado",
        metadata: expect.objectContaining({ nossos_ignorados: 1, gravados: 1 }),
      }),
    );
  });
});
