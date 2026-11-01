/**
 * A PORTA DE INSCRIÇÃO NO FOLLOW-UP — e o escopo de posse do Atendente (#3746).
 *
 * A issue mediu o botão "Iniciar follow-up" no painel da conversa travado em
 * `manager`+: `requireRole("manager")` no POST de `enrollments` e um
 * `roleAtLeast(..., "manager")` na tela. O Atendente é quem está na conversa e
 * quem ouve "me lembra na semana que vem" — e ele não podia inscrever ninguém.
 *
 * O que este arquivo prende, e é o recorte fechado da issue (opção 1):
 *
 *   1. `agent` cuja CONVERSA do payload está atribuída a ele → 201, e a
 *      inscrição sai pelo caminho de sempre (`enrollFollowupFlow`);
 *   2. `agent` que NÃO é dono → 403 `fora_da_posse`, e NADA é inscrito;
 *   3. `manager` → 201 sem posse nenhuma (anti-regressão do que já funcionava);
 *   4. o GET com `?contact_id=` responde `meta.pode_inscrever` com a MESMA
 *      régua — é o que a seção do painel lê para oferecer o botão, em vez de
 *      comparar papel no componente.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enroll: vi.fn(),
  /** `createAdminClient().from(...)` — a régua de posse lê contato e conversa. */
  adminFrom: vi.fn(),
  /** `createClient().from(...)` — o GET lista os enrollments. */
  lista: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (tabela: string) => mocks.adminFrom(tabela) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => mocks.lista() }),
}));
vi.mock("@/lib/followup/enroll", () => ({
  ENROLLMENT_LIST_COLUMNS: "id, pointer_id, contact_id, status, started_at, updated_at",
  enrollFollowupFlow: mocks.enroll,
}));

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const CONVERSA = "c0000000-0000-4000-8000-0000000000c1";
const FLUXO = "f0000000-0000-4000-8000-0000000000aa";
const ATENDENTE = "33333333-3333-4333-8333-333333333333";
const OUTRO = "44444444-4444-4444-8444-444444444444";

/** A carteira do contato, como a régua a lê (`contacts.carteira_user_id`). */
function contatoDoAdmin(carteira: string | null = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { carteira_user_id: carteira }, error: null }),
  };
  return chain;
}

/** As conversas do contato — a régua lê a fila como lista. */
function conversasFalsas(linhas: Array<Record<string, unknown>> = []) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(ok, err);
  return chain;
}

/** A lista do GET: encadeia `.eq`/`.order` e resolve como o PostgREST resolve. */
function listaDe(linhas: Array<Record<string, unknown>> = []) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(ok, err);
  return chain;
}

function inscricao(corpo: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/v1/ai/followups/enrollments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pointer_id: FLUXO, contact_id: CONTATO, conversation_id: CONVERSA, ...corpo }),
  });
}

function listagem(contactId: string) {
  return new NextRequest(
    `http://localhost/api/v1/ai/followups/enrollments?contact_id=${encodeURIComponent(contactId)}`,
    { method: "GET" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminFrom.mockImplementation((tabela: string) =>
    tabela === "contacts" ? contatoDoAdmin() : conversasFalsas(),
  );
  mocks.lista.mockReturnValue(listaDe());
  mocks.enroll.mockResolvedValue({ ok: true, enrollment: { id: "e-1", contact_id: CONTATO } });
  mocks.auth.mockResolvedValue({
    ok: true,
    user: { id: ATENDENTE, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "agent" },
  });
});

describe("#3746 — o Atendente inscreve o cliente que ele atende", () => {
  it("⭐ `agent` dono da conversa do payload inscreve: 201 e a inscrição acontece", async () => {
    mocks.adminFrom.mockImplementation((tabela: string) =>
      tabela === "contacts"
        ? contatoDoAdmin()
        : conversasFalsas([{ id: CONVERSA, assigned_to_user_id: ATENDENTE }]),
    );

    const resposta = await POST(inscricao());

    expect(resposta.status).toBe(201);
    expect(mocks.enroll).toHaveBeenCalledTimes(1);
    expect(mocks.enroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, contactId: CONTATO, pointerId: FLUXO, actorUserId: ATENDENTE }),
    );
  });

  it("`agent` com o CONTATO na carteira dele também inscreve, mesmo sem a conversa", async () => {
    // A conversa existe e é de OUTRA pessoa: a posse vem da carteira, e o OR da
    // regra não pede as duas.
    mocks.adminFrom.mockImplementation((tabela: string) =>
      tabela === "contacts"
        ? contatoDoAdmin(ATENDENTE)
        : conversasFalsas([{ id: CONVERSA, assigned_to_user_id: OUTRO }]),
    );

    const resposta = await POST(inscricao());

    expect(resposta.status).toBe(201);
    expect(mocks.enroll).toHaveBeenCalledTimes(1);
  });

  it("⭐ `agent` que NÃO é dono leva 403 `fora_da_posse` e nada é inscrito", async () => {
    mocks.adminFrom.mockImplementation((tabela: string) =>
      tabela === "contacts"
        ? contatoDoAdmin(OUTRO)
        : conversasFalsas([{ id: CONVERSA, assigned_to_user_id: OUTRO }]),
    );

    const resposta = await POST(inscricao());

    expect(resposta.status).toBe(403);
    expect(((await resposta.json()) as { error: { code: string } }).error.code).toBe("fora_da_posse");
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it("a conversa do payload é o escopo: conversa de OUTRO contato é 404, não 403", async () => {
    // A régua conferiu a conversa pedida e ela não é deste contato — é um id
    // errado no payload, e dizer "não é seu" mandaria o suporte caçar permissão.
    mocks.adminFrom.mockImplementation((tabela: string) =>
      tabela === "contacts" ? contatoDoAdmin() : conversasFalsas([]),
    );

    const resposta = await POST(inscricao());

    expect(resposta.status).toBe(404);
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it("CONTROLE: `manager` inscreve sem posse nenhuma (anti-regressão)", async () => {
    mocks.auth.mockResolvedValue({
      ok: true,
      user: { id: OUTRO, idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "manager" },
    });

    const resposta = await POST(inscricao());

    expect(resposta.status).toBe(201);
    expect(mocks.enroll).toHaveBeenCalledTimes(1);
  });
});

describe("#3746 — o painel lê a capacidade do servidor (`meta.pode_inscrever`)", () => {
  it("`agent` dono do cliente recebe `pode_inscrever: true`", async () => {
    mocks.adminFrom.mockImplementation((tabela: string) =>
      tabela === "contacts"
        ? contatoDoAdmin(ATENDENTE)
        : conversasFalsas([{ id: CONVERSA, assigned_to_user_id: ATENDENTE }]),
    );

    const resposta = await GET(listagem(CONTATO));

    expect(resposta.status).toBe(200);
    expect((await resposta.json()) as { meta?: { pode_inscrever?: boolean } }).toMatchObject({
      meta: { pode_inscrever: true },
    });
  });

  it("`agent` de fora do cliente recebe `pode_inscrever: false` (o botão não aparece)", async () => {
    mocks.adminFrom.mockImplementation((tabela: string) =>
      tabela === "contacts"
        ? contatoDoAdmin(OUTRO)
        : conversasFalsas([{ id: CONVERSA, assigned_to_user_id: OUTRO }]),
    );

    const resposta = await GET(listagem(CONTATO));

    expect((await resposta.json()) as { meta?: { pode_inscrever?: boolean } }).toMatchObject({
      meta: { pode_inscrever: false },
    });
  });
});
