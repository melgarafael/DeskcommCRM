/**
 * POST /api/v1/prospecting/arquivo — o upload do arquivo da primeira abordagem
 * (#4751).
 *
 * A rota é a DONA do caminho e da régua: o `storage_path` sai dela, nunca do
 * corpo, e o tipo é decidido pelos BYTES. Os casos abaixo fixam as duas coisas
 * que a tela depende — o descritor devolvido é o que a configuração grava, e o
 * que a régua do envio recusaria também é recusado aqui.
 *
 * O corpo multipart é montado NA MÃO, como em `leads-import-route.test.ts`: um
 * `FormData` do jsdom passado como `body` de um `NextRequest` é serializado pelo
 * undici como a STRING "undefined", e o teste mediria o realm do ambiente em vez
 * da rota.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { pedidoComTamanho } from "@/tests/helpers/pedido-com-tamanho";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { POST } = await import("@/app/api/v1/prospecting/arquivo/route");

const ORG = "0b110000-0000-4000-8000-000000000001";
const CAMINHO = "/api/v1/prospecting/arquivo";
const B = "----prospeccao4751";

interface Upload {
  bucket: string;
  path: string;
  contentType: string;
  upsert: boolean;
}

let uploads: Upload[];

function adminFalso() {
  return {
    storage: {
      from(bucket: string) {
        return {
          upload: async (
            path: string,
            _corpo: unknown,
            opcoes: { contentType: string; upsert: boolean },
          ) => {
            uploads.push({ bucket, path, ...opcoes });
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
}

const TEXTO = new TextEncoder();

/**
 * `Uint8Array<ArrayBuffer>` e não `Uint8Array`: desde o TS 5.7 o tipo é genérico
 * no buffer, e o `BodyInit` do `fetch` só aceita o buffer concreto — escrever o
 * tipo cru aqui devolve `Uint8Array<ArrayBufferLike>` e o `tsc` reprova no
 * `body:` da requisição (o `TextEncoder` deste arquivo já devolve o concreto).
 */
function concat(partes: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const parte of partes) {
    bytes.set(parte, cursor);
    cursor += parte.length;
  }
  return bytes;
}

/** O fio do navegador: cabeçalho da parte, bytes do arquivo, fecho do multipart. */
function corpoMultipart(
  arquivo: { nome: string; tipo: string; bytes: Uint8Array } | null,
): Uint8Array<ArrayBuffer> {
  const partes: Uint8Array[] = [];
  if (arquivo) {
    partes.push(
      TEXTO.encode(
        `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${arquivo.nome}"\r\n` +
          `Content-Type: ${arquivo.tipo}\r\n\r\n`,
      ),
      arquivo.bytes,
      TEXTO.encode("\r\n"),
    );
  }
  partes.push(TEXTO.encode(`--${B}--\r\n`));
  return concat(partes);
}

async function requisicao(arquivo: { nome: string; tipo: string; bytes: Uint8Array } | null) {
  return pedidoComTamanho(`http://localhost${CAMINHO}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${B}` },
    body: corpoMultipart(arquivo),
  });
}

const PDF = { nome: "proposta.pdf", tipo: "application/pdf", bytes: TEXTO.encode("%PDF-1.7\n1 0 obj\n") };
const OGG = { nome: "voz.ogg", tipo: "audio/ogg", bytes: TEXTO.encode("OggS0000000000000000") };

beforeEach(() => {
  uploads = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(adminFalso() as never);
});

describe("POST /api/v1/prospecting/arquivo", () => {
  it("guarda o PDF em {org}/prospecting/ e devolve o descritor da configuração", async () => {
    const res = await POST(await requisicao(PDF));
    expect(res.status).toBe(201);

    const corpo = (await res.json()) as {
      data: {
        nome: string;
        midia: { storage_path: string; media_mime: string; media_size_bytes: number };
      };
    };
    expect(corpo.data.nome).toBe("proposta.pdf");
    expect(corpo.data.midia.media_mime).toBe("application/pdf");
    expect(corpo.data.midia.storage_path).toMatch(
      new RegExp(`^${ORG}/prospecting/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(corpo.data.midia.media_size_bytes).toBe(PDF.bytes.length);

    // O caminho que a tela grava é o que foi para o bucket — sem tradução.
    expect(uploads).toEqual([
      {
        bucket: "whatsapp-media",
        path: corpo.data.midia.storage_path,
        contentType: "application/pdf",
        upsert: false,
      },
    ]);
  });

  it("recusa áudio mesmo com o content-type declarado a favor dele", async () => {
    const res = await POST(await requisicao(OGG));
    expect(res.status).toBe(415);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("unsupported_media_type");
    expect(corpo.error.message).toContain("imagem (JPG, PNG ou WEBP)");
    expect(uploads).toEqual([]);
  });

  it("recusa imagem acima do teto do envio, sem gravar arquivo", async () => {
    const grande = new Uint8Array(5 * 1024 * 1024 + 1);
    grande.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const res = await POST(
      await requisicao({ nome: "foto.png", tipo: "image/png", bytes: grande }),
    );
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toContain("tamanho máximo aceito para este tipo");
    expect(uploads).toEqual([]);
  });

  it("exige o campo multipart `file`", async () => {
    const res = await POST(await requisicao(null));
    expect(res.status).toBe(422);
    expect(uploads).toEqual([]);
  });
});
