/**
 * #3112 — o rodízio na RODADA respeita o número pelo qual o envio SAI e o
 * intervalo do pacing desse número.
 *
 * Dois furos, os dois do mesmo desenho: a rodada guardava "um envio por número"
 * pelo número PRINCIPAL da campanha, mas o envio sai pelo número que o rodízio
 * escolheu; e o motor de pacing devolve `{ allow: true, waitMs }` quando só
 * falta o intervalo, e a rodada lia só o `allow`. Hoje o espaçamento real virava
 * "um por principal por rodada" × cadência do cron — não o throttle do número.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PACING_DEFAULTS, type PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import type * as Capabilities from "@/lib/channels/capabilities";

const { OFICIAL_DO_TESTE } = vi.hoisted(() => ({ OFICIAL_DO_TESTE: "oficial-do-teste" }));

const mundo = vi.hoisted(() => ({
  knobs: null as unknown as PacingKnobs,
  /** O `pacing_ledger` em memória: o que `recordSend` grava, `loadPacingState` lê. */
  ledger: new Map<string, Date[]>(),
  envios: [] as string[],
  /** O corpo de cada envio, na ordem — os balões da campanha dividida (#3329). */
  corpos: [] as string[],
}));

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({ knobs: mundo.knobs, numberActivatedAt: null }),
  loadPacingState: async (_pool: unknown, _org: string, sessionId: string) => {
    const envios = mundo.ledger.get(sessionId) ?? [];
    return { lastSentAt: envios.at(-1) ?? null, sentToday: envios.length, numberActivatedAt: null };
  },
  recordSend: async (_pool: unknown, _org: string, sessionId: string, quando: Date) => {
    mundo.ledger.set(sessionId, [...(mundo.ledger.get(sessionId) ?? []), quando]);
  },
}));
// O número oficial do teste: sem risco de banimento (quem limita é a plataforma),
// como a capability dos canais oficiais declara. Sem nomear provider fora de
// `lib/channels/` — a cerca `lint:channels` não deixa.
vi.mock("@/lib/channels/capabilities", async (original) => {
  const real = await original<typeof Capabilities>();
  return {
    ...real,
    canalTemRiscoDeBanimento: (provider: string | null | undefined) =>
      provider === OFICIAL_DO_TESTE ? false : real.canalTemRiscoDeBanimento(provider),
  };
});
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: async (_admin: unknown, _org: string, contato: string, sessionId: string) => ({
    conversation_id: `conv:${contato}:${sessionId}`,
  }),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (
    _admin: unknown,
    ctx: { serviceBoundary: { conversation_id: string } },
    input: { body?: string },
  ) => {
    mundo.envios.push(ctx.serviceBoundary.conversation_id);
    mundo.corpos.push(input.body ?? "");
    return { id: `msg-${mundo.envios.length}`, status: "queued" };
  },
}));

import { NUMEROS_POR_RODADA, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

type Linha = Record<string, unknown>;

const AGORA = new Date("2026-10-20T14:00:00.000Z"); // terça, 11h em São Paulo

/** PostgREST em memória: só `eq`, `in`, `gte`, `not is null`, `limit`, `update` e `maybeSingle`. */
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

const campanha = (id: string, principal: string, startedAt: string): Linha => ({
  id,
  organization_id: "org-1",
  channel_session_id: principal,
  name: id,
  message_body: "oi",
  content_version: 1,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
  status: "running",
  started_at: startedAt,
  organizations: { status: "active" },
});

const pendente = (id: string, campanhaId: string, contato: string): Linha => ({
  id,
  campaign_id: campanhaId,
  status: "pending",
  sent_at: null,
  contact_id: contato,
  recipient_address: null,
  rendered_body: null,
  contacts: {
    id: contato,
    name: contato,
    display_name: null,
    phone_number: `+55819999${contato.length}0000`,
    is_blocked: false,
    is_personal: false,
    is_anonymized: false,
    consent: null,
  },
});

const canal = (id: string, status: string): Linha => ({
  id,
  organization_id: "org-1",
  status,
  daily_message_limit: null,
});

beforeEach(() => {
  mundo.ledger.clear();
  mundo.envios.length = 0;
  mundo.corpos.length = 0;
});

describe("rodada: duas campanhas de principais diferentes dividindo um número vinculado", () => {
  /**
   * Throttle zerado de propósito: este caso mede a regra da RODADA ("um envio
   * por número por rodada"), não o intervalo do pacing — que tem o caso dele
   * abaixo. Com throttle, o pacing esconderia o furo da rodada.
   */
  beforeEach(() => {
    mundo.knobs = { ...PACING_DEFAULTS, throttleMs: 0, jitterMaxMs: 0 };
  });

  function cenario() {
    return fakeAdmin({
      campaigns: [
        campanha("camp-a", "principal-a", "2026-10-20T11:00:00.000Z"),
        campanha("camp-b", "principal-b", "2026-10-20T11:00:05.000Z"),
      ],
      campaign_recipients: [pendente("r-a", "camp-a", "ana"), pendente("r-b", "camp-b", "bia")],
      // Os dois principais fora do ar: o único número que fala é o vinculado comum.
      campaign_channel_sessions: [
        { organization_id: "org-1", campaign_id: "camp-a", channel_session_id: "vinculado" },
        { organization_id: "org-1", campaign_id: "camp-b", channel_session_id: "vinculado" },
      ],
      channel_sessions: [canal("principal-a", "STOPPED"), canal("principal-b", "STOPPED"), canal("vinculado", "WORKING")],
    });
  }

  it("⭐ o vinculado manda UMA na rodada, e a segunda campanha espera", async () => {
    const r = await rodarUmaRodadaDeCampanha(cenario(), AGORA);
    expect(mundo.ledger.get("vinculado")).toHaveLength(1);
    expect(mundo.envios).toEqual(["conv:ana:vinculado"]);
    expect(r.enviadas).toBe(1);
    expect(r.detalhe).toContain("camp-a:enviado:");
    expect(r.detalhe).toContain("camp-b:canal:sem_numero_livre");
  });
});

describe("rodada: número cujo pacing só falta o intervalo (allow com waitMs > 0)", () => {
  beforeEach(() => {
    mundo.knobs = { ...PACING_DEFAULTS, throttleMs: 5_000, jitterMaxMs: 0 };
  });

  function cenario() {
    return fakeAdmin({
      campaigns: [campanha("camp-a", "principal", "2026-10-20T11:00:00.000Z")],
      campaign_recipients: [pendente("r-a", "camp-a", "ana")],
      campaign_channel_sessions: [],
      channel_sessions: [canal("principal", "WORKING")],
    });
  }

  it("⭐ o agente mandou há 2s e o intervalo é 5s: a campanha não sai por esse número agora", async () => {
    mundo.ledger.set("principal", [new Date(AGORA.getTime() - 2_000)]);
    const r = await rodarUmaRodadaDeCampanha(cenario(), AGORA);
    expect(mundo.envios).toEqual([]);
    expect(r.enviadas).toBe(0);
    expect(r.detalhe).toContain("camp-a:canal:sem_numero_livre");
  });

  it("controle: com o intervalo cumprido (10s atrás), ela sai", async () => {
    mundo.ledger.set("principal", [new Date(AGORA.getTime() - 10_000)]);
    const r = await rodarUmaRodadaDeCampanha(cenario(), AGORA);
    expect(mundo.envios).toEqual(["conv:ana:principal"]);
    expect(r.enviadas).toBe(1);
  });
});

describe("rodada: o número que falou por uma campanha é o PRINCIPAL de outra", () => {
  /**
   * O caso do cético da rodada 1. A é mais antiga, com o principal fora do ar, e
   * fala pelo vinculado V. B tem V como principal e um vinculado X livre. Pôr o
   * número que falou no mesmo conjunto do principal ocupado pulava B inteira
   * antes do rodízio — B ficava em zero até A terminar. O número que falou sai
   * do RODÍZIO de B, e B segue por X.
   */
  beforeEach(() => {
    mundo.knobs = { ...PACING_DEFAULTS };
  });

  it("⭐ em 3 rodadas, B sai por X nas 3 e V nunca manda 2 na mesma rodada", async () => {
    const admin = fakeAdmin({
      campaigns: [
        campanha("camp-a", "pa", "2026-10-20T11:00:00.000Z"),
        campanha("camp-b", "V", "2026-10-20T11:00:05.000Z"),
      ],
      campaign_recipients: [
        pendente("r-a1", "camp-a", "ana"),
        pendente("r-a2", "camp-a", "ana2"),
        pendente("r-a3", "camp-a", "ana3"),
        pendente("r-b1", "camp-b", "bia"),
        pendente("r-b2", "camp-b", "bia2"),
        pendente("r-b3", "camp-b", "bia3"),
      ],
      campaign_channel_sessions: [
        { organization_id: "org-1", campaign_id: "camp-a", channel_session_id: "V" },
        { organization_id: "org-1", campaign_id: "camp-b", channel_session_id: "X" },
      ],
      channel_sessions: [canal("pa", "STOPPED"), canal("V", "WORKING"), canal("X", "WORKING")],
    });

    for (let rodada = 0; rodada < 3; rodada++) {
      const antesV = mundo.ledger.get("V")?.length ?? 0;
      await rodarUmaRodadaDeCampanha(admin, new Date(AGORA.getTime() + rodada * 60_000));
      expect((mundo.ledger.get("V")?.length ?? 0) - antesV).toBeLessThanOrEqual(1);
    }
    expect(mundo.envios.filter((c) => c.startsWith("conv:bia"))).toEqual([
      "conv:bia:X",
      "conv:bia2:X",
      "conv:bia3:X",
    ]);
    expect(mundo.ledger.get("V")).toHaveLength(3);
  });
});

describe("rodada: o teto de números por rodada conta campanhas, não a união com os vinculados", () => {
  /**
   * O caso do cético da rodada 2. Cada campanha N tem principal pN e vinculado
   * próprio vN, e sai pelo vN. Contar o teto pela UNIÃO de principais ocupados e
   * números que falaram soma 2 por campanha: na 6ª o teto batia e, dali em
   * diante, nenhuma rodada a alcançava até as mais antigas terminarem — fome que
   * a main não tem. O teto pelos principais já limita os números que falaram:
   * toda campanha que fala tem `ocupaONumero`, e os principais são distintos.
   */
  const SETE = 7;

  function cenario(n: number, principal: (i: number) => Linha, vinculado: (i: number) => Linha) {
    const ids = Array.from({ length: n }, (_, i) => i);
    return fakeAdmin({
      campaigns: ids.map((i) => campanha(`camp-${i}`, `p${i}`, `2026-10-20T11:00:${String(i).padStart(2, "0")}.000Z`)),
      campaign_recipients: ids.flatMap((i) =>
        [0, 1, 2].map((k) => pendente(`r-${i}-${k}`, `camp-${i}`, `c${i}x${k}`)),
      ),
      campaign_channel_sessions: ids.map((i) => ({
        organization_id: "org-1",
        campaign_id: `camp-${i}`,
        channel_session_id: `v${i}`,
      })),
      channel_sessions: ids.flatMap((i) => [principal(i), vinculado(i)]),
    });
  }

  async function tresRodadas(admin: ReturnType<typeof fakeAdmin>) {
    for (let rodada = 0; rodada < 3; rodada++) {
      const antes = new Map([...mundo.ledger].map(([n, e]) => [n, e.length]));
      await rodarUmaRodadaDeCampanha(admin, new Date(AGORA.getTime() + rodada * 60_000));
      for (const [numero, envios] of mundo.ledger) {
        expect(envios.length - (antes.get(numero) ?? 0), `${numero} na rodada ${rodada}`).toBeLessThanOrEqual(1);
      }
    }
    return Array.from({ length: SETE }, (_, i) => mundo.envios.filter((c) => c.startsWith(`conv:c${i}x`)).length);
  }

  for (const [nome, knobs] of [
    ["PACING_DEFAULTS", { ...PACING_DEFAULTS }],
    ["throttle 0", { ...PACING_DEFAULTS, throttleMs: 0, jitterMaxMs: 0 }],
  ] as const) {
    describe(nome, () => {
      beforeEach(() => {
        mundo.knobs = knobs;
      });

      it("⭐ 7 campanhas com o principal fora do ar: todas mandam 3 em 3 rodadas", async () => {
        const admin = cenario(SETE, (i) => canal(`p${i}`, "STOPPED"), (i) => canal(`v${i}`, "WORKING"));
        expect(await tresRodadas(admin)).toEqual(Array(SETE).fill(3));
      });

      it("⭐ 7 campanhas com o principal no ar sem limite e o vinculado com limite: todas mandam 3", async () => {
        // `escolherNumero` põe a folga nula por último: todas saem pelo vN.
        const admin = cenario(
          SETE,
          (i) => canal(`p${i}`, "WORKING"),
          (i) => ({ ...canal(`v${i}`, "WORKING"), daily_message_limit: 200 }),
        );
        expect(await tresRodadas(admin)).toEqual(Array(SETE).fill(3));
        expect([...mundo.ledger.keys()].every((n) => n.startsWith("v"))).toBe(true);
      });

      it("controle do teto: com NUMEROS_POR_RODADA + 1 campanhas, a última espera a rodada", async () => {
        const n = NUMEROS_POR_RODADA + 1;
        const admin = cenario(n, (i) => canal(`p${i}`, "STOPPED"), (i) => canal(`v${i}`, "WORKING"));
        const r = await rodarUmaRodadaDeCampanha(admin, AGORA);
        expect(r.enviadas).toBe(NUMEROS_POR_RODADA);
        expect(r.detalhe).not.toContain(`camp-${n - 1}`);
        expect(mundo.envios.some((c) => c.startsWith(`conv:c${n - 1}x`))).toBe(false);
      });
    });
  }
});

describe("rodada: a campanha RÁPIDA fala em rajada, e o número dela sai do rodízio das seguintes", () => {
  /**
   * A rajada manda vários envios na mesma rodada pelo mesmo número — é o ponto
   * dela. Duas coisas têm de valer juntas: os números que ELA usa não a barram
   * no meio (senão parava no segundo envio), e voltam no desfecho, para a
   * campanha seguinte da rodada não falar de novo pelo mesmo número (#3112).
   */
  beforeEach(() => {
    mundo.knobs = { ...PACING_DEFAULTS, throttleMs: 0, jitterMaxMs: 0 };
    // Cada envio da rajada lê o relógio de verdade (`new Date()`), não o `agora`
    // da rodada. Sem fixar só o `Date`, à noite a janela anti-ban barra a rajada
    // e o caso reprova por horário, sem defeito nenhum (medido às 01h de Assunção).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AGORA);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const comModelo = (id: string, campanhaId: string, contato: string): Linha => ({
    ...pendente(id, campanhaId, contato),
    variables: { modelo: { "1": contato } },
  });

  function cenario(vinculadoDaGradual: string) {
    return fakeAdmin({
      campaigns: [
        {
          ...campanha("camp-r", "pr", "2026-10-20T11:00:00.000Z"),
          message_mode: "template",
          provider_template_name: "promo",
          provider_template_language: "pt_BR",
          velocidade: "rapida",
        },
        campanha("camp-g", "pg", "2026-10-20T11:00:05.000Z"),
      ],
      campaign_recipients: [
        comModelo("r-r1", "camp-r", "rui"),
        comModelo("r-r2", "camp-r", "rui2"),
        comModelo("r-r3", "camp-r", "rui3"),
        pendente("r-g1", "camp-g", "gil"),
      ],
      // Os dois principais fora do ar: a rápida fala pelo vinculado V. V e X são
      // oficiais — a rajada só existe com modelo —, então o aquecimento do número
      // por QR não barra nada aqui: quem decide é a rodada.
      campaign_channel_sessions: [
        { organization_id: "org-1", campaign_id: "camp-r", channel_session_id: "V" },
        { organization_id: "org-1", campaign_id: "camp-g", channel_session_id: vinculadoDaGradual },
      ],
      channel_sessions: [
        canal("pr", "STOPPED"),
        canal("pg", "STOPPED"),
        { ...canal("V", "WORKING"), provider: OFICIAL_DO_TESTE },
        { ...canal("X", "WORKING"), provider: OFICIAL_DO_TESTE },
      ],
    });
  }

  it("⭐ a rápida manda as 3 por V na mesma rodada, e a gradual que divide V espera", async () => {
    const r = await rodarUmaRodadaDeCampanha(cenario("V"), AGORA);
    expect(mundo.envios).toEqual(["conv:rui:V", "conv:rui2:V", "conv:rui3:V"]);
    expect(r.detalhe).toContain("camp-g:canal:sem_numero_livre");
  });

  it("controle: com outro vinculado livre, a gradual sai na mesma rodada", async () => {
    const r = await rodarUmaRodadaDeCampanha(cenario("X"), AGORA);
    expect(mundo.envios).toEqual(["conv:rui:V", "conv:rui2:V", "conv:rui3:V", "conv:gil:X"]);
    expect(r.enviadas).toBe(4);
  });
});

describe("rodada: campanha de texto em balões (#3329)", () => {
  beforeEach(() => {
    mundo.knobs = { ...PACING_DEFAULTS, throttleMs: 0, jitterMaxMs: 0 };
  });

  function cenario(dividir: boolean, tetoDoNumero: number | null) {
    return fakeAdmin({
      campaigns: [
        { ...campanha("camp-a", "principal", "2026-10-20T11:00:00.000Z"), message_body: "A\n\nB\n\nC", split_messages: dividir },
      ],
      campaign_recipients: [pendente("r-a", "camp-a", "ana")],
      campaign_channel_sessions: [],
      channel_sessions: [{ ...canal("principal", "WORKING"), daily_message_limit: tetoDoNumero }],
    });
  }

  it("⭐ ligada: três balões em ordem, e cada um conta no ledger do número", async () => {
    const r = await rodarUmaRodadaDeCampanha(cenario(true, null), AGORA);
    expect(mundo.corpos).toEqual(["A", "B", "C"]);
    expect(mundo.ledger.get("principal")).toHaveLength(3);
    expect(r.enviadas).toBe(1);
  });

  it("⭐ cada balão entra no ledger no instante em que saiu: o throttle do próximo envio conta do último", async () => {
    // Mede o ledger e a espera, sem depender do arredondamento entre o timer
    // do host e Date.now() (o CI já observou 29 ms num setTimeout de 30 ms).
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(AGORA);
    try {
      mundo.knobs = { ...PACING_DEFAULTS, throttleMs: 30, jitterMaxMs: 0 };
      const rodada = rodarUmaRodadaDeCampanha(cenario(true, null), AGORA);
      await vi.advanceTimersByTimeAsync(0);
      expect(mundo.ledger.get("principal")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(29);
      expect(mundo.ledger.get("principal")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mundo.ledger.get("principal")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(29);
      expect(mundo.ledger.get("principal")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await rodada;
      const ledger = (mundo.ledger.get("principal") ?? []).map((d) => d.getTime() - AGORA.getTime());
      expect(ledger).toHaveLength(3);
      expect(ledger[0]).toBe(0);
      expect(ledger[1]).toBeGreaterThanOrEqual(30);
      expect(ledger[2]! - ledger[1]!).toBeGreaterThanOrEqual(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("desligada: um balão só, com o texto inteiro", async () => {
    await rodarUmaRodadaDeCampanha(cenario(false, null), AGORA);
    expect(mundo.corpos).toEqual(["A\n\nB\n\nC"]);
    expect(mundo.ledger.get("principal")).toHaveLength(1);
  });

  it("⭐ o teto do número é conferido para os 3 balões: com 2 de folga, não começa", async () => {
    mundo.ledger.set("principal", [new Date(AGORA.getTime() - 3_600_000), new Date(AGORA.getTime() - 3_000_000), new Date(AGORA.getTime() - 2_000_000)]);
    const r = await rodarUmaRodadaDeCampanha(cenario(true, 5), AGORA);
    expect(mundo.corpos).toEqual([]);
    expect(r.detalhe).toContain("camp-a:canal:sem_numero_livre");
  });

  it("controle: com 3 de folga, os 3 saem e o número chega ao teto", async () => {
    mundo.ledger.set("principal", [new Date(AGORA.getTime() - 3_600_000), new Date(AGORA.getTime() - 3_000_000)]);
    await rodarUmaRodadaDeCampanha(cenario(true, 5), AGORA);
    expect(mundo.corpos).toEqual(["A", "B", "C"]);
    expect(mundo.ledger.get("principal")).toHaveLength(5);
  });
});
