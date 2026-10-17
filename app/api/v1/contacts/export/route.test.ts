/**
 * GET /api/v1/contacts/export — o arquivo sai com o envelope do export que já
 * existe, os filtros da tela e a trilha de auditoria.
 *
 * O handler da lista (`../_handler`) é o MESMO da tela e já tem teste dele;
 * aqui ele é dublê de propósito: o que se mede é o que a rota faz em volta —
 * paginação até o teto, formato, papel, CPF decifrado e `contacts.exported`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/lib/types/contacts";

import { listContactsHandler } from "../_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("../_handler", () => ({ listContactsHandler: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const URL_BASE = "http://localhost/api/v1/contacts/export";
const TAMANHO_DA_PAGINA = 100;
const TETO_DO_EXPORT = 10_000;

function usuario(): AuthUser {
  return {
    id: USER_ID,
    email: "gerente@exemplo.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as AuthUser;
}

function contato(i: number, parcial: Partial<Contact> = {}): Contact {
  const n = String(i).padStart(6, "0");
  return {
    id: `00000000-0000-4000-8000-${n}`,
    organization_id: ORG_ID,
    name: `Contato ${n}`,
    display_name: null,
    email: `c${n}@exemplo.com`,
    email_normalized: `c${n}@exemplo.com`,
    phone_number: `+55119${n}`,
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    is_personal: false,
    blocked_reason: null,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    ...parcial,
  } as Contact;
}

/**
 * O handler devolve páginas de `limit` como a lista real devolve; o cursor é o
 * índice da próxima página, do mesmo jeito que a rota de lista devolve.
 */
function devolvePaginas(contatos: Contact[]): void {
  vi.mocked(listContactsHandler).mockImplementation(async (_sb, _ctx, raw) => {
    const cursor = (raw as { cursor?: string }).cursor;
    const inicio = cursor ? Number(cursor) : 0;
    const limite = Number((raw as { limit?: number }).limit) || TAMANHO_DA_PAGINA;
    const fatia = contatos.slice(inicio, inicio + limite);
    const proximo = inicio + fatia.length;
    const has_more = proximo < contatos.length;
    return {
      contacts: fatia,
      cursor: has_more ? String(proximo) : null,
      has_more,
    };
  });
}

const RPC = vi.fn();

async function chamar(query = ""): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest(`${URL_BASE}${query}`));
}

/** Linhas de DADOS do CSV (fora o cabeçalho e o BOM). */
function dadosDoCsv(csv: string): string[] {
  return csv.replace(/^\uFEFF/, "").trimEnd().split("\n").slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(),
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
  RPC.mockResolvedValue({ data: null, error: null });
  vi.mocked(createClient).mockResolvedValue({ rpc: RPC } as never);
});

describe("o CSV de contatos", () => {
  it("⭐ sai com o envelope do export que já existe: Content-Type próprio + attachment datado", async () => {
    devolvePaginas([contato(1), contato(2)]);

    const res = await chamar();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="contatos-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();

    const bytes = new Uint8Array(await res.arrayBuffer());
    // O BOM são os TRÊS primeiros bytes do arquivo — `res.text()` o come
    // (o `TextDecoder` remove BOM), então quem prova é o binário, como o
    // navegador de download enxerga.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const linhas = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").split("\n");
    expect(linhas[0]).toBe("name,display_name,email,phone_number,cpf,tags");
    expect(linhas).toHaveLength(4); // cabeçalho + 2 dados + quebra final
    expect(linhas[1]).toContain("Contato 000001");
  });

  it("⭐ pagina em blocos de 100 até o fim — a lista inteira, não a primeira página", async () => {
    devolvePaginas(Array.from({ length: 250 }, (_, k) => contato(k + 1)));

    const csv = await (await chamar()).text();

    expect(dadosDoCsv(csv)).toHaveLength(250);
    expect(listContactsHandler).toHaveBeenCalledTimes(3);
    const chamadas = vi.mocked(listContactsHandler).mock.calls;
    expect(chamadas.map(([, , raw]) => (raw as { limit: number }).limit)).toEqual([100, 100, 100]);
    // O cursor da página anterior é o ponto de partida da próxima.
    expect((chamadas[1]![2] as { cursor?: string }).cursor).toBe("100");
    expect((chamadas[2]![2] as { cursor?: string }).cursor).toBe("200");
    // Sem cursor na primeira chamada — é a página que a tela abre.
    expect((chamadas[0]![2] as { cursor?: string }).cursor).toBeUndefined();
  });

  it("para no teto de 10.000 e avisa que o arquivo foi cortado", async () => {
    devolvePaginas(Array.from({ length: 15_000 }, (_, k) => contato(k + 1)));

    const res = await chamar();
    const csv = await res.text();

    expect(dadosDoCsv(csv)).toHaveLength(TETO_DO_EXPORT);
    expect(res.headers.get("X-Export-Truncado")).toBe("true");
    expect(listContactsHandler).toHaveBeenCalledTimes(100);
    const auditChamado = vi.mocked(audit).mock.calls[0]![0];
    expect(auditChamado.metadata).toMatchObject({ total: TETO_DO_EXPORT, truncado: true });
  });

  it("os filtros da tela viajam inteiros para o mesmo handler da lista", async () => {
    devolvePaginas([contato(1)]);

    await chamar(
      "?formato=csv&search=maria%20silva&tag=vip&tag=or%C3%A7amento&modo=ou&source=whatsapp&pessoais=true&order_by=display_name&order_dir=asc",
    );

    const [, ctx, raw] = vi.mocked(listContactsHandler).mock.calls[0]!;
    expect(ctx).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "user", id: USER_ID },
    });
    expect(raw).toMatchObject({
      search: "maria silva",
      tag: ["vip", "orçamento"],
      modo: "ou",
      source: "whatsapp",
      pessoais: true,
      order_by: "display_name",
      order_dir: "asc",
      limit: TAMANHO_DA_PAGINA,
    });
  });

  it("decifra o CPF de quem tem cifra — e só dele", async () => {
    devolvePaginas([
      contato(1, { cpf_hash: "hash-1" }),
      contato(2),
      contato(3, { cpf_hash: "hash-3" }),
    ]);
    RPC.mockImplementation(async (_funcao: string, { p_contact_id }: { p_contact_id: string }) => ({
      data: p_contact_id.endsWith("000001") ? "52998224725" : "39053344705",
      error: null,
    }));

    const csv = await (await chamar()).text();

    expect(RPC).toHaveBeenCalledTimes(2);
    const decifrados = RPC.mock.calls.map(([, params]) => (params as { p_contact_id: string }).p_contact_id);
    expect(decifrados).not.toContain("00000000-0000-4000-8000-000002");
    expect(decifrados).toContain("00000000-0000-4000-8000-000001");
    expect(csv).toContain("52998224725");
    expect(csv).toContain("39053344705");
  });

  it("o vCard NÃO decifra CPF — cartão não tem documento", async () => {
    devolvePaginas([contato(1, { cpf_hash: "hash-1" })]);

    await chamar("?formato=vcf");

    expect(RPC).not.toHaveBeenCalled();
  });
});

describe("o vCard", () => {
  it("⭐ sai como text/vcard com nome .vcf e um cartão por contato", async () => {
    devolvePaginas([
      contato(1, { name: "Maria Silva", phone_number: "+5511999998888" }),
      contato(2, { name: "João Comércio", phone_number: "+5521988887777" }),
    ]);

    const res = await chamar("?formato=vcf");
    const corpo = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/vcard; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="contatos-${new Date().toISOString().slice(0, 10)}.vcf"`,
    );
    expect(corpo.match(/BEGIN:VCARD/g)).toHaveLength(2);
    expect(corpo).toContain("FN:Maria Silva");
    expect(corpo).toContain("TEL;TYPE=CELL,VOICE:+5511999998888");
    expect(res.headers.get("X-Export-Truncado")).toBeNull();
  });
});

describe("bordas", () => {
  it("formato desconhecido é 422 com a frase que ensina o certo", async () => {
    const res = await chamar("?formato=xlsx");

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message).toContain("?formato=csv");
    expect(listContactsHandler).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("papel abaixo de manager não lê uma linha sequer", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: { code: "forbidden_role", message: "Papel insuficiente." } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    } as never);

    const res = await chamar();

    expect(res.status).toBe(403);
    expect(listContactsHandler).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("o papel vem da membership: nenhuma opção além de requestId e resource", async () => {
    devolvePaginas([contato(1)]);

    await chamar();

    const [papel, opcoes] = vi.mocked(requireRole).mock.calls[0]!;
    expect(papel).toBe("manager");
    expect(Object.keys(opcoes ?? {}).sort()).toEqual(["requestId", "resource"]);
  });
});

describe("a trilha de auditoria", () => {
  it("⭐ registra quem, quando e QUANTOS — nunca o texto da busca", async () => {
    devolvePaginas(Array.from({ length: 3 }, (_, k) => contato(k + 1)));

    await chamar("?search=maria%20silva&tag=vip&source=whatsapp");

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "contacts.exported",
      actorUserId: USER_ID,
      organizationId: ORG_ID,
      resourceType: "contact",
      metadata: {
        formato: "csv",
        total: 3,
        truncado: false,
        filtros: { busca: true, etiquetas: 1, origem: "whatsapp", pessoais: false },
      },
    });
    // O termo buscado é dado de quem foi buscado: sai do audit como FILTRO,
    // nunca como texto (mesma régua do export de conversa em PDF).
    expect(JSON.stringify(entrada.metadata)).not.toContain("maria");
  });

  it("sem filtro nenhum também audita — exportar a base toda é exportar", async () => {
    devolvePaginas([contato(1)]);

    await chamar();

    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada.metadata).toMatchObject({
      total: 1,
      filtros: { busca: false, etiquetas: 0, origem: null, pessoais: false },
    });
  });
});
