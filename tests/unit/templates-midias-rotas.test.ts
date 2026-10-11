// @vitest-environment node
/**
 * As rotas das imagens da resposta rápida (#2526) — as guardas que protegem o
 * Storage, exercitadas pela ROTA e não só pela função pura.
 *
 * O Storage roda por service role, sem RLS: a única coisa entre um corpo
 * forjado e o arquivo de outra organização é a conferência de caminho. Cada
 * caso abaixo afirma o EFEITO no Storage (chamou ou não `remove`/`upload`/
 * `download`), não só o status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
  storage: {
    remove: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
  },
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.from }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => h.storage } }),
}));

import { DELETE, PATCH } from "@/app/api/v1/message-templates/[id]/route";
import { POST } from "@/app/api/v1/message-templates/[id]/midias/route";
import { GET } from "@/app/api/v1/message-templates/[id]/midias/[indice]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const TPL = "22222222-2222-4222-8222-222222222222";
const USER = "55555555-5555-4555-8555-555555555555";

const midia = (org: string, n: number) => ({
  storage_path: `${org}/templates/${TPL}/0a0b0c0d-0000-4000-8000-00000000000${n}.jpg`,
  media_mime: "image/jpeg",
  media_size_bytes: n,
});
const minha = (n: number) => midia(ORG, n);
const alheia = (n: number) => midia(OUTRA_ORG, n);

type Linha = Record<string, unknown>;

/** Uma linha de `message_templates`, com a cadeia que as rotas usam. */
function template(linha: Linha | null) {
  const estado = { linha, updates: [] as Linha[] };
  h.from.mockImplementation(() => {
    let op: "select" | "update" | "delete" = "select";
    let patch: Linha = {};
    const resolver = async () => {
      if (!estado.linha) return { data: null, error: null };
      if (op === "update") {
        estado.updates.push(patch);
        Object.assign(estado.linha, patch);
      }
      const data = { ...estado.linha };
      if (op === "delete") estado.linha = null;
      return { data, error: null };
    };
    const b = {
      select: () => b,
      eq: () => b,
      update: (v: Linha) => {
        op = "update";
        patch = v;
        return b;
      },
      delete: () => {
        op = "delete";
        return b;
      },
      maybeSingle: resolver,
      single: resolver,
    };
    return b;
  });
  return estado;
}

const params = { params: Promise.resolve({ id: TPL }) };
const json = (method: string, corpo?: unknown) =>
  new NextRequest(`http://localhost/api/v1/message-templates/${TPL}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
function multipart(bytes: number[]) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], "foto.jpg", { type: "image/jpeg" }));
  return new NextRequest(`http://localhost/api/v1/message-templates/${TPL}/midias`, {
    method: "POST",
    body: form,
  });
}
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];

function comoPapel(role: string) {
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt" }, org: { orgId: ORG, role } });
}

beforeEach(() => {
  vi.resetAllMocks();
  comoPapel("manager");
  h.apoio.mockResolvedValue(null);
  h.storage.remove.mockResolvedValue({ error: null });
  h.storage.upload.mockResolvedValue({ error: null });
  h.storage.download.mockResolvedValue({ data: new Blob([new Uint8Array(JPEG)]), error: null });
});

describe("PATCH /message-templates/:id — midias", () => {
  it("caminho de outro template/org no corpo: 422, sem update e sem apagar nada", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [minha(1), alheia(2)] });

    const r = await PATCH(json("PATCH", { midias: [alheia(2)] }), params);

    expect(r.status).toBe(422);
    expect(db.updates).toHaveLength(0);
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  it("remove pela lista e grava as entradas DA LINHA, não o mime do corpo", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [minha(1), minha(2)] });

    const r = await PATCH(json("PATCH", { midias: [{ ...minha(2), media_mime: "text/html" }] }), params);

    expect(r.status).toBe(200);
    expect(db.updates[0]!.midias).toEqual([minha(2)]);
    expect(h.storage.remove).toHaveBeenCalledWith([minha(1).storage_path]);
  });
});

describe("DELETE /message-templates/:id", () => {
  it("apaga do bucket só o que é deste template", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [minha(1), alheia(2)] });

    const r = await DELETE(json("DELETE"), params);

    expect(r.status).toBe(204);
    expect(h.storage.remove).toHaveBeenCalledTimes(1);
    expect(h.storage.remove).toHaveBeenCalledWith([minha(1).storage_path]);
  });
});

describe("POST /message-templates/:id/midias", () => {
  it("bytes que não são JPEG/PNG: 415, nada sobe (o content-type declarado não decide)", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [] });

    const r = await POST(multipart([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]), params);

    expect(r.status).toBe(415);
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("agent em template compartilhado: 403, nada sobe", async () => {
    comoPapel("agent");
    template({ id: TPL, owner_user_id: null, midias: [] });

    const r = await POST(multipart(JPEG), params);

    expect(r.status).toBe(403);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it("6ª imagem: 422, nada sobe", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [1, 2, 3, 4, 5].map(minha) });

    const r = await POST(multipart(JPEG), params);

    expect(r.status).toBe(422);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it("JPEG válido: o caminho é gerado no prefixo do template e entra na linha", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [minha(1)] });

    const r = await POST(multipart(JPEG), params);

    expect(r.status).toBe(200);
    const caminho = h.storage.upload.mock.calls[0]![0] as string;
    expect(caminho.startsWith(`${ORG}/templates/${TPL}/`)).toBe(true);
    expect((db.updates[0]!.midias as { storage_path: string }[]).map((m) => m.storage_path)).toEqual([
      minha(1).storage_path,
      caminho,
    ]);
  });
});

describe("GET /message-templates/:id/midias/:indice", () => {
  const get = (indice: string) =>
    GET(new NextRequest(`http://localhost/api/v1/message-templates/${TPL}/midias/${indice}`), {
      params: Promise.resolve({ id: TPL, indice }),
    });

  it("caminho alheio gravado na linha: 404, sem baixar", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [alheia(1)] });

    const r = await get("0");

    expect(r.status).toBe(404);
    expect(h.storage.download).not.toHaveBeenCalled();
  });

  it("caminho deste template: devolve os bytes", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [minha(1)] });

    const r = await get("0");

    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/jpeg");
    expect(h.storage.download).toHaveBeenCalledWith(minha(1).storage_path);
  });
});
