/**
 * #3102 — campanha parada pelo próprio ritmo não ocupa o número.
 *
 * Duas campanhas no mesmo número: a mais antiga bateu o teto diário dela e a
 * seguinte não mandava nada pelo resto do dia (e pelos dias seguintes), porque
 * a rodada ocupava o número com qualquer resultado que não fosse "concluiu".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({ knobs: { timezone: "America/Sao_Paulo" }, numberActivatedAt: null }),
  loadPacingState: async () => {
    throw new Error("a rodada deste teste não chega ao rodízio");
  },
  recordSend: async () => undefined,
}));

import { rodarEmRajada, type DesfechoDeUm } from "@/lib/campanhas/rajada";
import { ocupaONumero, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

const r = (detalhe: string, concluidas = 0) => ({ concluidas, detalhe });

describe("ocupaONumero", () => {
  it.each(["ritmo:teto_diario", "ritmo:teto_horario", "ritmo:intervalo", "ritmo:fora_da_janela"])(
    "veto do ritmo da própria campanha (%s) deixa o número livre para a seguinte",
    (detalhe) => {
      expect(ocupaONumero(r(detalhe))).toBe(false);
    },
  );

  it("campanha só esperando next_attempt_at deixa o número livre", () => {
    expect(ocupaONumero(r("aguardando"))).toBe(false);
  });

  it("campanha que concluiu deixa o número livre", () => {
    expect(ocupaONumero(r("concluida", 1))).toBe(false);
    expect(ocupaONumero(r("ja_concluida"))).toBe(false);
  });

  it.each([
    "enviado:queued:principal",
    "canal:sem_numero_livre",
    "pulado:opt_out",
    "pulado:suprimido",
    "ja_reservado",
    "erro_na_reserva:timeout",
  ])("quem usou o número ou foi vetado pelo canal ocupa (%s)", (detalhe) => {
    expect(ocupaONumero(r(detalhe))).toBe(true);
  });
});

/**
 * A mesma regra pelo caminho da RODADA, com duas campanhas no mesmo número. Sem
 * isto, voltar `concluidas === 0` na chamada (e deixar `ocupaONumero` exportada
 * e verde) passaria despercebido. O lado que guarda o anti-ban também está
 * aqui: quem USOU o número continua segurando a vez da seguinte.
 */
describe("rodada com duas campanhas no mesmo número", () => {
  const CANAL = "canal-unico";
  const AGORA = new Date("2026-10-20T14:00:00.000Z"); // 11h em São Paulo
  const HOJE_CEDO = "2026-10-20T12:37:00.000Z"; // 9h37 em São Paulo

  type Linha = Record<string, unknown>;

  /** PostgREST em memória: só `eq`, `in`, `gte`, `not is null`, `limit` e `update`. */
  function fakeAdmin(tabelas: Record<string, Linha[]>) {
    const de = (tabela: string) => {
      const filtros: Array<(l: Linha) => boolean> = [];
      let limite = Infinity;
      let patch: Linha | null = null;
      const resolver = () => {
        const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).slice(0, limite);
        if (patch) for (const l of linhas) Object.assign(l, patch);
        return { data: linhas, error: null, count: linhas.length };
      };
      const b: Record<string, unknown> = new Proxy(
        {},
        {
          get(_alvo, metodo) {
            switch (metodo) {
              case "then":
                return (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok);
              case "maybeSingle":
                return async () => ({ data: resolver().data[0] ?? null, error: null });
              case "update":
                return (p: Linha) => ((patch = p), b);
              case "eq":
                return (coluna: string, valor: unknown) => {
                  if (coluna === "organizations.status") filtros.push((l) => (l.organizations as Linha).status === valor);
                  else filtros.push((l) => l[coluna] === valor);
                  return b;
                };
              case "in":
                return (coluna: string, valores: unknown[]) => (filtros.push((l) => valores.includes(l[coluna])), b);
              case "gte":
                return (coluna: string, valor: string) => (filtros.push((l) => String(l[coluna] ?? "") >= valor), b);
              case "not":
                return (coluna: string) => (filtros.push((l) => l[coluna] != null), b);
              case "limit":
                return (n: number) => ((limite = n), b);
              default:
                return () => b;
            }
          },
        },
      );
      return b;
    };
    return { from: de } as never;
  }

  const campanha = (id: string, startedAt: string, tetoDiario: number | null): Linha => ({
    id,
    organization_id: "org-1",
    channel_session_id: CANAL,
    name: id,
    message_body: "oi",
    content_version: 1,
    intervalo_segundos: null,
    janela_inicio_hora: null,
    janela_fim_hora: null,
    teto_diario: tetoDiario,
    teto_horario: null,
    status: "running",
    started_at: startedAt,
    organizations: { status: "active" },
  });

  const contato = (bloqueado = false) => ({
    id: "contato-1",
    name: "Ana",
    display_name: null,
    phone_number: "+5581999990000",
    is_blocked: bloqueado,
    is_personal: false,
    is_anonymized: false,
    consent: null,
  });

  /** A mais antiga (`antiga`) já mandou hoje; a seguinte (`seguinte`) não tem fila e conclui. */
  function cenario(pendenteDaAntiga: Linha) {
    return fakeAdmin({
      campaigns: [campanha("antiga", "2026-10-20T11:00:00.000Z", 1), campanha("seguinte", "2026-10-20T11:00:04.000Z", null)],
      campaign_recipients: [
        { id: "r-enviado", campaign_id: "antiga", status: "sent", sent_at: HOJE_CEDO, contact_id: "contato-1", contacts: contato() },
        { id: "r-pendente", campaign_id: "antiga", status: "pending", sent_at: null, ...pendenteDaAntiga },
      ],
    });
  }

  it("⭐ a mais antiga parada no teto diário dela deixa a seguinte do mesmo número ser avaliada", async () => {
    const r = await rodarUmaRodadaDeCampanha(cenario({ contact_id: "contato-1", contacts: contato() }), AGORA);
    expect(r.detalhe).toContain("antiga:ritmo:teto_diario");
    expect(r.detalhe).toContain("seguinte:concluida");
  });

  it("⭐ quem USOU o número na rodada segura a vez da seguinte (um por número por rodada)", async () => {
    const r = await rodarUmaRodadaDeCampanha(cenario({ contact_id: "contato-1", contacts: contato(true) }), AGORA);
    expect(r.detalhe).toMatch(/antiga:pulado:/);
    expect(r.detalhe).not.toContain("seguinte:");
  });
});

describe("a campanha RÁPIDA segue a mesma régua", () => {
  const rajada = (pendentes: number, desfecho: DesfechoDeUm, aoConcluir: DesfechoDeUm) => {
    let relogio = 0;
    const fila = Array.from({ length: pendentes }, (_, i) => i);
    return rodarEmRajada<number>(
      {
        buscarLote: async (n) => fila.splice(0, n),
        enviarUm: async () => desfecho,
        aindaEmAndamento: async () => true,
        concluirSeAcabou: async () => aoConcluir,
        agora: () => relogio,
        esperar: async (ms) => {
          relogio += ms;
        },
      },
      { concorrencia: 4, intervaloEntreIniciosMs: 167, tamanhoDoLote: 24, prazoMs: 38_000 },
    );
  };
  const nada = { enviadas: 0, pulados: 0, concluidas: 0 };

  it("⭐ parada no teto diário dela sem enviar ninguém: o número fica livre para a seguinte", async () => {
    const r = await rajada(5, { ...nada, detalhe: "ritmo:teto_diario" }, { ...nada, detalhe: "aguardando" });
    expect(r.detalhe).toBe("ritmo:teto_diario");
    expect(ocupaONumero(r)).toBe(false);
  });

  it("ninguém pronto ainda (next_attempt_at no futuro): o número fica livre", async () => {
    const r = await rajada(0, { ...nada, detalhe: "enviado:sent:principal" }, { ...nada, detalhe: "aguardando" });
    expect(r.detalhe).toBe("aguardando");
    expect(ocupaONumero(r)).toBe(false);
  });

  it("controle: a rajada que USOU o número segura a vez da seguinte", async () => {
    const r = await rajada(
      3,
      { enviadas: 1, pulados: 0, concluidas: 0, detalhe: "enviado:sent:principal" },
      { ...nada, detalhe: "aguardando" },
    );
    expect(r.enviadas).toBe(3);
    expect(ocupaONumero(r)).toBe(true);
  });
});
