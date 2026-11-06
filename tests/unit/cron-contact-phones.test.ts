import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O cron que descobre o telefone por trás da identidade opaca.
 *
 * ─── O que ele resolve ──────────────────────────────────────────────────────
 *
 * O WhatsApp identifica quem escreve por um id opaco. Medido numa instalação
 * real: 52 de 54 contatos sem telefone. ESCREVER continua funcionando (o canal
 * endereça pelo id), e é por isso que o defeito passa despercebido — nada
 * quebra, só falta. O atendente abre a conversa e não sabe para quem fala.
 *
 * ─── As duas regras que este arquivo existe para prender ────────────────────
 *
 * 1. Contato ANONIMIZADO nunca é tocado. Sem isso o cron reintroduziria,
 *    sozinho e a cada 30 minutos, o dado pessoal que um pedido LGPD acabara de
 *    apagar. É a regra mais cara de descobrir tarde.
 * 2. Carimba MESMO sem resposta. Sem isso os mesmos primeiros N voltam em toda
 *    rodada, para sempre, e a fila nunca gira.
 */

const ops: { tabela: string; op: string; payload?: unknown; filtros: [string, unknown][] }[] = [];
let contatos: Record<string, unknown>[] = [];
let sessao: Record<string, unknown> | null = null;
let phoneResolvido: string | null = null;
let lookupLanca = false;
/** Os `emit_event` que a rota mandou (#3315) — o dublê do `rpc` os registra. */
const emissoes: Record<string, unknown>[] = [];

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const filtros: [string, unknown][] = [];
  const registro = { tabela, op, payload, filtros };
  ops.push(registro);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (okFn: (v: unknown) => unknown) =>
            okFn(
              tabela === "contacts" && op === "select"
                ? { data: contatos, error: null }
                : { data: [{ id: "x" }], error: null },
            );
        }
        if (prop === "maybeSingle") {
          // A sessão chega EMBUTIDA na conversa do contato — é assim que o
          // vínculo certo se resolve. A primeira versão do cron sorteava uma
          // sessão qualquer da org e, com dois canais, pegava a errada.
          return async () => ({
            data: sessao ? { channel_sessions: sessao } : null,
            error: null,
          });
        }
        return (...args: unknown[]) => {
          if (["eq", "is", "not", "or"].includes(String(prop))) {
            filtros.push([`${String(prop)}:${String(args[0])}`, args[1]]);
          }
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      update: (payload: unknown) => chain(tabela, "update", payload),
    }),
    // (#3315) o cron passou a emitir `contact.phone_added` quando a varredura
    // preenche a ficha vazia: o dublê precisa do `rpc` — sem ele a rota estoura
    // `admin.rpc is not a function` e o arquivo inteiro cai por um motivo que
    // não tem nada a ver com o que ele vigia. A emissão em si é coberta em
    // `tests/unit/contacts/telefone-ganho-no-cron.test.ts`.
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "emit_event") emissoes.push(args);
      return { data: "evt-1", error: null };
    },
  }),
}));

vi.mock("@/lib/channels", async (orig) => {
  const real = await orig<typeof import("@/lib/channels")>();
  return {
    ...real,
    getAdapter: () => ({
      provider: "waha",
      resolvePhoneForIdentity: async () => {
        if (lookupLanca) throw new Error("rede caiu");
        return phoneResolvido;
      },
    }),
  };
});

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "s3cr3t", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { GET } = await import("@/app/api/v1/cron/contact-phones/route");

const chamar = (secret = "s3cr3t") =>
  GET(
    new Request("http://localhost/api/v1/cron/contact-phones", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }) as never,
  );

const filtrosDo = (op: string) =>
  ops.filter((o) => o.tabela === "contacts" && o.op === op).flatMap((o) => o.filtros.map(([k]) => k));

beforeEach(() => {
  ops.length = 0;
  contatos = [{ id: "c1", organization_id: "org", wa_identity: "lid:123" }];
  sessao = { provider: "waha", waha_session_name: "sess", status: "WORKING", archived_at: null };
  phoneResolvido = "+595991733685";
  lookupLanca = false;
});

describe("auth", () => {
  it("sem segredo é 403 e NÃO varre nada", async () => {
    const r = await chamar("");
    expect(r.status).toBe(403);
    expect(ops).toHaveLength(0);
  });

  it("com segredo errado é 403", async () => {
    expect((await chamar("outro")).status).toBe(403);
  });
});

describe("LGPD — a regra mais cara de descobrir tarde", () => {
  it("NUNCA varre contato anonimizado", async () => {
    // Sem este filtro o cron reescreveria, a cada 30 minutos, o telefone de
    // alguém que pediu remoção.
    await chamar();
    expect(filtrosDo("select")).toContain("eq:is_anonymized");
  });

  it("e confere de novo na GRAVAÇÃO — fecha a corrida do lote", async () => {
    // Entre selecionar e gravar há I/O de rede por contato, e a anonimização em
    // escopo de tenant percorre centenas enquanto isto roda.
    await chamar();
    expect(filtrosDo("update")).toContain("eq:is_anonymized");
  });
});

describe("a fila gira", () => {
  it("carimba mesmo QUANDO ACHA o telefone", async () => {
    await chamar();
    const up = ops.find((o) => o.tabela === "contacts" && o.op === "update");
    expect(up?.payload).toMatchObject({ phone_number: "+595991733685" });
    expect(up?.payload).toHaveProperty("phone_lookup_at");
  });

  it("carimba mesmo SEM resposta — senão os mesmos N voltam para sempre", async () => {
    phoneResolvido = null;
    await chamar();
    const up = ops.find((o) => o.tabela === "contacts" && o.op === "update");
    expect(up?.payload).toHaveProperty("phone_lookup_at");
    // E NÃO grava telefone: não há o que gravar.
    expect(up?.payload).not.toHaveProperty("phone_number");
  });

  it("carimba mesmo quando o lookup LANÇA — um contato não derruba o lote", async () => {
    lookupLanca = true;
    const r = await chamar();
    expect(r.status).toBe(200);
    expect(ops.some((o) => o.tabela === "contacts" && o.op === "update")).toBe(true);
  });

  it("só grava onde o telefone está VAZIO — não sobrescreve dado mais fresco", async () => {
    // O contato pode ter ganhado número por outra via entre a seleção e a
    // gravação (webhook do canal oficial, edição na tela).
    await chamar();
    expect(filtrosDo("update")).toContain("is:phone_number");
  });
});

describe("escopo da varredura", () => {
  it("só contatos SEM telefone e COM identidade", async () => {
    await chamar();
    const f = filtrosDo("select");
    expect(f).toContain("is:phone_number");
    expect(f).toContain("not:wa_identity");
  });

  it("sem canal utilizável carimba e segue, sem perguntar a ninguém", async () => {
    sessao = null;
    const r = await chamar();
    expect(await r.json()).toMatchObject({ data: { sem_canal: 1 } });
  });

  it("usa a sessão DA CONVERSA do contato, não uma qualquer da org", async () => {
    // Medido em produção: com dois canais ligados, sortear "a primeira sessão
    // WORKING" pegou a errada e os 40 do lote caíram em "sem canal" — eles são
    // de um canal, a sorteada era do outro, que nem sabe traduzir.
    await chamar();
    const busca = ops.find((o) => o.tabela === "conversations");
    expect(busca, "não buscou pela conversa do contato").toBeTruthy();
    expect(busca!.filtros.map(([k]) => k)).toContain("eq:contact_id");
  });

  it("canal ARQUIVADO não é perguntado — não responde e gastaria a chamada", async () => {
    sessao = { provider: "waha", waha_session_name: "s", status: "WORKING", archived_at: "2026-01-01" };
    expect(await (await chamar()).json()).toMatchObject({ data: { sem_canal: 1 } });
  });

  it("canal fora do ar tampouco", async () => {
    sessao = { provider: "waha", waha_session_name: "s", status: "STOPPED", archived_at: null };
    expect(await (await chamar()).json()).toMatchObject({ data: { sem_canal: 1 } });
  });
});

describe("o encanamento", () => {
  it("não nomeia o provider — pede as colunas ao seam", () => {
    // A primeira versão selecionava a coluna do canal pelo nome e o
    // `lint:channels` reprovou: um cron que sabe QUAL canal é vira o
    // `if (provider === ...)` que a doutrina existe para impedir.
    const fonte = readFileSync("app/api/v1/cron/contact-phones/route.ts", "utf8");
    expect(fonte).toContain("CHANNEL_SESSION_REF_COLUMNS");
    expect(fonte).toContain("resolveSessionRef");
  });

  it("está agendado — cron que ninguém chama é código morto", () => {
    // O crontab mora no entrypoint da imagem do scheduler desde que ele deixou
    // de rodar `apk add` a cada start (docs/doctrine/packaging.md, invariante 1).
    const compose = readFileSync("docker/scheduler/entrypoint.sh", "utf8");
    expect(compose).toMatch(/cron\/contact-phones/);
  });

  it("a migration do carimbo existe, com apêndice e MANIFEST", () => {
    expect(
      readFileSync("supabase/migrations/20260808180000_0119_contato_lookup_telefone.sql", "utf8"),
    ).toContain("phone_lookup_at");
    expect(readFileSync("supabase/baseline.sql", "utf8")).toContain("phone_lookup_at");
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain(
      "0119_contato_lookup_telefone",
    );
  });
});
