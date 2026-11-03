/**
 * #3416 — Abrir o QR sem parear NÃO ocupa o número do plano.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * No assistente do primeiro acesso (ou em Conexões › Conectar novo WhatsApp) a
 * pessoa abre o QR e não lê. O WAHA derruba a sessão em `FAILED` quando o
 * código expira e a linha fica de pé: ela conta no "Máximo de números conectados"
 * (as duas réguas contam linha com `archived_at is null`), a faixa vermelha
 * anuncia "WhatsApp sem nome está desconectado" e a Central ganha dois críticos —
 * um quando o QR foi pedido, outro quando expirou. Para quem só testa o produto,
 * parece que quebrou.
 *
 * ─── O que estes casos prendem, na ordem em que a pessoa vive ───────────────
 *
 *   A) pedido do QR → nenhum aviso; expiração → a linha é ARQUIVADA, nunca
 *      vira `FAILED`; o contador do plano cai para zero; a faixa não aparece;
 *      o assistente volta a `NOT_STARTED` (deixa conectar de novo);
 *   B) a sessão que JÁ pareou segue contando, avisando e aparecendo — regressão
 *      zero medida, não afirmada;
 *   C) a faixa não anuncia sessão sem número mesmo quando a linha sobrevive
 *      (legado de antes do fix);
 *   D) as três cercas do arquivamento: reserva em execução, sessão com número
 *      e história pendurada.
 *
 * ─── Por que entra pelo CAMINHO DE PRODUÇÃO ─────────────────────────────────
 *
 * O evento entra por `dispatchWahaEvent`, o mesmo roteador dos webhooks reais, e
 * o que se afirma é o EFEITO: linhas na tabela, itens na Central, o retorno de
 * `lerUsoDaOrganizacao` (o contador que a tela de assinatura mostra) e o que
 * `listarConexoesCaidas` entrega à faixa. Asserção sobre texto-fonte doeria
 * verde com a chamada dentro de `if (false)` — este repo já viu esse sabote
 * sobreviver em `tests/unit/channel-health-aviso.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { descartarSessaoQueNuncaPareou } from "@/lib/channels/descartar-sem-parear";
import { listarConexoesCaidas } from "@/lib/channels/health";
import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";
import { lerUsoDaOrganizacao } from "@/lib/cobranca/uso";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

type Linha = Record<string, unknown>;
type Filtro = (linha: Linha) => boolean;

const ORG = "00000000-0000-4000-8000-000000000001";
const SESSAO = "11111111-1111-4111-8111-111111111111";
const PAREADA = "22222222-2222-4222-8222-222222222222";

/**
 * Um banco em memória que devolve o que o CÓDIGO pediu, não o que a linha tem.
 *
 * Cada `from()` tem o SEU pedido — não dá para dividir: `lerUsoDaOrganizacao`
 * monta duas cadeias no mesmo `Promise.all` e elas só são resolvidas depois que
 * as duas montaram. Um `req` compartilhado faria as duas contagens voltarem o
 * mesmo número.
 *
 * A projeção é o coração: `select("phone_number")` sem a coluna no select devolve
 * objeto SEM a chave, e é isso que o ingest lê (`"phone_number" in linha`). Uma
 * regressão que tire a coluna do select deixa o arquivamento mudo e estes casos
 * ficam vermelhos — exatamente o que um dublê que devolve a linha inteira
 * esconderia.
 */
function banco() {
  let antesDeArquivar: (() => void) | undefined;
  let arquivamentoSemRecibo = false;
  const estado = {
    tabelas: {} as Record<string, Linha[]>,
    ops: [] as { tabela: string; op: string; payload?: unknown }[],
  };
  const linhasDe = (tabela: string): Linha[] => (estado.tabelas[tabela] ??= []);
  const registrar = (tabela: string, op: string, payload?: unknown) => {
    estado.ops.push({ tabela, op, payload });
  };

  const projetar = (colunas: string | undefined, linha: Linha): Linha => {
    if (!colunas || colunas.trim() === "" || colunas.trim() === "*") return { ...linha };
    return Object.fromEntries(
      colunas
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((k) => [k, linha[k]]),
    );
  };

  /**
   * `metadata->>onboarding.eq.true,waha_session_name.eq.x` — o `.or()` da reserva —
   * e `provider.neq.waha,phone_number.not.is.null,status.not.in.(FAILED,STOPPED)`,
   * o da contagem de vagas (`lib/cobranca/uso.ts`). A vírgula dentro de `in.(…)`
   * não separa condição.
   */
  const casaOr = (expressao: string, linha: Linha): boolean =>
    (expressao.match(/[^,(]+(?:\([^)]*\))?/g) ?? []).some((pedaco) => {
      const [campo, ...partes] = pedaco.split(".");
      const negado = partes[0] === "not";
      const [operador, ...resto] = negado ? partes.slice(1) : partes;
      const esperado = resto.join(".");
      const valor = (campo ?? "")
        .split("->>")
        .reduce<unknown>(
          (atual, parte) =>
            atual && typeof atual === "object" ? (atual as Linha)[parte] : undefined,
          linha,
        );
      let casa: boolean;
      if (operador === "eq") casa = String(valor ?? "") === esperado;
      else if (operador === "neq") casa = String(valor ?? "") !== esperado;
      else if (operador === "is" && esperado === "null") casa = valor == null;
      else if (operador === "in") casa = esperado.replace(/^\(|\)$/g, "").split(",").includes(String(valor ?? ""));
      else return false;
      return negado ? !casa : casa;
    });

  function from(nome: string) {
    const pedido = {
      mutacao: null as null | { op: string; payload?: unknown },
      filtros: [] as Filtro[],
      colunas: undefined as string | undefined,
      limite: null as number | null,
      ordem: null as { col: string; asc: boolean } | null,
      contagem: false,
    };

    const selecionar = (unico: boolean): { data: unknown; error: null; count?: number } => {
      let achadas = linhasDe(nome).filter((l) => pedido.filtros.every((f) => f(l)));
      if (pedido.ordem) {
        const { col, asc } = pedido.ordem;
        achadas = [...achadas].sort((a, b) => {
          const x = String(a[col] ?? "");
          const y = String(b[col] ?? "");
          return asc ? x.localeCompare(y) : y.localeCompare(x);
        });
      }
      if (pedido.contagem) return { data: null, error: null, count: achadas.length };
      const projetadas = achadas.map((l) => projetar(pedido.colunas, l));
      if (unico) return { data: projetadas[0] ?? null, error: null };
      return {
        data: pedido.limite === null ? projetadas : projetadas.slice(0, pedido.limite),
        error: null,
      };
    };

    const executar = (): { data: unknown; error: { message: string } | null } => {
      const m = pedido.mutacao;
      if (m) {
        if (nome === "channel_sessions" && m.op === "update" && (m.payload as Linha).archived_at) {
          antesDeArquivar?.();
          if (arquivamentoSemRecibo) return { data: [], error: null };
        }
        const alvo = linhasDe(nome).filter((l) => pedido.filtros.every((f) => f(l)));
        if (m.op === "update") alvo.forEach((l) => Object.assign(l, m.payload));
        else if (m.op === "insert") {
          const novas = Array.isArray(m.payload) ? m.payload : [m.payload];
          novas.forEach((l) => linhasDe(nome).push({ ...(l as Linha) }));
        } else if (m.op === "upsert") {
          const payload = { ...(m.payload as Linha) };
          const existente = linhasDe(nome).find((l) =>
            ["organization_id", "channel_session_id"].every((k) => l[k] === payload[k]),
          );
          if (existente) Object.assign(existente, payload);
          else linhasDe(nome).push(payload);
        } else if (m.op === "delete") {
          estado.tabelas[nome] = linhasDe(nome).filter(
            (l) => !pedido.filtros.every((f) => f(l)),
          );
        }
        // UPDATE ... SELECT retorna somente as linhas afetadas, em snapshots.
        return { data: pedido.colunas ? alvo.map((l) => projetar(pedido.colunas, l)) : null, error: null };
      }
      return selecionar(false);
    };

    const api = {
      select(colunas?: string, opts?: { count?: string }) {
        pedido.colunas = colunas;
        pedido.contagem = opts?.count === "exact";
        return api;
      },
      eq(col: string, valor: unknown) {
        pedido.filtros.push((l) => l[col] === valor);
        return api;
      },
      neq(col: string, valor: unknown) {
        pedido.filtros.push((l) => l[col] !== valor);
        return api;
      },
      is(col: string, valor: unknown) {
        pedido.filtros.push((l) => (valor === null ? l[col] == null : l[col] === valor));
        return api;
      },
      in(col: string, valores: readonly unknown[]) {
        pedido.filtros.push((l) => (valores as unknown[]).includes(l[col]));
        return api;
      },
      or(expressao: string) {
        pedido.filtros.push((l) => casaOr(expressao, l));
        return api;
      },
      not() {
        return api;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        pedido.ordem = { col, asc: opts?.ascending !== false };
        return api;
      },
      limit(n: number) {
        pedido.limite = n;
        return api;
      },
      update(payload: unknown) {
        registrar(nome, "update", payload);
        pedido.mutacao = { op: "update", payload };
        return api;
      },
      delete() {
        registrar(nome, "delete");
        pedido.mutacao = { op: "delete" };
        return api;
      },
      insert(payload: unknown) {
        registrar(nome, "insert", payload);
        pedido.mutacao = { op: "insert", payload };
        return api;
      },
      upsert(payload: unknown) {
        registrar(nome, "upsert", payload);
        pedido.mutacao = { op: "upsert", payload };
        return api;
      },
      maybeSingle() {
        return Promise.resolve(selecionar(true));
      },
      then<T = unknown>(
        cumprido?: (v: { data: unknown; error: { message: string } | null }) => T | PromiseLike<T>,
        recusado?: (motivo: unknown) => T | PromiseLike<T>,
      ): Promise<T> {
        return Promise.resolve(executar()).then(cumprido, recusado);
      },
    };
    return api;
  }

  return {
    admin: { from } as never,
    aoArquivar(acao: () => void) { antesDeArquivar = acao; },
    semReciboDeArquivamento() { arquivamentoSemRecibo = true; },
    semear(tabela: string, linhas: Linha[]) {
      estado.tabelas[tabela] = linhas.map((l) => ({ ...l }));
    },
    linhas(tabela: string) {
      return linhasDe(tabela);
    },
    escritas(tabela: string, op: string) {
      return estado.ops.filter((o) => o.tabela === tabela && o.op === op);
    },
  };
}

vi.mock("@/lib/logger", () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => b.admin }));

/** O assistente do primeiro acesso — é a tela que a pessoa reabre depois (cenário C). */
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  requireAuth: vi.fn(async () => ({ user: { id: "user-1" } })),
  loadAuthUser: vi.fn(async () => ({ id: "user-1", idioma: "pt-BR" })),
  orgAtivaSemPortao: vi.fn(async () => ({ orgId: ORG })),
}));
vi.mock("@/lib/auth/require-role", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  orgAtivaDaApi: vi.fn(async () => ({ ok: true, org: { orgId: ORG } })),
  requireRole: vi.fn(async () => ({ ok: true, org: { orgId: ORG }, user: { id: "user-1" } })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => b.admin) }));
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: vi.fn(() => ({ getVerifiedSession: vi.fn(async () => null) })),
  wahaFriendlyError: (mensagem: string) => mensagem,
}));

let b = banco();

/** A sessão como o webhook a entrega: id + o que o warm-up lê. */
function sessaoDoEvento(id: string) {
  return { id, organization_id: ORG, is_warmup_complete: null, warmup_started_at: null };
}

async function evento(status: string, id: string = SESSAO) {
  await dispatchWahaEvent(
    b.admin,
    sessaoDoEvento(id) as never,
    { event: "session.status", payload: { status } },
    "req-3416",
  );
}

function linhaSemNumero(extra: Linha = {}): Linha {
  return {
    id: SESSAO,
    organization_id: ORG,
    provider: "waha",
    // Nome gerado pela reserva — não é a seed do e2e, que a faixa filtra à parte.
    waha_session_name: "org_00000000_a1b2c3d4",
    display_name: null,
    phone_number: null,
    status: "SCAN_QR_CODE",
    archived_at: null,
    created_at: "2026-10-25T10:00:00.000Z",
    metadata: { onboarding: true },
    ...extra,
  };
}

function linhaPareada(extra: Linha = {}): Linha {
  return linhaSemNumero({
    id: PAREADA,
    display_name: "Comercial",
    phone_number: "+5511999998888",
    status: "WORKING",
    ...extra,
  });
}

beforeEach(() => {
  b = banco();
});

describe("cenário A — abriu o QR, não leu, expirou", () => {
  it("⭐ pedir o QR não abre aviso crítico na Central", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);

    await evento("SCAN_QR_CODE");

    expect(b.escritas("agent_inbox_items", "insert")).toEqual([]);
    expect(b.linhas("channel_sessions")).toHaveLength(1);
  });

  it("⭐ expirar sem parear NÃO vira FAILED: a linha é arquivada e a Central fica calada", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);

    await evento("FAILED");

    const linha = b.linhas("channel_sessions")[0]!;
    expect(linha, "a sessão sem número sumiu em vez de virar histórico").toBeTruthy();
    expect(linha.status, "a linha virou uma sessão FAILED").not.toBe("FAILED");
    expect(linha.status).toBe("STOPPED");
    expect(linha.archived_at, "fora da UI sem arquivar").toEqual(expect.any(String));
    expect(b.escritas("agent_inbox_items", "insert")).toEqual([]);
  });

  it("⭐ o contador do plano é liberado — é ele que a tela de assinatura mostra", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);
    // Antes do arquivamento a sessão ocupa a vaga — é a medição da issue.
    expect((await lerUsoDaOrganizacao(b.admin as never, ORG))?.canais).toBe(1);

    await evento("FAILED");

    expect(await lerUsoDaOrganizacao(b.admin as never, ORG)).toEqual({ assentos: 0, canais: 0 });
  });

  it("⭐ a faixa vermelha não aparece depois da expiração", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);

    await evento("FAILED");

    expect(await listarConexoesCaidas(b.admin as never, ORG)).toEqual([]);
  });

  it("⭐ o assistente reaberto volta a NOT_STARTED, com a linha à espera do pareamento", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);

    await evento("FAILED");

    const { GET } = await import("@/app/api/v1/onboarding/whatsapp/session/route");
    const res = await GET();
    const corpo = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(200);
    // `route.ts:23` — `if (!channel || channel.archived_at) → NOT_STARTED`: sem
    // isto a pessoa cairia no 404 do QR e não conseguiria conectar de novo.
    expect(corpo.data.status, "o assistente continuou com a sessão que expirou").toBe(
      "NOT_STARTED",
    );
    // E a linha não foi apagada: é ela que `connectWahaChannel` ressuscita no
    // clique seguinte (`tests/unit/canal-arquivado-caminho-de-volta.test.ts`,
    // "retomar o pareamento ressuscita", roda junto no gate).
    expect(b.linhas("channel_sessions")).toHaveLength(1);
    expect(await loadOnboardingChannel(b.admin as never, ORG)).toMatchObject({
      archived_at: expect.any(String),
    });
  });
});

describe("cenário B — a sessão que já pareou continua como hoje", () => {
  it("⭐ segue CONTANDO no plano e aparecendo na faixa quando cai", async () => {
    b.semear("channel_sessions", [linhaPareada({ status: "FAILED" })]);

    expect(await lerUsoDaOrganizacao(b.admin as never, ORG)).toEqual({ assentos: 0, canais: 1 });
    expect(await listarConexoesCaidas(b.admin as never, ORG)).toEqual([
      { id: PAREADA, apelido: "Comercial", status: "FAILED" },
    ]);
  });

  it("⭐ segue AVISANDO: a queda de um número vira crítico na Central", async () => {
    b.semear("channel_sessions", [linhaPareada({ status: "WORKING" })]);

    await evento("FAILED", PAREADA);

    const linha = b.linhas("channel_sessions")[0]!;
    expect(linha).toMatchObject({ status: "FAILED", phone_number: "+5511999998888" });

    const aviso = b.escritas("agent_inbox_items", "insert")[0];
    expect(aviso, "a conexão pareada parou de avisar").toBeTruthy();
    expect(aviso?.payload).toMatchObject({
      kind: "channel_number_alert",
      severity: "critical",
      ref_kind: "channel_session",
      ref_id: linha.id,
    });
  });

  it("o QR de um número JÁ pareado segue pedindo rescan — é reconexão, não defeito", async () => {
    b.semear("channel_sessions", [linhaPareada({ status: "FAILED" })]);

    await evento("SCAN_QR_CODE", PAREADA);

    const aviso = b.escritas("agent_inbox_items", "insert")[0];
    expect(aviso?.payload).toMatchObject({ kind: "qr_rescan", severity: "critical" });
  });
});

describe("a faixa — sessão sem número não é conexão caída", () => {
  it("⭐ não renderiza o 'WhatsApp sem nome está desconectado' para sessão sem número", async () => {
    // Linha que SOBREVIVEU (legado de antes do fix): mesmo assim a faixa fica
    // calada, porque não há número para anunciar.
    b.semear("channel_sessions", [
      linhaSemNumero({ id: "33333333-3333-4333-8333-333333333333", status: "FAILED" }),
      linhaPareada({ status: "FAILED" }),
    ]);

    const caidas = await listarConexoesCaidas(b.admin as never, ORG);

    expect(caidas.map((c) => c.id)).toEqual([PAREADA]);
    expect(caidas.every((c) => c.apelido !== "sem nome")).toBe(true);
  });

  it("⭐ canal caído COM apelido e sem número gravado CONTINUA na faixa", async () => {
    // O outro lado da régua, medido no e2e que derrubou o CI:
    // `tests/e2e/atender-pelo-celular.spec.ts`, caso A-6 — o teste semeia um
    // canal `FAILED` com `display_name` e SEM `phone_number` e cobra a faixa
    // visível. É conexão de alguém: sem número gravado, a faixa é o ÚNICO aviso
    // que essa queda tem. O fix #3416 cala a linha SEM número E SEM nome (o
    // caso acima); calar esta também seria trocar um alarme falso por um alarme
    // apagado.
    //
    // Esta asserção não é redundante com a de cima: no CI o defeito de régua
    // passou batido pelo unit e só o e2e pegou (sabotagem medida: reverter o
    // filtro para `phone_number` só e o gate local fica rc=0). É por isto que
    // ela existe — o regresso tem de custar verde AQUI.
    b.semear("channel_sessions", [
      linhaSemNumero({
        id: "66666666-6666-4666-8666-666666666666",
        status: "FAILED",
        display_name: "Caído sem número",
      }),
    ]);

    const caidas = await listarConexoesCaidas(b.admin as never, ORG);

    expect(caidas).toEqual([
      {
        id: "66666666-6666-4666-8666-666666666666",
        apelido: "Caído sem número",
        status: "FAILED",
      },
    ]);
  });
});

describe("as cercas do arquivamento", () => {
  it("reserva em execução NÃO é mexida — a conexão que a pessoa acabou de pedir segue", async () => {
    b.semear("channel_sessions", [linhaSemNumero({ status: "STARTING" })]);
    b.semear("channel_connection_requests", [
      {
        id: "44444444-4444-4444-8444-444444444444",
        organization_id: ORG,
        channel_session_id: SESSAO,
        state: "processing",
        lease_until: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);

    await evento("FAILED");

    // Sem reserva seria arquivamento; com reserva, o evento volta ao caminho de
    // sempre — que ainda assim não abre aviso, porque a sessão não tem número.
    expect(b.linhas("channel_sessions")).toHaveLength(1);
    expect(b.linhas("channel_sessions")[0]).toMatchObject({
      status: "FAILED",
      archived_at: null,
    });
    expect(b.escritas("agent_inbox_items", "insert")).toEqual([]);
  });

  it("sessão COM número nunca é arquivada por este caminho", async () => {
    b.semear("channel_sessions", [linhaPareada({ status: "WORKING" })]);

    await evento("FAILED", PAREADA);

    expect(b.linhas("channel_sessions")[0]).toMatchObject({ archived_at: null, status: "FAILED" });
  });

  it("arquivar não leva história junto — a conversa da linha permanece", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);
    b.semear("conversations", [
      {
        id: "55555555-5555-4555-8555-555555555555",
        organization_id: ORG,
        channel_session_id: SESSAO,
      },
    ]);

    await evento("FAILED");

    expect(b.linhas("channel_sessions")[0]).toMatchObject({ archived_at: expect.any(String) });
    expect(b.linhas("conversations")).toHaveLength(1);
  });
});


describe("pareamento concorrente à expiração do QR", () => {
  it("um número chega depois da leitura: nem arquivamento nem fallback derrubam o pareamento", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);
    b.aoArquivar(() => {
      Object.assign(b.linhas("channel_sessions")[0]!, {
        phone_number: "+5511999998888", status: "WORKING", display_name: "Comercial",
      });
    });
    await evento("FAILED");
    expect(b.linhas("channel_sessions")[0]).toMatchObject({
      phone_number: "+5511999998888", status: "WORKING", archived_at: null,
    });
    expect(b.escritas("agent_inbox_items", "update")).toEqual([]);
    expect(b.escritas("agent_inbox_items", "insert")).toEqual([]);
  });

  it("WORKING já foi confirmado, mesmo sem telefone espelhado: não arquiva nem volta a FAILED", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);
    b.aoArquivar(() => { b.linhas("channel_sessions")[0]!.status = "WORKING"; });
    await evento("FAILED");
    expect(b.linhas("channel_sessions")[0]).toMatchObject({ status: "WORKING", archived_at: null });
    expect(b.escritas("agent_inbox_items", "update")).toEqual([]);
  });

  it("zero linhas arquivadas não fecha avisos como se a sessão tivesse sido removida", async () => {
    b.semear("channel_sessions", [linhaSemNumero()]);
    b.semear("agent_inbox_items", [{
      id: "aviso-aberto", organization_id: ORG, ref_kind: "channel_session", ref_id: SESSAO,
      status: "open", kind: "channel_number_alert",
    }]);
    b.semear("channel_session_health", [{
      organization_id: ORG, channel_session_id: SESSAO, escalated_status: "FAILED",
    }]);
    b.semReciboDeArquivamento();
    // Isola o fechador de arquivamento do reconciliador normal de saúde,
    // que também pode encerrar alertas antigos de uma sessão sem número.
    const desfecho = await descartarSessaoQueNuncaPareou(b.admin, {
      id: SESSAO, organization_id: ORG, status: "FAILED", phone_number: null,
    });
    expect(desfecho).toBe("preservada");
    expect(b.linhas("channel_sessions")[0]!.archived_at).toBeNull();
    expect(b.escritas("agent_inbox_items", "update")).toEqual([]);
    expect(b.linhas("agent_inbox_items")[0]!.status).toBe("open");
    expect(b.linhas("channel_session_health")[0]!.escalated_status).toBe("FAILED");
    expect(b.escritas("channel_session_health", "update")).toEqual([]);
  });
});
