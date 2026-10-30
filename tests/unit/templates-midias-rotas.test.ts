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
import { isDeepStrictEqual } from "node:util";
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
  objetos: new Map<string, Uint8Array>(),
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
  const estado = { linha, updates: [] as Linha[], antesDeGravar: null as (() => void) | null,
    erroDeGravacao: null as { message: string } | null,
    perderConfirmacao: null as "rejeicao" | "erro" | null };
  h.from.mockImplementation(() => {
    let op: "select" | "update" | "delete" = "select";
    let patch: Linha = {};
    const filtros = new Map<string, unknown>();
    const resolver = async () => {
      if (op === "update" && estado.antesDeGravar) {
        const concorrente = estado.antesDeGravar;
        estado.antesDeGravar = null;
        concorrente();
      }
      if (!estado.linha) return { data: null, error: null, count: 0 };
      if (op === "update" && estado.erroDeGravacao) return { data: null, error: estado.erroDeGravacao, count: null };
      if (filtros.has("midias")) {
        const esperado = JSON.parse(String(filtros.get("midias")));
        if (!isDeepStrictEqual(estado.linha.midias, esperado)) return { data: null, error: null, count: 0 };
      }
      if (op === "update") {
        estado.updates.push(patch);
        Object.assign(estado.linha, patch);
        if (estado.perderConfirmacao === "rejeicao") throw new Error("resposta perdida depois do commit");
        if (estado.perderConfirmacao === "erro") return { data: null, error: { message: "fetch_failed" }, count: null };
      }
      const data = { ...estado.linha };
      if (op === "delete") estado.linha = null;
      return { data, error: null, count: 1 };
    };
    const b = {
      select: () => b,
      eq: (coluna: string, valor: unknown) => {
        filtros.set(coluna, valor);
        return b;
      },
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
function multipart(bytes: number[], campos: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], "foto.jpg", { type: "image/jpeg" }));
  for (const [nome, valor] of Object.entries(campos)) form.append(nome, valor);
  return new NextRequest(`http://localhost/api/v1/message-templates/${TPL}/midias`, {
    method: "POST",
    body: form,
  });
}
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const OGG = [0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0];
const audio = (n: number) => ({ ...minha(n),
  storage_path: minha(n).storage_path.replace(".jpg", ".ogg"), media_mime: "audio/ogg" });

function comoPapel(role: string) {
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt" }, org: { orgId: ORG, role } });
}

beforeEach(() => {
  vi.resetAllMocks();
  comoPapel("manager");
  h.apoio.mockResolvedValue(null);
  h.storage.remove.mockResolvedValue({ error: null });
  h.objetos.clear();
  h.storage.remove.mockImplementation(async (caminhos: string[]) => {
    caminhos.forEach((caminho) => h.objetos.delete(caminho));
    return { error: null };
  });
  h.storage.upload.mockImplementation(async (caminho: string, bytes: Uint8Array) => {
    h.objetos.set(caminho, new Uint8Array(bytes));
    return { error: null };
  });
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

  it.each([
    ["outra organização", alheia(2)],
    ["outro template próprio", { ...minha(2), storage_path: minha(2).storage_path.replace(TPL, USER) }],
  ])("repara referência de %s sem apagar seus bytes", async (_nome, externa) => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [minha(1), externa] });
    h.objetos.set(minha(1).storage_path, new Uint8Array(JPEG));
    h.objetos.set(externa.storage_path, new Uint8Array(OGG));
    const r = await PATCH(json("PATCH", { midias: [] }), params);
    expect(r.status).toBe(200);
    expect(db.linha!.midias).toEqual([]);
    expect(h.storage.remove).toHaveBeenCalledExactlyOnceWith([minha(1).storage_path]);
    expect(h.objetos.has(minha(1).storage_path)).toBe(false);
    expect(h.objetos.get(externa.storage_path)).toEqual(new Uint8Array(OGG));
  });

  it.each([null, {}, { storage_path: 7 }, "arquivo", ["arquivo"]].map((entrada) => ({ entrada })))(
    "entrada JSONB malformada é recusada antes de efeito ($entrada)", async ({ entrada }) => {
      const db = template({ id: TPL, owner_user_id: USER, midias: [entrada] });
      const r = await PATCH(json("PATCH", { midias: [] }), params);
      expect(r.status).toBe(409);
      expect(db.updates).toHaveLength(0);
      expect(h.storage.remove).not.toHaveBeenCalled();
    },
  );
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

describe("troca de áudio e concorrência da lista inteira", () => {
  it("substitui a entrada de áudio no teto5 e só limpa o antigo após gravar", async () => {
    const atuais = [...[1, 2, 3, 4].map(minha), audio(5)];
    const db = template({ id: TPL, owner_user_id: USER, midias: atuais });
    h.storage.remove.mockImplementation(async (caminhos) => {
      expect(db.updates).toHaveLength(1);
      expect((db.linha!.midias as Linha[]).some((m) => m.storage_path === audio(5).storage_path)).toBe(false);
      expect(caminhos).toEqual([audio(5).storage_path]);
      return { error: null };
    });

    const r = await POST(multipart(OGG, {
      substituir_audio: audio(5).storage_path, midias_esperadas: JSON.stringify(atuais),
    }), params);

    expect(r.status).toBe(200);
    const caminho = h.storage.upload.mock.calls[0]![0] as string;
    expect(db.linha!.midias).toEqual([...atuais.slice(0, 4), {
      storage_path: caminho, media_mime: "audio/ogg", media_size_bytes: OGG.length,
    }]);
    expect(h.storage.remove).toHaveBeenCalledTimes(1);
  });

  it("upload recusado deixa a referência antiga sem remover objeto", async () => {
    const atuais = [audio(1)];
    const db = template({ id: TPL, owner_user_id: USER, midias: atuais });
    h.storage.upload.mockResolvedValue({ error: { message: "falha sintética" } });
    const r = await POST(multipart(OGG, { substituir_audio: audio(1).storage_path }), params);
    expect(r.status).toBe(500);
    expect(db.linha!.midias).toEqual(atuais);
    expect(db.updates).toHaveLength(0);
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  const substituicoesInvalidas: Array<[string, string, number[]]> = [
    ["entrada ausente", audio(2).storage_path, OGG],
    ["prefixo alheio mesmo presente na linha", alheia(2).storage_path, OGG],
    ["imagem não substitui o áudio", audio(1).storage_path, JPEG],
  ];
  it.each(substituicoesInvalidas)("recusa %s antes de upload", async (_nome, referencia, bytes) => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [audio(1), alheia(2)] });
    const r = await POST(multipart(bytes, { substituir_audio: referencia }), params);
    expect([409, 422]).toContain(r.status);
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(h.storage.remove).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("snapshot esperado antigo recusa a remoção de um áudio que já mudou", async () => {
    const atuais = [minha(1), audio(3)];
    const db = template({ id: TPL, owner_user_id: USER, midias: atuais });
    const r = await PATCH(json("PATCH", {
      midias: [minha(1)], midias_esperadas: [minha(1), audio(2)],
    }), params);
    expect(r.status).toBe(409);
    expect(db.linha!.midias).toEqual(atuais);
    expect(db.updates).toHaveLength(0);
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  it("PATCH sem snapshot legado também não restaura lista lida antes de uma troca concorrente", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [minha(1), audio(2)] });
    const concorrentes = [minha(1), audio(3)];
    db.antesDeGravar = () => { db.linha!.midias = concorrentes; };
    const r = await PATCH(json("PATCH", { midias: [audio(2)] }), params);
    expect(r.status).toBe(409);
    expect(db.linha!.midias).toEqual(concorrentes);
    expect(db.updates).toHaveLength(0);
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  it("upload legado não sobrescreve troca concorrente e limpa só o upload próprio", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [audio(1)] });
    const concorrentes = [audio(2)];
    db.antesDeGravar = () => { db.linha!.midias = concorrentes; };
    const r = await POST(multipart(OGG), params);
    expect(r.status).toBe(409);
    expect(db.linha!.midias).toEqual(concorrentes);
    expect(db.updates).toHaveLength(0);
    const proprio = h.storage.upload.mock.calls[0]![0];
    expect(h.storage.remove).toHaveBeenCalledExactlyOnceWith([proprio]);
  });

  it.each(["erro estruturado", "rejeição"])("erro de escrita sem confirmação (%s) conserva o upload incerto", async (modo) => {
    const atuais = [audio(1)];
    const db = template({ id: TPL, owner_user_id: USER, midias: atuais });
    if (modo === "erro estruturado") db.erroDeGravacao = { message: "falha sintética" };
    else db.antesDeGravar = () => { throw new Error("falha sintética"); };
    const r = await POST(multipart(OGG, { substituir_audio: audio(1).storage_path }), params);
    expect(r.status).toBe(500);
    expect(db.linha!.midias).toEqual(atuais);
    expect(db.updates).toHaveLength(0);
    expect(h.objetos.has(h.storage.upload.mock.calls[0]![0] as string)).toBe(true);
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  it("rejeição da limpeza posterior não transforma troca persistida em falha", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [audio(1)] });
    h.storage.remove.mockRejectedValue(new Error("falha sintética"));
    const r = await POST(multipart(OGG, { substituir_audio: audio(1).storage_path }), params);
    expect(r.status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect((db.linha!.midias as Linha[])[0]!.storage_path).toBe(h.storage.upload.mock.calls[0]![0]);
  });

  it.each(["rejeicao", "erro"] as const)("commit seguido de confirmação perdida (%s) conserva os bytes da nova referência", async (modo) => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [audio(1)] });
    h.objetos.set(audio(1).storage_path, new Uint8Array(OGG));
    db.perderConfirmacao = modo;
    const r = await POST(multipart(OGG, { substituir_audio: audio(1).storage_path }), params);
    expect(r.status).toBe(500);
    expect(db.updates).toHaveLength(1);
    const referencia = (db.linha!.midias as Linha[])[0]!.storage_path as string;
    expect(referencia).toBe(h.storage.upload.mock.calls[0]![0]);
    expect(h.objetos.get(referencia)).toEqual(new Uint8Array(OGG));
    expect(h.objetos.has(audio(1).storage_path)).toBe(true);
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  it.each(["rejeicao", "erro"] as const)("primeiro upload persistido sem confirmação (%s) mantém linha/bytes", async (modo) => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [] });
    db.perderConfirmacao = modo;
    const r = await POST(multipart(OGG, { midias_esperadas: "[]" }), params);
    expect(r.status).toBe(500);
    expect(db.updates).toHaveLength(1);
    const referencia = (db.linha!.midias as Linha[])[0]!.storage_path as string;
    expect(h.objetos.get(referencia)).toEqual(new Uint8Array(OGG));
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  it.each([null, {}, { storage_path: 7 }, "arquivo", ["arquivo"]].map((entrada) => ({ entrada })))(
    "upload recusa entrada JSONB malformada antes de Storage ($entrada)", async ({ entrada }) => {
      const db = template({ id: TPL, owner_user_id: USER, midias: [entrada] });
      const r = await POST(multipart(OGG), params);
      expect(r.status).toBe(409);
      expect(db.updates).toHaveLength(0);
      expect(h.storage.upload).not.toHaveBeenCalled();
      expect(h.storage.remove).not.toHaveBeenCalled();
    },
  );

  it("snapshot multipart nulo é recusado antes de upload;[] continua sendo snapshot válido", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [] });
    const r = await POST(multipart(OGG, { midias_esperadas: "null" }), params);
    expect(r.status).toBe(422);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it("controle positivo: snapshot[] permite acrescentar à linha vazia", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [] });
    const r = await POST(multipart(OGG, { midias_esperadas: "[]" }), params);
    expect(r.status).toBe(200);
    expect(db.updates).toHaveLength(1);
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
    // A URL é a posição, não a imagem: cache aqui serve a imagem trocada.
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(h.storage.download).toHaveBeenCalledWith(minha(1).storage_path);
  });
});
