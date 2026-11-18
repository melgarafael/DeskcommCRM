/**
 * POST /api/v1/contacts — o contato novo abre conversa, mas não pode abrir calado (#3718).
 *
 * A regra ("esta porta abre, a importação por CSV não") mora em
 * `lib/contacts/conversa-ao-criar.ts`; o que se mede AQUI é o encanamento do
 * handler unitário, que é a outra porta:
 *
 *   1. contato com telefone e WhatsApp pronto → RPC `fn_service_begin` chamada
 *      com a sessão de TELEFONE, não com a social mais antiga;
 *   2. conversa que falha (sessão torta, RPC fora) → o cadastro continua de pé
 *      e o erro SAI no log. Era o `catch {}` vazio: contato sem conversa e
 *      nenhuma linha para investigar.
 *   3. a conversa abre pelo cliente de SERVIÇO, não pelo da sessão. O
 *      `fn_service_begin` é concedido só a `service_role` (baseline); com o
 *      cliente do cookie a RPC volta 42501, e o contato nascia sem conversa
 *      com um `logger.warn` como único rastro. O falso de sessão abaixo recusa
 *      a RPC como o banco recusa — e o último caso confere essa concessão no
 *      próprio baseline, para o falso não inventar um grant que não existe.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { PROVIDERS_DE_MENSAGEM, PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { logger } from "@/lib/logger";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const servico = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => servico.db }));

const ORG = "44444444-4444-4444-8444-444444444444";
const USUARIO = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const CONVERSA = "77777777-7777-4777-8777-777777777777";
const TELEFONE = "(11) 98888-7777";

type Linha = Record<string, unknown>;

/** `from(...)` encadeável como o PostgREST: só resolve no `await`. */
function cadeia(tabela: string, sessoes: Linha[]) {
  let atual = tabela === "channel_sessions" ? [...sessoes] : [];
  let teto: number | null = null;
  const self = {
    select: () => self,
    insert: () => self,
    update: () => self,
    order: (coluna: string) => {
      atual = [...atual].sort((a, b) =>
        String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")),
      );
      return self;
    },
    eq: (c: string, v: unknown) => {
      atual = atual.filter((l) => l[c] === v);
      return self;
    },
    is: (c: string, v: unknown) => {
      atual = atual.filter((l) => (l[c] ?? null) === v);
      return self;
    },
    in: (c: string, vs: unknown[]) => {
      atual = atual.filter((l) => vs.includes(l[c]));
      return self;
    },
    not: () => self,
    limit: (n: number) => {
      teto = n;
      return self;
    },
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({
      // O insert de `contacts` devolve a ficha como o PostgREST devolveria.
      data:
        tabela === "contacts"
          ? {
              id: CONTATO,
              organization_id: ORG,
              phone_number: TELEFONE,
              name: "Ana",
              display_name: null,
              email: null,
              source: "manual",
              tags: [],
              consent: {},
              custom_fields: {},
            }
          : null,
      error: null,
    }),
    then: (ok: (r: { data: Linha[]; error: null }) => unknown) =>
      ok({ data: teto === null ? atual : atual.slice(0, teto), error: null }),
  };
  return self;
}

function cliente(
  opcoes: {
    sessoes?: Linha[];
    erroDaRpc?: { message: string } | null;
    /** `authenticated` = cliente do cookie: sem EXECUTE em `fn_service_begin`. */
    papel?: "service_role" | "authenticated";
  } = {},
) {
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const from = vi.fn((tabela: string) => cadeia(tabela, opcoes.sessoes ?? []));
  const rpc = vi.fn(async (nome: string, args: Record<string, unknown> = {}) => {
    rpcs.push({ nome, args });
    if (nome !== "fn_service_begin") return { data: null, error: null };
    if (opcoes.papel === "authenticated") {
      return {
        data: null,
        error: { code: "42501", message: "permission denied for function fn_service_begin" },
      };
    }
    if (opcoes.erroDaRpc) return { data: null, error: opcoes.erroDaRpc };
    return {
      data: {
        organization_id: ORG,
        contact_id: CONTATO,
        conversation_id: CONVERSA,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        status: "open",
        demanda_fechada_em: null,
      },
      error: null,
    };
  });
  return { db: { from, rpc } as never, rpcs, from };
}

/** Nomeadas pela CAPACIDADE, não pelo fornecedor (doutrina de restrição de canal). */
const SESSAO_QUE_DISCA: Linha = {
  id: "sessao-que-disca",
  organization_id: ORG,
  provider: PROVIDERS_DE_TELEFONE[0],
  status: "WORKING",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
};
const SESSAO_SOCIAL: Linha = {
  id: "sessao-social",
  organization_id: ORG,
  provider: PROVIDERS_DE_MENSAGEM.find(
    (p) => !(PROVIDERS_DE_TELEFONE as readonly string[]).includes(p),
  )!,
  status: "WORKING",
  archived_at: null,
  created_at: "2025-01-01T00:00:00Z", // mais antiga: é ela que o `order` traria sem a preferência
};

function ctx(): HandlerCtx {
  return { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-3718" };
}

/** A rota com cookie: o handler recebe o cliente da SESSÃO; o de serviço vem do módulo. */
function criar(doServico: { db: never }, daSessao = cliente({ papel: "authenticated" })) {
  servico.db = doServico.db;
  return createContactHandler(daSessao.db, ctx(), {
    name: "Ana",
    phone_number: TELEFONE,
  } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createContactHandler — o contato novo abre a conversa (#3718)", () => {
  it("abre pela sessão de TELEFONE, mesmo com a social sendo a mais antiga da org", async () => {
    const banco = cliente({ sessoes: [SESSAO_SOCIAL, SESSAO_QUE_DISCA] });
    const daSessao = cliente({ papel: "authenticated" });

    const { contact } = await criar(banco, daSessao);

    expect(contact.id).toBe(CONTATO);
    const abertura = banco.rpcs.find((r) => r.nome === "fn_service_begin");
    expect(abertura?.args).toMatchObject({
      p_org: ORG,
      p_contact: CONTATO,
      p_session: "sessao-que-disca",
    });
    // E o evento do contato continua saindo, como antes, pelo cliente da rota.
    expect(daSessao.rpcs.some((r) => r.nome === "emit_event")).toBe(true);
  });

  it("conversa que falha não derruba o cadastro — e agora deixa o erro no log", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const banco = cliente({
      sessoes: [SESSAO_QUE_DISCA],
      erroDaRpc: { message: "service_channel_not_found" },
    });

    const { contact, action } = await criar(banco);

    expect(action).toBe("created");
    expect(contact.id).toBe(CONTATO);
    // O defeito da issue: antes este `catch` era vazio, então a mesma falha
    // produzia um 201 impecável e um contato sem conversa, sem uma linha de log.
    expect(aviso).toHaveBeenCalledTimes(1);
    expect(aviso.mock.calls[0]![1]).toMatchObject({
      porta: "manual",
      organization_id: ORG,
      contact_id: CONTATO,
      detail: "service_channel_not_found",
    });
  });

  it("pelo cookie, a conversa abre pelo cliente de serviço — a sessão não executa fn_service_begin", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const daSessao = cliente({ sessoes: [SESSAO_QUE_DISCA], papel: "authenticated" });
    const doServico = cliente({ sessoes: [SESSAO_QUE_DISCA] });

    await criar(doServico, daSessao);

    expect(aviso).not.toHaveBeenCalled();
    expect(daSessao.rpcs.some((r) => r.nome === "fn_service_begin")).toBe(false);
    expect(doServico.rpcs.find((r) => r.nome === "fn_service_begin")?.args).toMatchObject({
      p_org: ORG,
      p_contact: CONTATO,
      p_session: "sessao-que-disca",
    });
  });

  it("o falso de sessão acima recusa a RPC porque o baseline não a concede a authenticated", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
    // A instrução inteira até o `;`: o `to` pode cair na linha de baixo.
    const grants = [
      ...baseline.matchAll(
        /grant\s+execute\s+on\s+function\s+public\.fn_service_begin\([^)]*\)\s+to\s+([^;]+);/gi,
      ),
    ].map((m) => m[1]);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.at(-1)).not.toMatch(/authenticated/i);
  });
});

describe("createContactHandler pela prospecção — o cadastro não abre a conversa", () => {
  // O defeito (#4341): a prospecção criava o contato pela porta `manual`, a conversa
  // nascia no telefone mais antigo da org, e a própria prospecção abria a
  // segunda no canal da campanha. Duas conversas por empresa abordada.
  it("porta prospeccao: nenhuma fn_service_begin e nenhuma leitura de sessão, e o contato é criado", async () => {
    const doServico = cliente({ sessoes: [SESSAO_QUE_DISCA] });
    const daSessao = cliente({ papel: "authenticated" });
    servico.db = doServico.db;

    const { contact, action } = await createContactHandler(
      daSessao.db,
      ctx(),
      { name: "Clínica", phone_number: TELEFONE } as never,
      undefined,
      { porta: "prospeccao" },
    );

    expect(action).toBe("created");
    expect(contact.id).toBe(CONTATO);
    expect(doServico.rpcs.some((r) => r.nome === "fn_service_begin")).toBe(false);
    expect(doServico.from).not.toHaveBeenCalledWith("channel_sessions");
    // O resto do cadastro segue igual: o evento do contato continua saindo.
    expect(daSessao.rpcs.some((r) => r.nome === "emit_event")).toBe(true);
  });

  it("controle: sem a opção, o mesmo cadastro abre a conversa (porta manual)", async () => {
    const doServico = cliente({ sessoes: [SESSAO_QUE_DISCA] });

    await criar(doServico);

    expect(doServico.rpcs.some((r) => r.nome === "fn_service_begin")).toBe(true);
  });
});
