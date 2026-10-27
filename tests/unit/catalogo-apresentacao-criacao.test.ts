import { File as NodeFile } from "node:buffer";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cliente: vi.fn(), upload: vi.fn(), remover: vi.fn(), assinar: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(async () => ({
  ok: true, org: { orgId: "a0647000-0000-4000-8000-000000000001", role: "manager" },
  user: { id: "a0647000-1111-4000-8000-000000000001", idioma: "pt-BR" },
})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.cliente }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  storage: { from: () => ({ upload: mocks.upload, remove: mocks.remover, createSignedUrl: mocks.assinar }) },
}) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (s: string) => s }));
vi.mock("@/lib/messaging/media/voice-transcode", () => ({
  transcodificarNotaDeVoz: vi.fn(() => { throw new Error("transcode real não autorizado neste teste de CAS"); }),
}));

import { GET, PATCH } from "@/app/api/v1/products/[id]/ai-presentation/route";
import { POST, DELETE } from "@/app/api/v1/products/[id]/ai-presentation/audio/route";

const ORG = "a0647000-0000-4000-8000-000000000001";
const PROD = "a0647000-2222-4000-8000-000000000001";
const ID = "a0647000-3333-4000-8000-000000000001";
const T0 = "2026-10-25T12:00:00.000Z";
const T1 = "2026-10-25T12:00:01.000Z";
const AUDIO_ANTERIOR = `${ORG}/${PROD}/a0647000-4444-4000-8000-000000000001.ogg`;
type Linha = Record<string, unknown>;
let apresentacao: Linha | null;
let antesDeAtualizar: (() => void) | undefined;
let escritas: Linha[];

function linha(extra: Linha = {}): Linha {
  return { id: ID, organization_id: ORG, catalog_product_id: PROD, enabled: false, kind: "text",
    title: null, text_content: null, use_catalog_photos: false, show_price: false,
    audio_storage_path: null, audio_mime: null, audio_size_bytes: null,
    created_at: T0, updated_at: T0, ...extra };
}

// A leitura é snapshot independente. O UPDATE só aplica se seus predicados
// ainda casarem na execução; não há referência compartilhada que esconda CAS.
function banco() {
  return { from(tabela: string) {
    const filtros: ((l: Linha) => boolean)[] = [];
    let patch: Linha | undefined;
    let inserida: Linha | undefined;
    const q = {
      select: () => q,
      eq(campo: string, valor: unknown) { filtros.push(l => l[campo] === valor); return q; },
      update(valores: Linha) { patch = valores; return q; },
      insert(valores: Linha) { inserida = valores; return q; },
      async maybeSingle() {
        if (tabela === "catalog_products") {
          const produto = { id: PROD, organization_id: ORG, fotos: [] };
          return { data: filtros.every(f => f(produto)) ? { ...produto } : null, error: null };
        }
        if (tabela !== "catalog_product_presentations") throw new Error(`tabela inesperada: ${tabela}`);
        if (inserida) {
          if (apresentacao) return { data: null, error: { code: "23505" } };
          apresentacao = linha({ ...inserida, updated_at: T1 });
          escritas.push({ operacao: "insert", ...inserida });
          return { data: structuredClone(apresentacao), error: null };
        }
        if (patch) antesDeAtualizar?.();
        const alvo = apresentacao && filtros.every(f => f(apresentacao!)) ? apresentacao : null;
        if (patch && alvo) {
          Object.assign(alvo, patch, { updated_at: T1 });
          escritas.push({ operacao: "update", ...patch });
        }
        return { data: alvo ? structuredClone(alvo) : null, error: null };
      },
    };
    return q;
  } };
}

const ctx = () => ({ params: Promise.resolve({ id: PROD }) });
const dados = (expected_updated_at: string | null) => ({ enabled: false, kind: "text", title: "Título",
  text_content: "Apresentação sintética", use_catalog_photos: false, show_price: false, expected_updated_at });
const jsonRequest = (value: unknown) => ({ json: async () => value }) as NextRequest;
function audioRequest(expected: string | null): NextRequest {
  // Cabeçalho sintético para isolar criação/CAS. Não é prova de decodificação,
  // conversão WebM ou reprodução; a fronteira do Storage é dublada.
  const bytes = Buffer.alloc(64);
  bytes.write("OggS", 0); bytes.write("OpusHead", 28);
  const arquivo = new NodeFile([bytes], "voz-sintetica.ogg", { type: "audio/ogg;codecs=opus" });
  const values = new Map<string, unknown>([["file", arquivo], ["expected_updated_at", expected ?? "null"]]);
  return { headers: new Headers(), formData: async () => ({ get: (k: string) => values.get(k) ?? null }) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  apresentacao = null; antesDeAtualizar = undefined; escritas = [];
  mocks.cliente.mockResolvedValue(banco());
  mocks.upload.mockResolvedValue({ error: null });
  mocks.remover.mockResolvedValue({ error: null });
  mocks.assinar.mockResolvedValue({ data: { signedUrl: "https://test-placeholder.invalid/audio" }, error: null });
  mocks.audit.mockResolvedValue(undefined);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("rede real proibida neste teste isolado"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("apresentação nova usa a revisão null e edições continuam condicionais", () => {
  it("GET ausente devolve o null que a tela usará, sem criar uma linha escondida", async () => {
    const resposta = await GET(jsonRequest(null), ctx());
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).data.updated_at).toBeNull();
    expect(apresentacao).toBeNull(); expect(escritas).toEqual([]);
  });

  it("PATCH inicial com expected null cria a apresentação", async () => {
    const resposta = await PATCH(jsonRequest(dados(null)), ctx());
    expect(resposta.status).toBe(200);
    expect(apresentacao).toMatchObject({ organization_id: ORG, catalog_product_id: PROD, text_content: "Apresentação sintética" });
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.operacao).toBe("insert");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("POST inicial com expected null cria o áudio no namespace do produto", async () => {
    const resposta = await POST(audioRequest(null), ctx());
    expect(resposta.status).toBe(201);
    expect(apresentacao).toMatchObject({ organization_id: ORG, catalog_product_id: PROD, kind: "audio", audio_mime: "audio/ogg;codecs=opus" });
    expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${ORG}/${PROD}/[0-9a-f-]{36}\\.ogg$`)), expect.any(Buffer), expect.objectContaining({ upsert: false }));
    expect(escritas[0]!.operacao).toBe("insert");
  });

  it("controle: edição com revisão correta atualiza a mesma linha", async () => {
    apresentacao = linha();
    const resposta = await PATCH(jsonRequest(dados(T0)), ctx());
    expect(resposta.status).toBe(200);
    expect(apresentacao).toMatchObject({ id: ID, updated_at: T1, text_content: "Apresentação sintética" });
    expect(escritas[0]!.operacao).toBe("update");
  });

  it("revisão null não sobrescreve apresentação já existente", async () => {
    apresentacao = linha();
    const antes = structuredClone(apresentacao);
    expect((await PATCH(jsonRequest(dados(null)), ctx())).status).toBe(409);
    expect(apresentacao).toEqual(antes); expect(escritas).toEqual([]);
  });

  it("perder o CAS entre leitura e UPDATE preserva a edição que ganhou", async () => {
    apresentacao = linha();
    antesDeAtualizar = () => { Object.assign(apresentacao!, { updated_at: T1, text_content: "Edição concorrente" }); };
    const resposta = await PATCH(jsonRequest(dados(T0)), ctx());
    expect(resposta.status).toBe(409);
    expect(apresentacao).toMatchObject({ id: ID, text_content: "Edição concorrente", updated_at: T1 });
    expect(escritas).toEqual([]); expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("upload que perde CAS remove só seu arquivo novo, preservando o áudio vencedor", async () => {
    apresentacao = linha({ kind: "audio", audio_storage_path: AUDIO_ANTERIOR, audio_mime: "audio/ogg;codecs=opus", audio_size_bytes: 64 });
    antesDeAtualizar = () => { Object.assign(apresentacao!, { updated_at: T1 }); };
    const resposta = await POST(audioRequest(T0), ctx());
    expect(resposta.status).toBe(409);
    const novoCaminho = mocks.upload.mock.calls[0]![0] as string;
    expect(novoCaminho).not.toBe(AUDIO_ANTERIOR);
    expect(mocks.remover).toHaveBeenCalledExactlyOnceWith([novoCaminho]);
    expect(apresentacao).toMatchObject({ audio_storage_path: AUDIO_ANTERIOR, updated_at: T1 });
    expect(escritas).toEqual([]); expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("remover áudio de apresentação ausente é o no-op previsto pela rota", async () => {
    const resposta = await DELETE(jsonRequest({ expected_updated_at: null }), ctx());
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).data.updated_at).toBeNull();
    expect(escritas).toEqual([]); expect(mocks.remover).not.toHaveBeenCalled();
  });
});
