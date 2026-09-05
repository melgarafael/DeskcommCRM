import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "dono@x.com", is_platform_admin: true };
const MEMBRO = { ...OWNER, id: "22222222-2222-4222-8222-222222222222", is_platform_admin: false };

let versionRow: Record<string, unknown>;
let runRow: Record<string, unknown> | null;
let inserted: Record<string, unknown> | null;
/**
 * Patch aplicado por um `.update(...)` em `system_update_runs` — usado para
 * provar que um run "dispatched" vencido (agente morto no meio) é fechado
 * como `failed` pelo PRÓPRIO POST, em vez de travar o botão pra sempre.
 */
let runUpdatePatch: Record<string, unknown> | null;
/**
 * Patch aplicado por um `.update(...)` em `system_version` — usado para provar
 * que o POST NÃO mantém um segundo estado de "alguém pediu" fora do run.
 */
let versionUpdatePatch: Record<string, unknown> | null;
/**
 * Erro que o INSERT em `system_update_runs` deve devolver neste caso — usado
 * para simular a corrida entre dois cliques quase simultâneos batendo no
 * índice único parcial `uniq_system_update_runs_dispatched` (migration 0090).
 */
let insertError: { code: string; message: string } | null;
/** Erro que a leitura (`maybeSingle`) de `system_version` deve devolver neste caso. */
let versionSelectError: { message: string } | null;
/** Erro que a leitura (`maybeSingle`) de `system_update_runs` deve devolver neste caso. */
let runSelectError: { message: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
  inserted = null;
  runRow = null;
  runUpdatePatch = null;
  versionUpdatePatch = null;
  insertError = null;
  versionSelectError = null;
  runSelectError = null;
  versionRow = {
    id: 1,
    current_version: "1.0.0",
    latest_version: "1.1.0",
    off_release: false,
    // A seção da versão INSTALADA precisa estar aqui: sem ela, todo caso
    // exercitaria o caminho "faixa incompleta" e o caminho feliz nasceria sem
    // cobertura nenhuma.
    changelog_raw:
      "## [1.1.0] — 2026-08-02\n\n**⚠️ Requer atenção**\n\nreconecte o número.\n\n### Adicionado\n\n- botão.\n\n## [1.0.0] — 2026-08-01\n\n- primeira versão.\n",
    agent_last_seen_at: new Date().toISOString(),
    compare_failed: false,
    update_requested_at: null,
  };

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => {
      // O double espelha o banco: `system_version` é sempre buscado por
      // `.eq("id", 1)`; `system_update_runs` é buscado tanto por
      // `.order().limit().maybeSingle()` (GET, pega o run mais recente,
      // qualquer status) quanto por `.eq("status","dispatched").order()
      // .limit().maybeSingle()` (POST, checa run em andamento). O `eq()`
      // do double PRECISA encadear para `order()` — se ele só devolvesse
      // `maybeSingle` direto, a chamada real do POST (`eq().order()...`)
      // quebraria com TypeError, e o teste "melhoraria" o mock em vez do
      // double refletir a query de verdade.
      const maybeSingle = async () => ({
        data: table === "system_version" ? versionRow : runRow,
        error: table === "system_version" ? versionSelectError : runSelectError,
      });
      return {
        select: () => ({
          eq: () => ({
            maybeSingle,
            order: () => ({ limit: () => ({ maybeSingle }) }),
          }),
          order: () => ({ limit: () => ({ maybeSingle }) }),
        }),
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (insertError) return { data: null, error: insertError };
              inserted = row;
              return { data: { id: "44444444-4444-4444-8444-444444444444", ...row }, error: null };
            },
          }),
        }),
        // Encadeável (`.update(patch).eq(...).eq(...)`, quantas vezes for) e
        // "thenable" só no fim — reflete a query real de expirar um run
        // ("...eq('id', x).eq('status','dispatched')") sem exigir um double
        // por chamada.
        update: (patch: Record<string, unknown>) => {
          const chain: { eq: () => typeof chain; then: Promise<{ error: null }>["then"] } = {
            eq: () => chain,
            then: (onFulfilled, onRejected) => {
              if (table === "system_update_runs") runUpdatePatch = patch;
              if (table === "system_version") versionUpdatePatch = patch;
              return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
            },
          };
          return chain;
        },
      };
    },
  } as never);
});

function get() {
  return new NextRequest("http://localhost/api/v1/system/version");
}
function post() {
  return new NextRequest("http://localhost/api/v1/system/update", { method: "POST" });
}

describe("GET /api/v1/system/version", () => {
  it("exige sessão", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null as never);
    const { GET } = await import("../version/route");
    const res = await GET(get());
    expect(res.status).toBe(401);
    // `unauthenticated`, não `unauthorized`: o catálogo (lib/api/errors.ts)
    // reserva `unauthorized` ao segredo interno das rotas host↔app. Um
    // frontend que decide por `error.code` (ex.: redirecionar pro login só em
    // `unauthenticated`) não reagiria a um código trocado — a asserção é o
    // que teria pego essa troca antes da revisão.
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
  });

  it("quando a leitura de system_version falha, devolve 500", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    versionSelectError = { message: "conexão caiu" };
    const { GET } = await import("../version/route");
    expect((await GET(get())).status).toBe(500);
  });

  it("quando a leitura do run mais recente falha, devolve 500", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    runSelectError = { message: "conexão caiu" };
    const { GET } = await import("../version/route");
    expect((await GET(get())).status).toBe(500);
  });

  it("entrega só a versão para quem não é dono do servidor", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(MEMBRO as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.current_version).toBe("1.0.0");
    expect(body.data.is_owner).toBe(false);
    expect(body.data.update_available).toBeUndefined();
    expect(body.data.notes).toBeUndefined();
  });

  it("entrega o estado completo e a faixa do CHANGELOG para o dono", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.update_available).toBe(true);
    expect(body.data.notes.sections.map((s: { version: string }) => s.version)).toEqual(["1.1.0"]);
    expect(body.data.notes.sections[0].body).toContain("botão");
    expect(body.data.notes.requires_attention).toEqual([
      { version: "1.1.0", texto: expect.stringContaining("reconecte o número") },
    ]);
    expect(body.data.notes.complete).toBe(true);
  });

  it("entrega TODAS as seções entre a instalada e a alvo, com o aviso do meio nomeado", async () => {
    // O defeito que esta faixa conserta: quem pula versões via só a seção-alvo,
    // e o aviso de ação manual da versão do meio desaparecia (commit ac9472c5).
    versionRow.current_version = "1.0.0";
    versionRow.latest_version = "1.2.0";
    versionRow.changelog_raw = [
      "## [1.2.0] — 2026-08-03",
      "",
      "### Adicionado",
      "",
      "- coisa nova.",
      "",
      "## [1.1.0] — 2026-08-02",
      "",
      "**⚠️ Requer atenção**",
      "",
      "reconecte o número.",
      "",
      "## [1.0.0] — 2026-08-01",
      "",
      "- primeira versão.",
      "",
    ].join("\n");
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.notes.sections.map((s: { version: string }) => s.version)).toEqual([
      "1.2.0",
      "1.1.0",
    ]);
    expect(body.data.notes.requires_attention.map((a: { version: string }) => a.version)).toEqual([
      "1.1.0",
    ]);
    expect(body.data.notes.complete).toBe(true);
  });

  it("declara faixa INCOMPLETA quando o texto não alcança a versão que está no ar", async () => {
    // O agente manda o CHANGELOG cortado em bytes. Um corpo truncado no meio da
    // frase é indistinguível de um corpo inteiro — sem este sinal, a tela
    // afirmaria completude que não tem.
    versionRow.changelog_raw = "## [1.1.0] — 2026-08-02\n\n### Adicionado\n\n- botão.\n";
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.notes.complete).toBe(false);
  });

  it("depois de um rollback a faixa parte da versão que VOLTOU AO AR, não da que quebrou", async () => {
    // `current_version` nomeia a versão que quebrou (o `git checkout` deu
    // certo; quem não subiu foi o container). Usar esse campo deixaria a faixa
    // vazia justamente para quem mais precisa lê-la.
    versionRow.current_version = "1.1.0";
    versionRow.latest_version = "1.1.0";
    runRow = {
      id: "run-1",
      status: "failed_rolled_back",
      from_version: "1.0.0",
      to_version: "1.1.0",
      last_step: null,
      log_tail: "",
      dispatched_at: new Date().toISOString(),
    } as never;
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.current_version).toBe("1.0.0");
    expect(body.data.notes.sections.map((s: { version: string }) => s.version)).toEqual(["1.1.0"]);
  });

  it("entrega compare_failed para a tela poder dizer 'não sei' em vez de 'está em dia'", async () => {
    versionRow.latest_version = "";
    versionRow.compare_failed = true;
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.compare_failed).toBe(true);
    // E não pode virar "há atualização": não sabemos que há.
    expect(body.data.update_available).toBe(false);
  });

  it("entrega has_known_release=false para distinguir 'nunca houve release' de 'à frente da publicada'", async () => {
    versionRow.latest_version = "";
    versionRow.off_release = true;
    versionRow.has_known_release = false;
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.has_known_release).toBe(false);
  });

  it("has_known_release default true quando a coluna nunca foi tocada por um heartbeat", async () => {
    delete versionRow.has_known_release;
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.has_known_release).toBe(true);
  });

  it("marca o agente como offline quando o heartbeat é velho", async () => {
    versionRow.agent_last_seen_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.agent_online).toBe(false);
  });

  it("entrega as versões do run e o log da tentativa (o diagnóstico da falha)", async () => {
    // `current_version` é o `git describe` do HOST e, numa falha, já aponta
    // para a versão que QUEBROU (o checkout acontece antes de o app subir).
    // Quem sabe de onde saiu e para onde tentou ir é o run — e o log é o
    // único diagnóstico que o dono tem sem abrir um terminal.
    versionRow.current_version = "1.1.0";
    runRow = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "failed_rolled_back",
      last_step: "banco",
      dispatched_at: new Date().toISOString(),
      from_version: "1.0.0",
      to_version: "1.1.0",
      log_tail: "✖ o app não respondeu ok",
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.run.from_version).toBe("1.0.0");
    expect(body.data.run.to_version).toBe("1.1.0");
    expect(body.data.run.log_tail).toContain("não respondeu ok");
    // A versão exibida é a do APP que está no ar (a que voltou), não o
    // checkout do host — que aponta para a que acabou de quebrar.
    expect(body.data.current_version).toBe("1.0.0");
    expect(body.data.update_available).toBe(true);
  });

  it("depois de um rollback, quem não é dono também vê a versão que está no ar", async () => {
    versionRow.current_version = "1.1.0";
    runRow = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "failed_rolled_back",
      last_step: "banco",
      dispatched_at: new Date().toISOString(),
      from_version: "1.0.0",
      to_version: "1.1.0",
      log_tail: "",
    };
    vi.mocked(loadAuthUser).mockResolvedValue(MEMBRO as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    // O rodapé da sidebar é o mesmo componente para todo mundo: se as duas
    // respostas divergissem, dois usuários da mesma instalação leriam versões
    // diferentes na mesma tela.
    expect(body.data.current_version).toBe("1.0.0");
  });

  it("um rollback que já foi SUPERADO por um deploy posterior não decide mais a versão", async () => {
    // Medido em produção: um run `failed_rolled_back` de 28/08 fazia o rodapé
    // anunciar `3414a2df` em 05/09, oito dias e vários deploys depois. A
    // heurística de rollback estava certa — ela existe porque, no instante da
    // falha, o checkout do host já é a versão nova e o contêiner voltou para a
    // velha — mas não tinha fim de validade, e o app troca por caminhos que não
    // criam run nenhum (`docker compose up -d`, deploy por CI, `update.sh` no
    // terminal). O desempate é temporal: se o agente do host gravou
    // `system_version` DEPOIS de o run terminar, ele viu o mundo mais recente.
    versionRow.current_version = "1.2.0";
    versionRow.updated_at = "2026-09-05T15:35:02.000Z";
    runRow = {
      id: "66666666-6666-4666-8666-666666666666",
      status: "failed_rolled_back",
      last_step: "banco",
      dispatched_at: "2026-08-28T01:47:53.000Z",
      finished_at: "2026-08-28T01:51:52.000Z",
      from_version: "1.0.0",
      to_version: "1.1.0",
      log_tail: "",
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.current_version).toBe("1.2.0");
    // O run continua na resposta: ele é o diagnóstico daquela falha, e some da
    // tela só quando alguém tenta atualizar de novo. O que ele deixa de fazer é
    // NOMEAR a versão no ar.
    expect(body.data.run.from_version).toBe("1.0.0");
  });

  it("sem `finished_at`, o run velho ainda decide — ausência de prova não é prova de deploy", async () => {
    // A guarda acima só pode agir quando existe o par de datas. Um run gravado
    // por uma versão antiga do agente não tem `finished_at`, e aí o
    // comportamento anterior é o seguro: o rollback é a informação mais
    // específica que a instalação tem sobre o que está no ar.
    versionRow.current_version = "1.1.0";
    versionRow.updated_at = "2026-09-05T15:35:02.000Z";
    runRow = {
      id: "77777777-7777-4777-8777-777777777777",
      status: "failed_rolled_back",
      last_step: "banco",
      dispatched_at: "2026-08-28T01:47:53.000Z",
      finished_at: null,
      from_version: "1.0.0",
      to_version: "1.1.0",
      log_tail: "",
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.current_version).toBe("1.0.0");
  });

  it("deriva unknown num run parado há muito tempo", async () => {
    runRow = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "dispatched",
      last_step: "banco",
      dispatched_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { GET } = await import("../version/route");
    const body = await (await GET(get())).json();
    expect(body.data.run.status).toBe("unknown");
  });
});

describe("POST /api/v1/system/update", () => {
  it("exige sessão", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null as never);
    const { POST } = await import("../update/route");
    const res = await POST(post());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
  });

  it("nega para quem não é dono do servidor", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(MEMBRO as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(403);
    expect(inserted).toBeNull();
  });

  it("quando a leitura de system_version falha, devolve 500 e não 409", async () => {
    // Sem checar o erro do select, `current`/`latest` viram "" e o fluxo cai
    // no 409 otimista de "você já está em dia" — a pior mensagem possível
    // bem na hora de uma falha de infraestrutura real.
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    versionSelectError = { message: "conexão caiu" };
    const { POST } = await import("../update/route");
    const res = await POST(post());
    expect(res.status).toBe(500);
    expect(inserted).toBeNull();
  });

  it("cria o run como ÚNICA ordem — sem um segundo estado em system_version", async () => {
    // O run insere e o flag `update_requested_at` marcava a mesma coisa em
    // outra tabela, sem transação e sem checar erro: falhando o segundo write,
    // a rota respondia 200, a tela mostrava a barra de passos e o agente nunca
    // pegava o pedido. Quem pediu e quando vive no run e no audit log.
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(200);
    expect(inserted).toMatchObject({
      from_version: "1.0.0",
      to_version: "1.1.0",
      status: "dispatched",
      requested_by: OWNER.id,
    });
    expect(versionUpdatePatch).toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "system.update_requested" }));
  });

  it("recusa um segundo pedido enquanto há run em andamento", async () => {
    runRow = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(409);
    // Run recente: não é expirado — nenhum UPDATE de expiração deve rolar.
    expect(runUpdatePatch).toBeNull();
  });

  it("expira um run 'dispatched' abandonado (agente morto há mais de 15min) e aceita o pedido novo", async () => {
    // Sem isto, o botão travaria PRA SEMPRE: o índice único parcial (migration
    // 0090) recusa qualquer novo run enquanto existir um "dispatched", e nada
    // nunca expirava um sozinho — só o agente reportando (que é justamente
    // quem morreu) fechava o run.
    runRow = {
      id: "55555555-5555-4555-8555-555555555555",
      status: "dispatched",
      dispatched_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h atrás > 15min (RUN_STALE_AFTER_MS)
    };
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(runUpdatePatch).toMatchObject({ status: "failed" });
    expect(inserted).toMatchObject({ from_version: "1.0.0", to_version: "1.1.0", status: "dispatched" });
  });

  it("recusa quando já está na última versão", async () => {
    versionRow.latest_version = "1.0.0";
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    const { POST } = await import("../update/route");
    expect((await POST(post())).status).toBe(409);
  });

  it("converte a violação do índice único (corrida de dois cliques) em 409, não 500", async () => {
    // O check "já existe run em andamento" é só otimização — não é exclusão
    // mútua. Sob corrida, os dois requests passam por ele (runRow === null
    // pros dois) e só o segundo INSERT bate no índice único parcial
    // `uniq_system_update_runs_dispatched`. O Postgres devolve 23505; a rota
    // precisa tratar isso como o MESMO estado de negócio do check acima, não
    // deixar vazar como 500.
    vi.mocked(loadAuthUser).mockResolvedValue(OWNER as never);
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "uniq_system_update_runs_dispatched"' };
    const { POST } = await import("../update/route");
    const res = await POST(post());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("state_conflict");
    expect(body.error.message).toBe("Já existe uma atualização em andamento.");
  });
});
