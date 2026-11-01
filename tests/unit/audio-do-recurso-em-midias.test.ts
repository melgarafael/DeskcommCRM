// @vitest-environment node
/**
 * O ÁUDIO DO RECURSO ENTRA POR `midias` (#2833) — o farejador, o teto e a
 * rota, exercitados pelo CAMINHO e não só pelo nome das funções.
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. O tipo sai da ASSINATURA dos bytes, nunca do `file.type` do multipart —
 *    que é uma string que QUEM SOBE escolhe. O caso do "mimetype mentiroso"
 *    (`audio/ogg` de verdade anunciado como `image/png`) é o que reprova um
 *    farejador que volte a ler o campo do cliente.
 * 2. O teto é do tipo JÁ farejado: 16 MB para áudio, 5 MB para imagem. O teto
 *    de imagem não serve para áudio — e o caso do limite é o que reprova uma
 *    rota que aceite acima do teto.
 * 3. A leitura do arquivo é a MESMA do `/` (`GET .../midias/:indice`, que
 *    devolve o corpo pela própria origem): a rota GET da URL assinada saiu com
 *    o caminho próprio da barra, e o recurso passou a baixar os bytes como
 *    qualquer outra mídia de resposta rápida.
 *
 * Nada aqui abre caminho paralelo de mídia: bucket, prefixo e coluna são os da
 * resposta rápida (#2526) — de propósito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
  storage: {
    upload: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: h.from }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => h.storage } }),
}));

import { POST } from "@/app/api/v1/message-templates/[id]/midias/route";
import {
  TAMANHO_MAXIMO_DA_MIDIA,
  TAMANHO_MAXIMO_DO_AUDIO,
  ehMidiaDeAudio,
  extensaoDaMidia,
  farejarTipoDeMidia,
  midiaDeAudioDe,
  midiaPertenceAoTemplate,
  mimeDaMidia,
  tetoDaMidia,
} from "@/lib/templates/midias";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const TPL = "22222222-2222-4222-8222-222222222222";
const USER = "55555555-5555-4555-8555-555555555555";

/** O cabeçalho de todo Ogg ("OggS") seguido de Opus — o áudio de nota de voz. */
const OGG = [0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
/** "ID3" — o cabeçalho de tag do MP3 que sai de qualquer exportador. */
const MP3 = [0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00];
/** `FF F1` = AAC em ADTS (sync de 12 bits, layer 00). */
const AAC = [0xff, 0xf1, 0x50, 0x80, 0x00, 0x00, 0x00];
/** "RIFF" + tamanho + "WAVE". */
const WAV = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
/** "#!AMR" — o AMR que o WhatsApp oficial usa para voz. */
const AMR = [0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
/** `ftyp` de MP4/M4A: o contêiner NÃO distingue áudio de vídeo pelos 4 bytes. */
const MP4 = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20];

type Linha = Record<string, unknown>;

/** Uma linha de `message_templates`, com a cadeia que as duas rotas usam. */
function template(linha: Linha | null) {
  const estado = { linha, updates: [] as Linha[] };
  h.from.mockImplementation(() => {
    let op: "select" | "update" = "select";
    let patch: Linha = {};
    const b = {
      select: () => b,
      eq: () => b,
      update: (v: Linha) => {
        op = "update";
        patch = v;
        return b;
      },
      maybeSingle: async () => {
        if (!estado.linha) return { data: null, error: null };
        if (op === "update") {
          estado.updates.push(patch);
          Object.assign(estado.linha, patch);
        }
        return { data: { ...estado.linha }, error: null };
      },
    };
    return b;
  });
  return estado;
}

const params = { params: Promise.resolve({ id: TPL }) };

function multipart(bytes: number[] | Uint8Array<ArrayBuffer>, nome: string, tipo: string) {
  const corpo = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const form = new FormData();
  form.append("file", new File([corpo], nome, { type: tipo }));
  return new NextRequest(`http://localhost/api/v1/message-templates/${TPL}/midias`, {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt" },
    org: { orgId: ORG, role: "manager" },
  });
  h.apoio.mockResolvedValue(null);
  h.storage.upload.mockResolvedValue({ error: null });
  h.storage.remove.mockResolvedValue({ error: null });
});

describe("o farejador decide pelo BYTES — e o áudio é tipo de `midias`", () => {
  it.each([
    ["ogg (OggS/Opus)", OGG, "audio/ogg"],
    ["mp3 (ID3)", MP3, "audio/mpeg"],
    ["aac (ADTS)", AAC, "audio/aac"],
    ["wav (RIFF/WAVE)", WAV, "audio/wav"],
    ["amr (#!AMR)", AMR, "audio/amr"],
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
  ])("reconhece %s pela assinatura", (_nome, bytes, esperado) => {
    const tipo = farejarTipoDeMidia(new Uint8Array(bytes as number[]));
    expect(tipo).toBe(esperado);
    if (!tipo) throw new Error("esperava um tipo");
    // A volta: a extensão que a rota grava diz o MESMO mime para quem lê.
    expect(mimeDaMidia(`org/templates/${TPL}/0a0b0c0d-0000-4000-8000-000000000001.${extensaoDaMidia(tipo)}`)).toBe(
      esperado,
    );
  });

  it("não confunde VÍDEO com áudio: o contêiner MP4 fica de fora", () => {
    // `ftyp` é a assinatura de MP4 e de M4A ao mesmo tempo. Um farejador que a
    // aceitasse gravaria o vídeo do operador como áudio do recurso.
    expect(farejarTipoDeMidia(new Uint8Array(MP4))).toBeNull();
    expect(farejarTipoDeMidia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBeNull();
    expect(farejarTipoDeMidia(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
  });

  it("o caminho do áudio passa pela MESMA conferência de posse das imagens", () => {
    const ogg = `${ORG}/templates/${TPL}/0a0b0c0d-0000-4000-8000-000000000001.ogg`;
    expect(midiaPertenceAoTemplate(ogg, ORG, TPL)).toBe(true);
    expect(midiaPertenceAoTemplate(ogg.replace(ORG, OUTRA_ORG), ORG, TPL)).toBe(false);
    expect(midiaPertenceAoTemplate(`${ORG}/templates/${TPL}/x.ogg`, ORG, TPL)).toBe(false);
  });

  it("o tipo do recurso sai do CAMINHO da entrada de `midias`", () => {
    const audio = {
      storage_path: `${ORG}/templates/${TPL}/0a0b0c0d-0000-4000-8000-000000000001.ogg`,
      media_mime: "image/png",
      media_size_bytes: 10,
    };
    expect(ehMidiaDeAudio(audio)).toBe(true);
    expect(midiaDeAudioDe([audio])).toEqual(audio);
    expect(ehMidiaDeAudio({ storage_path: `${ORG}/templates/${TPL}/x.jpg` })).toBe(false);
  });

  it("o teto é do tipo que foi farejado", () => {
    expect(tetoDaMidia("audio/ogg")).toBe(TAMANHO_MAXIMO_DO_AUDIO);
    expect(tetoDaMidia("audio/mpeg")).toBe(TAMANHO_MAXIMO_DO_AUDIO);
    expect(tetoDaMidia("image/png")).toBe(TAMANHO_MAXIMO_DA_MIDIA);
    expect(TAMANHO_MAXIMO_DO_AUDIO).toBe(16 * 1024 * 1024);
    expect(TAMANHO_MAXIMO_DO_AUDIO).toBeGreaterThan(TAMANHO_MAXIMO_DA_MIDIA);
  });
});

describe("POST /message-templates/:id/midias — áudio", () => {
  it("áudio de verdade anunciado como imagem: o caminho vira .ogg e a linha guarda o áudio", async () => {
    const db = template({ id: TPL, owner_user_id: USER, midias: [] });

    // `file.type` MENTE de propósito: é o campo que o cliente controla.
    const r = await POST(multipart(OGG, "foto.jpg", "image/png"), params);

    expect(r.status).toBe(200);
    const caminho = h.storage.upload.mock.calls[0]![0] as string;
    expect(caminho.startsWith(`${ORG}/templates/${TPL}/`)).toBe(true);
    expect(caminho.endsWith(".ogg")).toBe(true);
    expect(h.storage.upload.mock.calls[0]![2]).toMatchObject({ contentType: "audio/ogg" });
    expect(db.updates[0]!.midias).toEqual([
      { storage_path: caminho, media_mime: "audio/ogg", media_size_bytes: 12 },
    ]);
  });

  it("áudio acima de 16 MB: 413 e nada sobe", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [] });

    const grande = new Uint8Array(TAMANHO_MAXIMO_DO_AUDIO + 1);
    grande.set(new Uint8Array(OGG), 0);

    const r = await POST(multipart(grande, "longo.ogg", "audio/ogg"), params);

    expect(r.status).toBe(413);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it("imagem acima de 5 MB continua 413, mesmo com o teto de áudio da rota", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [] });

    const grande = new Uint8Array(TAMANHO_MAXIMO_DA_MIDIA + 1);
    grande.set(new Uint8Array(JPEG), 0);

    const r = await POST(multipart(grande, "foto.jpg", "image/jpeg"), params);

    expect(r.status).toBe(413);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it("tipo não aceito: 415 e nada sobe", async () => {
    template({ id: TPL, owner_user_id: USER, midias: [] });

    const r = await POST(multipart(MP4, "clipe.m4a", "audio/mp4"), params);

    expect(r.status).toBe(415);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });
});

