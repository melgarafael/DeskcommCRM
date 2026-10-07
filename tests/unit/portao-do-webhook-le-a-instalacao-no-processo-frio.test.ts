/**
 * O PORTÃO DO WEBHOOK SEGUE A INSTALAÇÃO DESDE O PRIMEIRO PEDIDO DO PROCESSO.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `authenticateWahaWebhook` decide "exigir assinatura" lendo a MEMÓRIA do
 * processo (`exigirAssinaturaNoWebhookDaInstalacao`, síncrona, `globalThis`).
 * Quem enche essa memória no Next é `carregarComportamentoDaInstalacao()` — e,
 * no PR #1058 como chegou, só a tela `/admin/sistema`, a server action que
 * salva e o card de orçamento chamavam essa função. As duas rotas de webhook
 * não chamavam.
 *
 * Consequência, a cada reinício do app (inclusive o do `update.sh`): até
 * alguém abrir uma daquelas telas, a entrada de mensagens obedecia ao `.env`,
 * e não à escolha salva na tela — nas duas direções. "Exigir" ligado pela tela
 * deixava passar entrega sem assinatura; "exigir" desligado pela tela com o
 * `.env` em `true` cortava a ingestão.
 *
 * ─── Por que o teste do PR não pegava ───────────────────────────────────────
 *
 * `lib/instalacao/comportamento.test.ts` chama `carregarComportamento(...)`
 * ANTES do portão: prova a costura leitor↔memória, não o caminho que a rota
 * percorre. Este arquivo chama o `POST` das ROTAS com a memória VAZIA — o
 * estado de um processo recém-subido — e só o banco (mockado) sabe a escolha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { envMock, linhaDaInstalacao, leiturasDaInstalacao, leiturasDaSessao, decifragens, despachados } = vi.hoisted(() => ({
  envMock: {
    WAHA_HMAC_SECRET: "",
    WAHA_WEBHOOK_REQUIRE_SIGNATURE: "false",
    AI_BUDGET_ENFORCEMENT: undefined as string | undefined,
    DISCLOSURE_MODE: undefined as string | undefined,
    PROMISE_SEMANTIC_ENABLED: undefined as string | undefined,
  },
  linhaDaInstalacao: { atual: null as Record<string, unknown> | null },
  leiturasDaInstalacao: { n: 0 },
  leiturasDaSessao: { n: 0 },
  decifragens: { n: 0 },
  despachados: [] as unknown[],
}));

vi.mock("@/lib/env", () => ({ env: envMock }));

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  waha_session_name: "default",
  webhook_secret_encrypted: "\\x00",
  status: "WORKING",
  is_warmup_complete: true,
  warmup_started_at: null,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                leiturasDaInstalacao.n += 1;
                return { data: linhaDaInstalacao.atual, error: null };
              },
            }),
          }),
        };
      }
      // A rota lê o id da linha arquivada (`insert().select("id")`) e depois grava
      // o desfecho nela (`update().eq("id", …)`) — ver `lib/waha/desfecho-do-webhook.ts`.
      return {
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
    // Sessão sem segredo utilizável: o caso real de quem roda WAHA Core.
    // `fn_decrypt_oauth('\x00')` devolve NULL em produção (migration 0240).
    rpc: async () => {
      decifragens.n += 1;
      return { data: null, error: null };
    },
  }),
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => {
    leiturasDaSessao.n += 1;
    return { data: SESSAO, error: null };
  },
}));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

vi.mock("@/lib/waha/ingest", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  dispatchWahaEvent: async (_a: unknown, _s: unknown, envelope: unknown) => {
    despachados.push(envelope);
  },
}));

import { POST as postSemToken } from "@/app/api/v1/webhooks/waha/route";
import { POST as postComToken } from "@/app/api/v1/webhooks/waha/[token]/route";
import { comportamentoEmVigor, esquecerComportamento } from "@/lib/instalacao/comportamento";
import { limparMemoriaDeSessoes } from "@/lib/waha/sessao-do-webhook";

const CORPO = { event: "message", session: "default", payload: { id: "wamid.X" } };

/** Entrega SEM o header `x-webhook-hmac`. */
const semAssinatura = () =>
  ({
    text: async () => JSON.stringify(CORPO),
    headers: new Headers(),
  }) as never;

const linha = (exigir: boolean | null) => ({
  orcamento_de_ia: null,
  exigir_assinatura_no_webhook: exigir,
  divulgacao_de_pagamento: null,
  promessa_semantica: null,
});

beforeEach(() => {
  // O processo recém-subido: nenhuma leitura nesta vida do processo.
  esquecerComportamento();
  leiturasDaInstalacao.n = 0;
  leiturasDaSessao.n = 0;
  decifragens.n = 0;
  despachados.length = 0;
  // A sessão `default` é reutilizada entre casos.
  limparMemoriaDeSessoes();
});

describe("rota sem token — processo frio", () => {
  it("a tela EXIGE assinatura e o .env não: entrega sem assinatura é recusada", async () => {
    envMock.WAHA_WEBHOOK_REQUIRE_SIGNATURE = "false";
    linhaDaInstalacao.atual = linha(true);
    expect(comportamentoEmVigor(), "a memória devia começar vazia").toBeNull();

    const res = await postSemToken(semAssinatura());

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "unauthenticated", message: "signature_required" },
    });
    expect(despachados, "a entrega sem assinatura chegou à ingestão").toHaveLength(0);
    expect(leiturasDaInstalacao.n, "a rota não leu a linha da instalação").toBeGreaterThan(0);
  });

  it("a tela DISPENSA assinatura e o .env exige: a entrega entra", async () => {
    // A outra direção do mesmo defeito: o piso cortaria a ingestão de quem já
    // desligou a exigência pela tela.
    envMock.WAHA_WEBHOOK_REQUIRE_SIGNATURE = "true";
    linhaDaInstalacao.atual = linha(false);

    const res = await postSemToken(semAssinatura());

    expect(res.status).toBe(200);
    expect(despachados).toHaveLength(1);
  });

  it("sem linha (a instalação nunca abriu a tela), vale o .env — o de antes", async () => {
    envMock.WAHA_WEBHOOK_REQUIRE_SIGNATURE = "true";
    linhaDaInstalacao.atual = null;

    const res = await postSemToken(semAssinatura());

    expect(res.status).toBe(401);
    expect(despachados).toHaveLength(0);
  });
});

describe("rota por token — processo frio", () => {
  const ctx = { params: Promise.resolve({ token: "token-da-sessao-1" }) };

  it("a tela EXIGE assinatura e o .env não: entrega sem assinatura é recusada", async () => {
    envMock.WAHA_WEBHOOK_REQUIRE_SIGNATURE = "false";
    linhaDaInstalacao.atual = linha(true);
    expect(comportamentoEmVigor(), "a memória devia começar vazia").toBeNull();

    const res = await postComToken(semAssinatura(), ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "unauthenticated", message: "signature_required" },
    });
    expect(despachados).toHaveLength(0);
  });
});

describe("memória da sessão com o segredo que produção devolve", () => {
  it("sessão com '\\x00' (decifra para null): 10 eventos no mesmo processo = 1 leitura e 1 decifragem", async () => {
    // O dublê aqui imita produção: sem isto, a memória do PR #2469 passava nos
    // testes e nunca guardava nada em instalação nenhuma criada pelo produto.
    envMock.WAHA_WEBHOOK_REQUIRE_SIGNATURE = "false";
    linhaDaInstalacao.atual = linha(false);

    for (let i = 0; i < 10; i++) {
      expect((await postSemToken(semAssinatura())).status).toBe(200);
    }

    expect(despachados).toHaveLength(10);
    expect(leiturasDaSessao.n, "cada evento voltou ao banco pela sessão").toBe(1);
    expect(decifragens.n, "cada evento voltou ao banco pelo segredo").toBe(1);
  });
});
