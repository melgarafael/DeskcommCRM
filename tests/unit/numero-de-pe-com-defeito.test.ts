import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O NÚMERO DE PÉ, MAS NÃO INTEIRO — que a tela dizia "Conectado".
 *
 * ─── O defeito (27/10/2026) ─────────────────────────────────────────────────
 *
 * A sonda de saúde do canal intermediado (`GET /v1/accounts/{id}/health`)
 * traz dois campos que `checkHealth` ignorava:
 *
 *   - `platformConnection.inboundWebhookSubscribed: false` — a Meta diz que o
 *     webhook de mensagens do número não chega ao provedor: ele ENVIA e não
 *     RECEBE. As mensagens dos clientes somem sem sintoma nenhum no envio;
 *   - `messagingRestriction` — a plataforma recusou envio do número com 131042
 *     (pagamento), 131031 (conta bloqueada) ou 368 (política).
 *
 * Com os dois ignorados, o número figurava `WORKING`, sem aviso e sem motivo.
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * - a leitura dos dois campos, na forma MEDIDA numa instalação real
 *   (27/10/2026: `inboundWebhookSubscribed` booleano dentro de
 *   `platformConnection`; `messagingRestriction` na RAIZ, `null` sem restrição);
 * - que o status continua `WORKING` — barrar o envio seria pior (a restrição só
 *   se desfaz quando uma mensagem volta a ser entregue);
 * - o aviso na Central (crítico, no idioma da organização, uma vez por episódio,
 *   fechado quando a sonda volta limpa) e o motivo em `status_reason`, que a
 *   tela de Conexões mostra.
 */

const ORG = "00000000-0000-4000-8000-000000000297";

const zernioCreds = vi.fn(async () => ({
  accountId: "conta-1",
  apiKey: "chave",
  baseUrl: "https://z.example",
  source: "session" as const,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) as never }));
vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveZernioCreds: (...a: unknown[]) => zernioCreds(...(a as [])),
}));

import {
  DETALHE_NAO_RECEBE,
  PREFIXO_ENVIO_RESTRITO,
  avisoDaConexao,
  defeitoDoNumero,
  motivoParaGravar,
  sincronizarSaudeDaConexao,
} from "@/lib/channels/health";

function respondeCom(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "",
    json: async () => body,
  })) as unknown as typeof fetch;
}

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

async function saude() {
  const { zernioAdapter } = await import("@/lib/channels/adapters/zernio");
  return zernioAdapter.checkHealth!({ organizationId: ORG, sessionRef: "conta-1" });
}

/** A forma MEDIDA numa instalação real em 27/10/2026, com os valores de um número inteiro. */
const MEDIDA = {
  status: "healthy",
  messagingRestriction: null,
  issues: [],
  platformConnection: {
    status: "connected",
    phoneStatus: "CONNECTED",
    metaError: null,
    inboundWebhookSubscribed: true,
    checkedAt: "2026-10-27T03:12:00.000Z",
  },
};

describe("a sonda lê os dois campos", () => {
  it("controle: o número inteiro, na forma medida, segue de pé e sem defeito", async () => {
    globalThis.fetch = respondeCom(MEDIDA);
    expect(await saude()).toEqual({ reachable: true, status: "WORKING", detail: null });
  });

  it("⭐ envia mas NÃO recebe: continua WORKING, com o defeito no detalhe", async () => {
    globalThis.fetch = respondeCom({
      ...MEDIDA,
      status: "warning",
      issues: ["inbound webhook not subscribed"],
      platformConnection: { ...MEDIDA.platformConnection, inboundWebhookSubscribed: false },
    });
    expect(await saude()).toEqual({ reachable: true, status: "WORKING", detail: DETALHE_NAO_RECEBE });
  });

  it("`null` é 'a Meta não informou' — não é evidência, não vira defeito", async () => {
    globalThis.fetch = respondeCom({
      ...MEDIDA,
      platformConnection: { ...MEDIDA.platformConnection, inboundWebhookSubscribed: null },
    });
    const r = await saude();
    expect(r.detail).toBeNull();
    expect(r.defeitosSemMedida, "`null` não pode contar como recebimento medido").toEqual(["nao_recebe"]);
  });

  it("chave de restrição ausente não é restrição limpa; `null` é", async () => {
    const { messagingRestriction: _fora, ...semAChave } = MEDIDA;
    globalThis.fetch = respondeCom(semAChave);
    expect((await saude()).defeitosSemMedida).toEqual(["envio_restrito"]);
  });

  it("corpo ilegível não mede nada", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>", { status: 200 })) as never;
    expect((await saude()).defeitosSemMedida).toEqual(["nao_recebe", "envio_restrito"]);
  });

  it.each([131042, 131031, 368])(
    "⭐ envio restrito pela plataforma (%s): continua WORKING, com o código no detalhe",
    async (code) => {
      globalThis.fetch = respondeCom({
        ...MEDIDA,
        messagingRestriction: { code, subcode: null, message: "texto livre da plataforma", firstSeenAt: "x", lastSeenAt: "y" },
      });
      const r = await saude();
      expect(r).toEqual({ reachable: true, status: "WORKING", detail: `${PREFIXO_ENVIO_RESTRITO}${code}` });
      expect(r.detail, "a mensagem crua da plataforma não entra no detalhe").not.toContain("texto livre");
    },
  );

  it("os dois de uma vez: não receber vem antes — é o que ninguém vê pelo envio", async () => {
    globalThis.fetch = respondeCom({
      ...MEDIDA,
      messagingRestriction: { code: 131042 },
      platformConnection: { ...MEDIDA.platformConnection, inboundWebhookSubscribed: false },
    });
    expect((await saude()).detail).toBe(DETALHE_NAO_RECEBE);
  });

  it("restrição sem `platformConnection` também é lida", async () => {
    globalThis.fetch = respondeCom({ status: "warning", messagingRestriction: { code: 368 } });
    expect(await saude()).toEqual({ reachable: true, status: "WORKING", detail: `${PREFIXO_ENVIO_RESTRITO}368` });
  });

  it("o elo caído continua FAILED — o defeito não mascara a queda", async () => {
    globalThis.fetch = respondeCom({
      status: "error",
      messagingRestriction: { code: 131042 },
      platformConnection: { status: "disconnected", metaError: { code: 100, subcode: 33 }, inboundWebhookSubscribed: false },
    });
    expect(await saude()).toMatchObject({ status: "FAILED", detail: "meta_100_33" });
  });
});

const NAO_RECEBE = { reachable: true, status: "WORKING", detail: DETALHE_NAO_RECEBE };
const RESTRITO = { reachable: true, status: "WORKING", detail: `${PREFIXO_ENVIO_RESTRITO}131042` };
const INTEIRO = { reachable: true, status: "WORKING", detail: null };
/** De pé, sem defeito à vista, e a sonda não informou o recebimento. */
const SEM_MEDIDA = { ...INTEIRO, defeitosSemMedida: ["nao_recebe" as const] };

describe("o vocabulário do defeito", () => {
  it("o vocabulário do defeito é fechado: código fora do formato vira `desconhecido`", () => {
    expect(defeitoDoNumero(`${PREFIXO_ENVIO_RESTRITO}131042`)).toEqual({ tipo: "envio_restrito", codigo: "131042" });
    expect(defeitoDoNumero(`${PREFIXO_ENVIO_RESTRITO}<script>`)).toEqual({ tipo: "envio_restrito", codigo: "desconhecido" });
    expect(defeitoDoNumero("connection_repair_required")).toBeNull();
    expect(defeitoDoNumero(null)).toBeNull();
  });
});

describe("o aviso na Central", () => {
  it("⭐ não recebe: crítico, de número, com QUAL conexão no título", () => {
    const a = avisoDaConexao(NAO_RECEBE, "Loja Centro");
    expect(a).toMatchObject({ kind: "channel_number_alert", severity: "critical", episodio: "NAO_RECEBE" });
    expect(a?.title).toBe('O número "Loja Centro" não recebe mensagens');
    expect(a?.body).toContain("Reconecte o número em Conexões");
  });

  it("⭐ no idioma da organização — espanhol", () => {
    const a = avisoDaConexao(NAO_RECEBE, "Loja Centro", "es");
    expect(a?.title).toBe('El número "Loja Centro" no recibe mensajes');
    expect(a?.body).toContain("Vuelve a conectar el número en Conexiones");
    const r = avisoDaConexao(RESTRITO, "Loja Centro", "es");
    expect(r?.title).toBe('Meta restringió el envío del número "Loja Centro"');
    expect(r?.body).toContain("Revisa el método de pago");
  });

  it("envio restrito: o porquê pelo código, e que o aviso fecha sozinho", () => {
    const a = avisoDaConexao(RESTRITO, "Vendas");
    expect(a).toMatchObject({ kind: "channel_number_alert", severity: "critical", episodio: "ENVIO_RESTRITO_131042" });
    expect(a?.title).toBe('A Meta restringiu o envio do número "Vendas"');
    expect(a?.body).toContain("pagamento");
    expect(a?.body).toContain("fecha sozinho");
    expect(avisoDaConexao({ ...RESTRITO, detail: `${PREFIXO_ENVIO_RESTRITO}368` }, "Vendas")?.body).toContain("política");
    expect(avisoDaConexao({ ...RESTRITO, detail: `${PREFIXO_ENVIO_RESTRITO}999` }, "Vendas")?.body).toContain("código 999");
  });

  it("controle: o número inteiro não avisa nada", () => {
    expect(avisoDaConexao(INTEIRO, "Vendas")).toBeNull();
  });
});

interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
}
const ops: Op[] = [];
let escalado: string | null = null;

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  ops.push({ tabela, op, payload });
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle") return async () => ({ data: { escalated_status: escalado }, error: null });
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const admin = {
  from: (t: string) => ({
    select: () => chain(t, "select"),
    insert: (p: unknown) => chain(t, "insert", p),
    update: (p: unknown) => chain(t, "update", p),
    upsert: (p: unknown) => chain(t, "upsert", p),
  }),
} as never;

const sessao = { id: "sess-1", organization_id: ORG, status: "WORKING" };

describe("uma vez por episódio, e fecha quando a sonda volta limpa", () => {
  beforeEach(() => {
    ops.length = 0;
    escalado = null;
  });

  it("⭐ abre o aviso, marcado com a sessão, e grava o episódio", async () => {
    expect(await sincronizarSaudeDaConexao(admin, sessao, NAO_RECEBE, "Vendas", "varredura", "es")).toBe("avisado");
    const ins = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "insert");
    expect(ins?.payload).toMatchObject({
      kind: "channel_number_alert",
      severity: "critical",
      ref_kind: "channel_session",
      ref_id: "sess-1",
      title: 'El número "Vendas" no recibe mensajes',
    });
    expect(ops.find((o) => o.tabela === "channel_session_health" && o.op === "upsert")?.payload).toMatchObject({
      escalated_status: "NAO_RECEBE",
    });
  });

  it("a rodada seguinte, com o mesmo defeito, não repete", async () => {
    escalado = "NAO_RECEBE";
    expect(await sincronizarSaudeDaConexao(admin, sessao, NAO_RECEBE, "Vendas")).toBe("ja_avisado");
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("⭐ a sonda volta limpa: o aviso é resolvido", async () => {
    escalado = "ENVIO_RESTRITO_131042";
    expect(await sincronizarSaudeDaConexao(admin, sessao, INTEIRO, "Vendas")).toBe("resolvido");
    expect(ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "update")?.payload).toMatchObject({ status: "resolved" });
  });

  it("⭐ a sonda não informou o recebimento: o crítico de quem não recebe continua aberto", async () => {
    escalado = "NAO_RECEBE";
    const aberta = { ...sessao, status_reason: DETALHE_NAO_RECEBE };
    expect(await sincronizarSaudeDaConexao(admin, aberta, SEM_MEDIDA, "Vendas")).toBe("sem_mudanca");
    expect(ops.some((o) => o.op === "update" || o.op === "upsert"), "fechou sem medir").toBe(false);
  });

  it("um soluço da sonda no meio não muda isso: o motivo gravado é quem diz o que segue aberto", async () => {
    escalado = "UNREACHABLE";
    const aberta = { ...sessao, status_reason: DETALHE_NAO_RECEBE };
    expect(await sincronizarSaudeDaConexao(admin, aberta, SEM_MEDIDA, "Vendas")).toBe("sem_mudanca");
  });

  it("não informar o recebimento não prende a restrição, que foi medida limpa", async () => {
    escalado = "ENVIO_RESTRITO_131042";
    const aberta = { ...sessao, status_reason: `${PREFIXO_ENVIO_RESTRITO}131042` };
    expect(await sincronizarSaudeDaConexao(admin, aberta, SEM_MEDIDA, "Vendas")).toBe("resolvido");
  });
});

describe("o motivo que a tela de Conexões mostra (`status_reason`)", () => {
  it("⭐ grava o defeito do número de pé", () => {
    expect(motivoParaGravar(NAO_RECEBE, null)).toBe(DETALHE_NAO_RECEBE);
    expect(motivoParaGravar(RESTRITO, DETALHE_NAO_RECEBE)).toBe(`${PREFIXO_ENVIO_RESTRITO}131042`);
  });

  it("não regrava o mesmo motivo a cada rodada", () => {
    expect(motivoParaGravar(NAO_RECEBE, DETALHE_NAO_RECEBE)).toBeUndefined();
  });

  it("⭐ limpa o defeito que ela mesma gravou quando a sonda volta limpa", () => {
    expect(motivoParaGravar(INTEIRO, DETALHE_NAO_RECEBE)).toBeNull();
  });

  it("⭐ sem medida, o motivo fica: o cartão não volta a «Conectado» por falta de informação", () => {
    expect(motivoParaGravar(SEM_MEDIDA, DETALHE_NAO_RECEBE)).toBeUndefined();
    // O que foi medido limpo fecha mesmo com o outro lado sem medida.
    expect(motivoParaGravar(SEM_MEDIDA, `${PREFIXO_ENVIO_RESTRITO}131042`)).toBeNull();
  });

  it("não toca no motivo de outro dono, nem quando não deu para perguntar ou o número caiu", () => {
    expect(motivoParaGravar(INTEIRO, "connection_repair_required")).toBeUndefined();
    expect(motivoParaGravar(INTEIRO, null)).toBeUndefined();
    expect(motivoParaGravar({ reachable: false, status: null, detail: "ECONNRESET" }, DETALHE_NAO_RECEBE)).toBeUndefined();
    expect(motivoParaGravar({ reachable: true, status: "FAILED", detail: null }, DETALHE_NAO_RECEBE)).toBeUndefined();
  });

  // A fiação no vigia (ler o motivo, gravá-lo, passar o idioma) é provada pela
  // ROTA em `vigia-grava-o-defeito-do-numero.test.ts`: um caso por expressão
  // regular aqui passou verde com a escrita desligada pelo sabotador.
});
