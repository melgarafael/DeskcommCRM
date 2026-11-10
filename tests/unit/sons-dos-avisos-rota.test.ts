// @vitest-environment node
/**
 * A rota dos sons dos avisos (`app/api/v1/settings/sons`).
 *
 * Os modos de falha vigiados:
 *   - trocar o som exige `manager` (ouvir, qualquer membro);
 *   - o arquivo é aceito pelos BYTES, nunca pela extensão;
 *   - corpo declarado grande demais é recusado ANTES de bufferizar;
 *   - o caminho é gerado no servidor, sob a pasta da organização da SESSÃO;
 *   - gravar preserva o resto de `organizations.settings` — e uma LEITURA que
 *     falhou não pode virar `settings` vazio (o update apagaria toda a
 *     configuração da organização);
 *   - caminho gravado de OUTRA organização nunca é assinado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pedidoComTamanho } from "@/tests/helpers/pedido-com-tamanho";
import { NextRequest } from "next/server";

import { DELETE, GET, POST } from "@/app/api/v1/settings/sons/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "99999999-9999-4999-8999-999999999999";

interface Banco {
  settings: Record<string, unknown> | null;
  erroNaLeitura?: boolean;
  updates: Array<Record<string, unknown>>;
  subidos: string[];
  removidos: string[];
  assinados: string[];
}

function fakeAdmin(b: Banco) {
  return {
    from(tabela: string) {
      expect(tabela).toBe("organizations");
      const chain = {
        select: () => chain,
        eq: (coluna: string, valor: unknown) => {
          expect([coluna, valor]).toEqual(["id", ORG]);
          return chain;
        },
        maybeSingle: async () =>
          b.erroNaLeitura
            ? { data: null, error: { message: "timeout" } }
            : { data: { settings: b.settings }, error: null },
        update: (linha: Record<string, unknown>) => {
          b.updates.push(linha);
          return { eq: async () => ({ error: null }) };
        },
      };
      return chain;
    },
    storage: {
      from: () => ({
        upload: async (caminho: string) => {
          b.subidos.push(caminho);
          return { error: null };
        },
        remove: async (caminhos: string[]) => {
          b.removidos.push(...caminhos);
          return { error: null };
        },
        createSignedUrl: async (caminho: string) => {
          b.assinados.push(caminho);
          return { data: { signedUrl: `https://assinada/${caminho}` }, error: null };
        },
      }),
    },
  };
}

function banco(settings: Record<string, unknown> | null, extra: Partial<Banco> = {}): Banco {
  const b: Banco = { settings, updates: [], subidos: [], removidos: [], assinados: [], ...extra };
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin(b) as never);
  return b;
}

function sessao() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as never);
}

const WAV = new Uint8Array([...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("WAVE", (c) => c.charCodeAt(0)), ...Array(32).fill(0)]);

function upload(tipo: string, bytes: Uint8Array<ArrayBuffer>, nome = "som.mp3", headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("tipo", tipo);
  form.append("arquivo", new File([new Uint8Array(bytes)], nome));
  return pedidoComTamanho("http://localhost/api/v1/settings/sons", { method: "POST", body: form, headers });
}

beforeEach(() => {
  vi.mocked(requireRole).mockReset();
  sessao();
});

describe("POST /api/v1/settings/sons", () => {
  it("exige manager — e é a rota que diz, não a tela", async () => {
    banco({});
    await POST(await upload("venda", WAV));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
  });

  it("aceita pelos bytes: WAV com nome .mp3 entra como .wav, sob a pasta da organização", async () => {
    const b = banco({ outra_chave: 1, sons_de_aviso: { pessoa: `${ORG}/pessoa-x.ogg` } });
    const r = await POST(await upload("venda", WAV, "qualquer.mp3"));
    expect(r.status).toBe(201);
    expect(b.subidos).toHaveLength(1);
    expect(b.subidos[0]).toMatch(new RegExp(`^${ORG}/venda-[0-9a-f-]{36}\\.wav$`));
    // Merge não-destrutivo: o resto da configuração e o outro som sobrevivem.
    expect(b.updates[0]).toEqual({
      settings: { outra_chave: 1, sons_de_aviso: { pessoa: `${ORG}/pessoa-x.ogg`, venda: b.subidos[0] } },
    });
  });

  it("o som anterior sai DEPOIS de o novo estar gravado", async () => {
    const b = banco({ sons_de_aviso: { venda: `${ORG}/venda-velho.mp3` } });
    await POST(await upload("venda", WAV));
    expect(b.updates).toHaveLength(1);
    expect(b.removidos).toEqual([`${ORG}/venda-velho.mp3`]);
  });

  it("texto com extensão .mp3 é recusado (415) e nada sobe", async () => {
    const b = banco({});
    const texto = new TextEncoder().encode("isto não é áudio nenhum, só texto");
    const r = await POST(await upload("venda", texto, "som.mp3"));
    expect(r.status).toBe(415);
    expect(b.subidos).toHaveLength(0);
    expect(b.updates).toHaveLength(0);
  });

  it("tipo de aviso desconhecido é recusado (400)", async () => {
    const b = banco({});
    const r = await POST(await upload("qualquer", WAV));
    expect(r.status).toBe(400);
    expect(b.subidos).toHaveLength(0);
  });

  it("Content-Length declarado acima do teto é recusado (413) antes de ler o corpo", async () => {
    const b = banco({});
    const r = await POST(await upload("venda", WAV, "som.wav", { "content-length": String(5 * 1024 * 1024) }));
    expect(r.status).toBe(413);
    expect(b.subidos).toHaveLength(0);
  });

  it("leitura de settings que FALHOU não vira settings vazio: 500, nada sobe, nada é regravado", async () => {
    const b = banco({ outra_chave: 1 }, { erroNaLeitura: true });
    const r = await POST(await upload("venda", WAV));
    expect(r.status).toBe(500);
    expect(b.subidos).toHaveLength(0);
    expect(b.updates).toHaveLength(0);
  });
});

describe("DELETE /api/v1/settings/sons", () => {
  it("volta ao som do sistema: tira a chave, mantém o resto e apaga o arquivo", async () => {
    const b = banco({ outra_chave: 1, sons_de_aviso: { venda: `${ORG}/venda-a.mp3`, pessoa: `${ORG}/pessoa-b.mp3` } });
    const r = await DELETE(new NextRequest("http://localhost/api/v1/settings/sons?tipo=venda", { method: "DELETE" }));
    expect(r.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
    expect(b.updates[0]).toEqual({ settings: { outra_chave: 1, sons_de_aviso: { pessoa: `${ORG}/pessoa-b.mp3` } } });
    expect(b.removidos).toEqual([`${ORG}/venda-a.mp3`]);
  });

  it("leitura que falhou: 500 e nada é regravado", async () => {
    const b = banco({ outra_chave: 1 }, { erroNaLeitura: true });
    const r = await DELETE(new NextRequest("http://localhost/api/v1/settings/sons?tipo=venda", { method: "DELETE" }));
    expect(r.status).toBe(500);
    expect(b.updates).toHaveLength(0);
  });
});

describe("GET /api/v1/settings/sons", () => {
  it("qualquer membro ouve; caminho de OUTRA organização nunca é assinado", async () => {
    const b = banco({ sons_de_aviso: { venda: `${ORG}/venda-a.mp3`, pessoa: `${OUTRA}/pessoa-b.mp3` } });
    const r = await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("viewer");
    const corpo = (await r.json()) as { data: Record<string, string | null> };
    expect(corpo.data).toEqual({ venda: `https://assinada/${ORG}/venda-a.mp3`, pessoa: null });
    expect(b.assinados).toEqual([`${ORG}/venda-a.mp3`]);
  });
});
