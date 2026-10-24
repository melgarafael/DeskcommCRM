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
/** Toda linha que a rota INSERE — hoje só a da volta automática (#2757). */
let inserts: Array<{ table: string } & Record<string, unknown>>;
/** Erro a devolver no INSERT deste caso. */
let insertError: { message: string } | null;

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
  inserts = [];
  insertError = null;

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
        // A volta automática (#2757) é a única escrita da rota que não é
        // `update`: ela CRIA a linha do run, porque ninguém pediu nada.
        insert: (patch: Record<string, unknown>) => {
          if (!insertError) inserts.push({ table, ...patch });
          return { error: insertError };
        },
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
    runRow = {
      id: RUN_ID,
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      to_version: "v1.1.0",
    };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(true);
    expect(body.data.run_id).toBe(RUN_ID);
  });

  it("o heartbeat entrega o ALVO do run — um 'voltar' não é a última release (#2757)", async () => {
    // O agente instala o `to_version` do run, e não a última publicada: num
    // pedido de volta (#2757) o alvo é a versão ANTERIOR, e quem seguisse a
    // última release estaria reinstalando a release que acabou de quebrar.
    // Sem este campo na resposta, o agente não tem como saber qual é o alvo.
    runRow = {
      id: RUN_ID,
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      to_version: "v1.0.0",
    };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.to_version).toBe("v1.0.0");
  });

  it("run sem to_version (rota anterior a #2757) devolve alvo vazio, nunca a última release", async () => {
    runRow = { id: RUN_ID, status: "dispatched", dispatched_at: new Date().toISOString() };
    const { POST } = await import("./route");
    const body = await (await POST(req(HEARTBEAT))).json();
    expect(body.data.update_requested).toBe(true);
    // Vazio é o sinal para o agente cair no de sempre (`--to <última release>`),
    // e não uma tentativa de adivinhar o alvo a partir do ambiente.
    expect(body.data.to_version).toBe("");
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

/**
 * #2757 (ajuste 3): a volta que o AGENTE fez sozinho tem de chegar ao painel.
 *
 * Até aqui ela só existia no `.update-agent.log` da VPS: quem abria a tela via
 * a versão mudar e não tinha como saber o que houve. O agente manda o fato por
 * esta rota — o mesmo canal do heartbeat e do run_result — e a rota grava uma
 * linha de run JÁ FECHADA (`failed_rolled_back`), com as duas versões, a hora e
 * o motivo. `requested_by` fica NULO de propósito: é a marca de "ninguém pediu
 * isto" que a tela usa para dizer "voltou sozinho".
 *
 * #3271 acrescenta o DESFECHO: o mesmo recado passa a dizer se a volta
 * TERMINOU (`ok`), e a rota escreve `failed` quando não terminou. Sem isso a
 * tela tratava os dois desfechos como um só — afirmava "é a que está no ar
 * agora" e escondia a saída de um clique justamente na volta que falhou.
 */
describe("POST /api/v1/system/agent — a volta automática (#2757)", () => {
  /** O recado do agente: o desfecho vai no CAMPO `ok`, medido do `update.sh`. */
  const VOLTA = {
    kind: "rollback",
    returned_to: "1.4.2",
    failed_version: "1.5.0",
    ok: true,
    reason: "o site não respondeu em 2 healthchecks seguidos logo depois da atualização",
  };

  it("⭐ grava a volta como run fechado: para onde voltou, de onde, a hora e o motivo", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(VOLTA));

    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: "system_update_runs",
      status: "failed_rolled_back",
      // `from_version` = onde o sistema ESTÁ (a volta); `to_version` = a que falhou.
      from_version: "1.4.2",
      to_version: "1.5.0",
      log_tail: VOLTA.reason,
      // A marca de "ninguém pediu": sem ela a tela diria "Voltei", e não "voltou sozinho".
      requested_by: null,
    });
    // A hora é do servidor (a mesma máquina do host) e sai nos DOIS carimbos:
    // `dispatched_at` põe esta linha como a mais recente no que a tela lê, e
    // `finished_at` é a hora que o aviso mostra.
    // `noUncheckedIndexedAccess`: `inserts[0]` é `Linha | undefined` para o TS. O guarda
    // transforma o `toHaveLength(1)` acima em estreitamento de tipo de verdade (e não em
    // `as any`): se a rota não gravou nada, o teste falha aqui, com nome.
    const linhaDaVolta = inserts[0];
    if (!linhaDaVolta) throw new Error("a rota não gravou a linha do run da volta automática");
    expect(linhaDaVolta.finished_at).toBeTruthy();
    expect(linhaDaVolta.dispatched_at).toEqual(linhaDaVolta.finished_at);
    // Nada de fechar run alheio nem de sujar o estado da versão.
    expect(updates).toEqual([]);
  });

  it("audita a volta como fim de atualização, dizendo que foi automática", async () => {
    const { audit } = await import("@/lib/audit");
    const { POST } = await import("./route");
    await POST(req(VOLTA));

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "system.update_finished",
        metadata: expect.objectContaining({
          volta_automatica: true,
          de: "1.5.0",
          para: "1.4.2",
        }),
      }),
    );
  });

  it("⭐ volta que NÃO terminou (ok:false) fecha como `failed` — e a auditoria conta o mesmo desfecho", async () => {
    // O desfecho é lido do CAMPO, e não do texto do `reason`: o motivo termina
    // com o código da volta ("… código 7"), mas parsear frase não é contrato —
    // e foi justamente por o código existir só no texto que a tela tratava
    // igual a volta que terminou e a que falhou (#3271). `failed` é o
    // vocabulário que ela já sabe ler como "não sei em que versão o sistema
    // está": é ele que a faz parar de afirmar "é a que está no ar agora" e
    // manter o botão de voltar.
    const { audit } = await import("@/lib/audit");
    const { POST } = await import("./route");
    const res = await POST(
      req({ ...VOLTA, ok: false, reason: `${VOLTA.reason} (a volta terminou com código 7)` }),
    );

    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      status: "failed",
      // As duas versões continuam nomeando o MESMO fato: de onde se tentou
      // sair e para onde a volta foi.
      from_version: "1.4.2",
      to_version: "1.5.0",
      requested_by: null,
    });
    expect(inserts[0]?.status).not.toBe("failed_rolled_back");
    // A auditoria não pode contar a história antiga enquanto a linha do run
    // conta a nova.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ status: "failed", volta_automatica: true }),
      }),
    );
  });

  it("volta de agente ANTERIOR a este contrato (sem `ok`) fecha como `failed`: sem prova de que terminou, a tela não afirma", async () => {
    // O container do app atualiza antes do script do host — o mesmo bootstrap
    // que faz o `compare_failed` ser opcional. Então o recado velho chega à
    // rota nova. Ausente é "ninguém mediu o desfecho", e o lado conservador é
    // NÃO afirmar que a versão anterior está no ar: afirmar sem prova é o
    // defeito medido na issue, e a leitura pessimista erra para o lado em que a
    // tela oferece a saída (o botão de voltar), nunca para o de tranquilizar.
    const recadoAntigo = {
      kind: "rollback",
      returned_to: "1.4.2",
      failed_version: "1.5.0",
      reason: "o site não respondeu em 2 healthchecks seguidos logo depois da atualização",
    };
    const { POST } = await import("./route");
    const res = await POST(req(recadoAntigo));

    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ status: "failed" });
  });

  it("recusa volta sem a versão de origem (o aviso diria 'voltou para a undefined')", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ ...VOLTA, returned_to: "" }));
    expect(res.status).toBe(422);
    expect(inserts).toEqual([]);
  });

  it("quando o banco recusa a linha → 500, e o agente fica sabendo (nada de 200 otimista)", async () => {
    insertError = { message: "conexão caiu" };
    const { POST } = await import("./route");
    const res = await POST(req(VOLTA));
    expect(res.status).toBe(500);
  });
});
