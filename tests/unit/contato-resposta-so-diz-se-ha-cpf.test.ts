/**
 * AS RESPOSTAS DA API DE CONTATOS DIZEM SÓ SE HÁ CPF.
 *
 * `cpf_hash` é coluna interna: serve à trava de único e à busca exata. O que sai
 * para quem chama a API é o sinal `cpf_available`. Atravessa as ROTAS com os
 * handlers reais; o cliente falso respeita a lista de colunas pedida, então o
 * sinal só fica certo se o handler de fato ler a coluna.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCpf } from "@/lib/contacts/cpf";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import type * as PerfilDoPais from "@/lib/legal/perfil-do-pais";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/contacts/conversa-ao-criar", () => ({
  abrirConversaDoContatoNovo: vi.fn(async () => ({ aberta: false })),
}));
vi.mock("@/lib/legal/perfil-do-pais", async () => {
  const real = await vi.importActual<typeof PerfilDoPais>("@/lib/legal/perfil-do-pais");
  return { ...real, perfilDaOrganizacao: vi.fn(async () => real.perfilDoPais("BR")) };
});

const ORG = "c9f00000-0000-4000-8000-000000000001";
const USUARIO = "c9f00000-0000-4000-8000-0000000000a1";
const COM_CPF = "c9f00000-0000-4000-8000-0000000000c1";
const SEM_CPF = "c9f00000-0000-4000-8000-0000000000c2";
const CPF = "52998224725";
const HASH = hashCpf(CPF);

const estado = vi.hoisted(() => ({
  papel: "viewer" as string,
  buscas: [] as string[],
  decifrou: 0,
}));

function linha(id: string, hash: string | null): Record<string, unknown> {
  return {
    id,
    organization_id: ORG,
    name: "Ana",
    phone_number: null,
    email: null,
    cpf_hash: hash,
    is_anonymized: false,
    tags: [],
    source: "manual",
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
  };
}

const CONTATOS = [linha(COM_CPF, HASH), linha(SEM_CPF, null)];

/** Só as colunas pedidas, como o banco devolveria; `*` devolve a linha inteira. */
function projetar(linhaCheia: Record<string, unknown>, colunas: string): Record<string, unknown> {
  if (colunas === "*") return linhaCheia;
  const nomes = colunas.split(",").map((c) => c.trim());
  return Object.fromEntries(Object.entries(linhaCheia).filter(([k]) => nomes.includes(k)));
}

function cadeia(tabela: string): unknown {
  let colunas = "*";
  let alvo: Record<string, unknown> = CONTATOS[0] as Record<string, unknown>;
  const umaLinha = () => {
    if (tabela === "user_organizations") return { role: estado.papel };
    return tabela === "contacts" ? projetar(alvo, colunas) : null;
  };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_alvo, metodo) {
        if (metodo === "select") {
          return (c?: string) => {
            colunas = c ?? "*";
            return proxy;
          };
        }
        if (metodo === "eq") {
          return (coluna: string, valor: unknown) => {
            if (coluna === "id") {
              alvo = CONTATOS.find((c) => c.id === valor) ?? alvo;
            }
            return proxy;
          };
        }
        if (metodo === "or") {
          return (filtro: string) => {
            estado.buscas.push(filtro);
            return proxy;
          };
        }
        if (metodo === "single" || metodo === "maybeSingle") {
          return async () => ({ data: umaLinha(), error: null });
        }
        if (metodo === "then") {
          const lista = tabela === "contacts" ? CONTATOS.map((c) => projetar(c, colunas)) : [];
          return (resolver: (v: unknown) => unknown) => resolver({ data: lista, error: null });
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

const clienteFalso = {
  auth: { getUser: async () => ({ data: { user: { id: USUARIO } }, error: null }) },
  from: cadeia,
  rpc: async (funcao: string) => {
    if (funcao === "decrypt_cpf") estado.decifrou += 1;
    return {
      data: funcao === "encrypt_cpf" ? new Uint8Array([1]) : funcao === "decrypt_cpf" ? CPF : null,
      error: null,
    };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => clienteFalso) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => clienteFalso) }));

function usuario() {
  return { id: USUARIO, idioma: "pt-BR" as const };
}
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => usuario()) }));
vi.mock("@/lib/auth/require-role", () => ({
  // A régua de verdade sobre o papel da vez: o `min` é o que a ROTA declara.
  requireRole: vi.fn(async (min: Role) =>
    roleAtLeast(estado.papel, min)
      ? {
          ok: true,
          user: usuario(),
          org: { orgId: ORG, name: "Org", role: estado.papel },
        }
      : { ok: false, response: new Response(null, { status: 403 }) },
  ),
  orgAtivaDaApi: vi.fn(async () => ({
    ok: true,
    org: { orgId: ORG, name: "Org", role: estado.papel },
  })),
}));

const BASE = "https://crm.exemplo/api/v1/contacts";

async function listar(busca = ""): Promise<Response> {
  const { GET } = await import("@/app/api/v1/contacts/route");
  return GET(new NextRequest(`${BASE}${busca}`));
}

async function detalhar(id: string, cabecalhos: Record<string, string> = {}): Promise<Response> {
  const { GET } = await import("@/app/api/v1/contacts/[id]/route");
  return GET(new NextRequest(`${BASE}/${id}`, { headers: cabecalhos }), {
    params: Promise.resolve({ id }),
  });
}

async function criar(): Promise<Response> {
  const { POST } = await import("@/app/api/v1/contacts/route");
  return POST(
    new NextRequest(BASE, {
      method: "POST",
      body: JSON.stringify({ name: "Ana", cpf: CPF }),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function editar(): Promise<Response> {
  const { PATCH } = await import("@/app/api/v1/contacts/[id]/route");
  return PATCH(
    new NextRequest(`${BASE}/${COM_CPF}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Ana Maria" }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: COM_CPF }) },
  );
}

/** O corpo inteiro como texto: o valor não pode aparecer em chave nenhuma. */
async function corpoSemOValor(res: Response): Promise<{ data: Record<string, unknown> }> {
  const texto = await res.text();
  expect(texto).not.toContain(HASH);
  expect(texto).not.toContain("cpf_hash");
  return JSON.parse(texto);
}

beforeEach(() => {
  estado.papel = "viewer";
  estado.buscas.length = 0;
  estado.decifrou = 0;
});

describe.each(["viewer", "agent"])("leitura com o papel %s", (papel) => {
  beforeEach(() => {
    estado.papel = papel;
  });

  it("a lista diz quem tem CPF, e só isso", async () => {
    const res = await listar();
    expect(res.status).toBe(200);
    const { data } = await corpoSemOValor(res);
    const fichas = data as unknown as Array<{ id: string; cpf_available: boolean }>;
    expect(fichas.map((f) => [f.id, f.cpf_available])).toEqual([
      [COM_CPF, true],
      [SEM_CPF, false],
    ]);
  });

  it("o detalhe diz se há CPF, e só isso", async () => {
    const res = await detalhar(COM_CPF);
    expect(res.status).toBe(200);
    const { data } = await corpoSemOValor(res);
    expect(data.cpf_available).toBe(true);
    expect(data.cpf_decrypted).toBeNull();

    const semCpf = await corpoSemOValor(await detalhar(SEM_CPF));
    expect(semCpf.data.cpf_available).toBe(false);
  });

  it("pedir o CPF decifrado segue recusado abaixo de manager", async () => {
    const res = await detalhar(COM_CPF, { "x-decrypt-purpose": "conferir" });
    const { data } = await corpoSemOValor(res);
    expect(data.cpf_decrypted).toBeNull();
    expect(data.cpf_decrypt_denied).toBe(true);
    expect(estado.decifrou).toBe(0);
  });
});

describe("escrita", () => {
  beforeEach(() => {
    estado.papel = "agent";
  });

  it("a criação 201 diz que há CPF, sem o valor", async () => {
    const res = await criar();
    expect(res.status).toBe(201);
    const { data } = await corpoSemOValor(res);
    const { contact } = data as unknown as { contact: { cpf_available: boolean } };
    expect(contact.cpf_available).toBe(true);
  });

  it("a edição 200 diz que há CPF, sem o valor", async () => {
    const res = await editar();
    expect(res.status).toBe(200);
    const { data } = await corpoSemOValor(res);
    expect(data.cpf_available).toBe(true);
  });

  it("controle: a régua do papel está viva — viewer não cria", async () => {
    estado.papel = "viewer";
    expect((await criar()).status).toBe(403);
  });
});

describe("o que é interno segue funcionando", () => {
  it("manager decifra com finalidade declarada", async () => {
    estado.papel = "manager";
    const { data } = await corpoSemOValor(
      await detalhar(COM_CPF, { "x-decrypt-purpose": "conferir" }),
    );
    expect(data.cpf_decrypted).toBe(CPF);
    expect(estado.decifrou).toBe(1);
  });

  it("buscar pelo CPF ainda filtra pela coluna", async () => {
    await listar(`?search=${CPF}`);
    expect(estado.buscas.join(",")).toContain(`cpf_hash.eq.${HASH}`);
  });
});
