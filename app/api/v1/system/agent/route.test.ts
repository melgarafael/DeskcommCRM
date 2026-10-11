import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo-de-teste", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const RUN_ID = "33333333-3333-4333-8333-333333333333";

function req(body: unknown, secret = "segredo-de-teste") {
  return new NextRequest("http://localhost/api/v1/system/agent", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

const HEARTBEAT = {
  kind: "heartbeat",
  current_version: "1.0.0",
  current_sha: "abc1234",
  off_release: false,
  latest_version: "1.1.0",
  changelog: "## [1.1.0] — 2026-08-02\n\nnovidade\n",
};

/** Estado do banco simulado, controlado por caso. */
let versionRow: Record<string, unknown>;
let runRow: Record<string, unknown> | null;
/** Erro a devolver em toda leitura (`maybeSingle`) de `system_update_runs` neste caso. */
let runReadError: { message: string } | null;
/** Erro a devolver no `update()` de uma tabela específica neste caso. */
let updateErrorByTable: Partial<Record<string, { message: string }>>;
/**
 * Erro a devolver SÓ na escrita das três colunas da rodada do banco (as
 * cosméticas), para medir que o desfecho não depende delas.
 */
let rodadaWriteError: { message: string } | null;
/**
 * Todo `update()` bem-sucedido, na ordem em que ocorreu — em vez de "a
 * última chamada global" (que esconde qual das DUAS escritas do run_result
 * realmente aconteceu quando a ordem entre elas importa).
 */
let updates: Array<{ table: string } & Record<string, unknown>>;

function lastUpdate(table: string) {
  return [...updates].reverse().find((u) => u.table === table) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();

  versionRow = { id: 1, update_requested_at: null, update_requested_by: null };
  runRow = null;
  runReadError = null;
  updateErrorByTable = {};
  rodadaWriteError = null;
  updates = [];

  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => {
      const maybeSingle = async () => ({
        data: table === "system_version" ? versionRow : runRow,
        error: table === "system_update_runs" ? runReadError : null,
      });
      return {
        select: () => ({
          eq: () => ({
            maybeSingle,
            // Composição real usada pelo lookup do run pendente no heartbeat:
            // select().eq("status","dispatched").order(...).limit(1).maybeSingle().
            order: () => ({ limit: () => ({ maybeSingle }) }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            // A escrita da RODADA DO BANCO é reconhecível pelas próprias colunas:
            // o caso que mede "coluna cosmética não derruba o desfecho" precisa
            // derrubar SÓ ela, e deixar a que fecha o run passar.
            const soARodada =
              "disputa_de_banco" in patch ||
              "retentativas_do_banco" in patch ||
              "passada_do_banco" in patch;
            const error =
              (soARodada ? rodadaWriteError : null) ?? updateErrorByTable[table] ?? null;
            if (!error) updates.push({ table, ...patch });
            return { error };
          },
        }),
      };
    },
  } as never);
});

describe("POST /api/v1/system/agent", () => {
  it("recusa sem o segredo", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT, "segredo-errado"));
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it("recusa segredo de tamanho diferente sem lançar (timingSafeEqual explode com buffers de tamanho distinto)", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT, "x"));
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it("heartbeat grava versão, changelog e o carimbo de vida do agente", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT));
    expect(res.status).toBe(200);
    expect(lastUpdate("system_version")).toMatchObject({
      table: "system_version",
      current_version: "1.0.0",
      latest_version: "1.1.0",
    });
    expect(lastUpdate("system_version")?.agent_last_seen_at).toBeTruthy();
  });

  it("heartbeat responde update_requested=false quando ninguém pediu", async () => {
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(false);
    expect(body.data.run_id).toBeNull();
  });

  it("heartbeat responde a ordem pendente e devolve o run", async () => {
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(true);
    expect(body.data.run_id).toBe(RUN_ID);
  });

  it("heartbeat devolve a intenção de força e o alvo: é o agent.sh que vira --force, nunca o payload", async () => {
    // #2756: o botão da tela manda `{ force: true }`; a rota guarda nos DOIS o
    // alvo; o agente lê aqui na frente, no heartbeat seguinte. Sem estes dois
    // campos no corpo da resposta, o pedido chega ao host sem a força e o
    // update.sh responde "você já está na versão mais recente" — sucesso sem
    // trocar imagem nenhuma.
    runRow = {
      id: RUN_ID,
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      force_requested: true,
      force_target: "v1.0.0",
    };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.force).toBe(true);
    expect(body.data.force_target).toBe("v1.0.0");
  });

  it("pedido pelo botão de sempre: force=false e alvo vazio, na resposta do heartbeat", async () => {
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.force).toBe(false);
    expect(body.data.force_target).toBe("");
  });

  it("o run em 'dispatched' basta como pedido — nenhum flag em system_version porteia", async () => {
    // Havia DUAS fontes de verdade para "alguém pediu": o run e o flag
    // `update_requested_at`, escrito por um segundo write sem transação e sem
    // checagem de erro no POST /update. Falhando esse write, a rota respondia
    // 200, a tela mostrava a barra de passos por 15 minutos e o agente nunca
    // via o pedido. Este caso é exatamente esse estado: run criado, flag não.
    versionRow = { id: 1, update_requested_at: null, update_requested_by: null };
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(true);
    expect(body.data.run_id).toBe(RUN_ID);
  });

  it("heartbeat grava compare_failed quando o host não conseguiu comparar", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ ...HEARTBEAT, latest_version: "", compare_failed: true }));
    expect(res.status).toBe(200);
    expect(lastUpdate("system_version")).toMatchObject({ compare_failed: true });
  });

  it("aceita heartbeat de agente ANTIGO, sem o campo compare_failed", async () => {
    // O container do app atualiza antes do script do host — é literalmente o
    // bootstrap desta feature. Se o campo novo fosse obrigatório, o agente
    // antigo passaria a levar 422 e ficaria mudo: a tela pararia de saber a
    // versão instalada por causa de um campo que existe para evitar silêncio.
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT));
    expect(res.status).toBe(200);
    expect(lastUpdate("system_version")).toMatchObject({ compare_failed: false });
  });

  it("heartbeat grava has_known_release quando o host nunca viu tag publicada", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ ...HEARTBEAT, off_release: true, latest_version: "", has_known_release: false }));
    expect(res.status).toBe(200);
    expect(lastUpdate("system_version")).toMatchObject({ has_known_release: false });
  });

  it("aceita heartbeat de agente ANTIGO, sem o campo has_known_release (preserva 'à frente da publicada')", async () => {
    // Mesmo raciocínio do compare_failed: um agente que ainda não foi
    // atualizado não manda este campo, e o default precisa preservar o
    // comportamento ANTERIOR ("à frente da publicada"), não virar
    // silenciosamente "nunca houve release" para toda instalação existente.
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT));
    expect(res.status).toBe(200);
    expect(lastUpdate("system_version")).toMatchObject({ has_known_release: true });
  });

  it("recusa changelog acima do teto", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ ...HEARTBEAT, changelog: "x".repeat(70_000) }));
    expect(res.status).toBe(422);
  });

  it("heartbeat quando o lookup do run pendente falha no banco → 500 (nunca 'ninguém pediu')", async () => {
    runReadError = { message: "PGRST116: mais de uma linha" };
    const { POST } = await import("./route");
    const res = await POST(req(HEARTBEAT));
    expect(res.status).toBe(500);
  });

  it("run_progress grava o passo sem encerrar o run", async () => {
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_progress", run_id: RUN_ID, step: "banco" }));
    expect(res.status).toBe(200);
    expect(lastUpdate("system_update_runs")).toMatchObject({ table: "system_update_runs", last_step: "banco" });
    expect(lastUpdate("system_update_runs")?.status).toBeUndefined();
  });

  it("run_progress quando o update falha → 500", async () => {
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    updateErrorByTable.system_update_runs = { message: "conexão caiu" };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_progress", run_id: RUN_ID, step: "banco" }));
    expect(res.status).toBe(500);
  });

  it("run_result encerra o run e audita o desfecho, sem tocar em system_version", async () => {
    const { audit } = await import("@/lib/audit");
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "success", log_tail: "ok" }));
    expect(res.status).toBe(200);
    expect(lastUpdate("system_update_runs")).toMatchObject({ table: "system_update_runs", status: "success" });
    expect(lastUpdate("system_update_runs")?.finished_at).toBeTruthy();
    // Fechar o run É o fim do pedido: não existe segundo estado para limpar.
    expect(lastUpdate("system_version")).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "system.update_finished", resourceId: RUN_ID }),
    );
  });

  it("⭐ a rodada do banco que o kit manda chega nas três colunas (corpo PLANO, nomes da rota)", async () => {
    // O `z.object` descarta chave desconhecida em SILÊNCIO: o corpo que o
    // `agent.sh` mandava antes (um objeto aninhado em `rodada_do_banco`, com as
    // chaves `disputa`/`retentativas`/`passada`) passava no parse, os três campos
    // opcionais chegavam `undefined` e as colunas eram gravadas NULAS em toda
    // rodada — a tela calada para sempre, que é o silêncio que este PR veio
    // eliminar. Este caso alimenta o corpo LITERAL que o kit monta agora.
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(
      req({
        kind: "run_result",
        run_id: RUN_ID,
        status: "success",
        log_tail: "ok",
        disputa_de_banco: true,
        retentativas_do_banco: 2,
        passada_do_banco: 3,
      }),
    );

    expect(res.status).toBe(200);
    const escritas = updates.filter((u) => u.table === "system_update_runs");
    expect(escritas).toHaveLength(2);
    expect(escritas[0]).toMatchObject({
      disputa_de_banco: true,
      retentativas_do_banco: 2,
      passada_do_banco: 3,
    });
    expect(escritas[1]).toMatchObject({ status: "success" });
  });

  it("coluna da rodada que o banco recusa NÃO derruba o desfecho: o run fecha assim mesmo", async () => {
    // `42703` (banco anterior à migration da rodada) ou a CHECK recusando o
    // número: na mesma escrita do `status`, isso virava 500, o `post` do agente
    // recebia vazio e o run ficava preso em `dispatched` para sempre.
    rodadaWriteError = { message: "column system_update_runs.passada_do_banco does not exist" };
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(
      req({
        kind: "run_result",
        run_id: RUN_ID,
        status: "success",
        log_tail: "ok",
        disputa_de_banco: true,
        retentativas_do_banco: 2,
        passada_do_banco: 3,
      }),
    );

    expect(res.status).toBe(200);
    const escritas = updates.filter((u) => u.table === "system_update_runs");
    expect(escritas).toHaveLength(1);
    expect(escritas[0]).toMatchObject({ status: "success" });
    expect(escritas[0]?.finished_at).toBeTruthy();
  });

  it("quando a leitura do run falha no banco → 500, nunca 404", async () => {
    // Erro de leitura não é "esse run não existe": virando 404, o agente
    // desistiria de reportar um desfecho que aconteceu de verdade.
    runReadError = { message: "conexão caiu" };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "success", log_tail: "ok" }));
    expect(res.status).toBe(500);
    expect(updates).toEqual([]);
  });

  it("run_progress quando a leitura do run falha no banco → 500, nunca 404", async () => {
    runReadError = { message: "conexão caiu" };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_progress", run_id: RUN_ID, step: "banco" }));
    expect(res.status).toBe(500);
    expect(updates).toEqual([]);
  });

  it("run_result quando falha ao finalizar o run → 500, sem limpar o pedido e sem auditoria", async () => {
    const { audit } = await import("@/lib/audit");
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    updateErrorByTable.system_update_runs = { message: "conexão caiu" };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "success", log_tail: "ok" }));
    expect(res.status).toBe(500);
    // Pior caso vira "pedido pendente com run ainda dispatched" (detectável e
    // auto-curável no próximo heartbeat) — nunca um run órfão invisível.
    expect(lastUpdate("system_version")).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("recusa reescrever um run que já terminou", async () => {
    runRow = { id: RUN_ID, status: "success", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const res = await POST(req({ kind: "run_result", run_id: RUN_ID, status: "failed", log_tail: "" }));
    expect(res.status).toBe(409);
    expect(updates).toEqual([]);
  });

  it("recusa corpo com kind desconhecido", async () => {
    const { POST } = await import("./route");
    expect((await POST(req({ kind: "sei-la" }))).status).toBe(422);
  });
});
