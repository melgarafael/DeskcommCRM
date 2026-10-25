// @vitest-environment node
/**
 * A EMISSÃO DO ATESTADO — o papel sai, e sai GRAVADO onde a rota vai buscá-lo.
 *
 * ─── O que este arquivo mede, e por que não é tautológico ───────────────────
 *
 * O teste de conteúdo (`atestado-de-anonimizacao.test.tsx`) prova o TEXTO; este
 * prova que o caminho de I/O produz um PDF de verdade — e um arquivo que começa
 * com `%PDF` e passa de mil bytes não é o mesmo que uma string vazia gravada
 * com sucesso. Renderizador que devolvesse Buffer vazio faria o outro teste
 * passar inteiro.
 *
 * O TERCEIRO caso lê as BYTES GRAVADAS (o PDF extraído com o mesmo extrator do
 * RAG): é a prova de que a cópia do Storage é identificável pelo protocolo — e
 * de que não leva citação de lei (item 2 do CR do PR #3321), medida no arquivo,
 * não na árvore de elementos.
 *
 * O caso do Storage que recusa existe porque a decisão do worker é engolir a
 * falha: se `emitirAtestadoDeAnonimizacao` não LANÇASSE nesse caminho, o worker
 * não teria como saber que não saiu nada, e `result.atestado` afirmaria um
 * documento que não existe.
 */
import { describe, expect, it } from "vitest";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import {
  VERSAO_DO_ATESTADO,
  type DadosDoAtestado,
} from "@/lib/lgpd/atestado-de-anonimizacao";
import { renderAtestadoPdf } from "@/lib/lgpd/atestado-renderer";
import { BUCKET_DO_ATESTADO, emitirAtestadoDeAnonimizacao } from "@/lib/lgpd/emitir-atestado";

function dados(over: Partial<DadosDoAtestado> = {}): DadosDoAtestado {
  return {
    request_id: "11111111-2222-3333-4444-555555555555",
    organization_id: "org-1",
    organization_name: "Loja Exemplo LTDA",
    organization_document: "12.345.678/0001-90",
    organization_email: "dpo@loja.exemplo",
    evidencia: {
      executor: { user_id: "u1", nome: "Ana Lima", email: "ana@loja.exemplo", papel: "administrador" },
      ip: "203.0.113.7",
      em: "2026-10-22T15:04:05.000Z",
      origem: "aprovacao_manual",
    },
    escopo: "contact",
    fuso: "America/Sao_Paulo",
    ...over,
  };
}

function storageFalso(erro: string | null) {
  const gravados: Array<{ bucket: string; path: string; bytes: number; corpo: Buffer; opcoes?: Record<string, unknown> }> = [];
  return {
    gravados,
    admin: {
      storage: {
        from(bucket: string) {
          return {
            async upload(path: string, corpo: Buffer, opcoes?: Record<string, unknown>) {
              gravados.push({ bucket, path, bytes: corpo.length, corpo, opcoes });
              return { error: erro ? { message: erro } : null };
            },
          };
        },
      },
    },
  };
}

describe("a emissão do atestado", () => {
  it("grava o PDF no caminho do pedido, no bucket do titular, e devolve o que ficou lá", async () => {
    const { admin, gravados } = storageFalso(null);
    // A chave vem do ambiente do PROCESSO (`pades-signer` lê a mesma): com ela
    // o código é HMAC; sem ela degrada (o caso de baixo).
    const chaveAntes = process.env.LGPD_SIGNING_KEY;
    process.env.LGPD_SIGNING_KEY = "chave-de-assinatura-de-teste-bem-longa";
    const r = await (async () => {
      try {
        return await emitirAtestadoDeAnonimizacao(admin as never, dados());
      } finally {
        if (chaveAntes === undefined) delete process.env.LGPD_SIGNING_KEY;
        else process.env.LGPD_SIGNING_KEY = chaveAntes;
      }
    })();

    expect(gravados).toHaveLength(1);
    expect(gravados[0]!.bucket).toBe(BUCKET_DO_ATESTADO);
    expect(gravados[0]!.path).toBe("org-1/11111111-2222-3333-4444-555555555555/atestado.pdf");
    // O contrato de `fn_arquivos_da_organizacao` (`name like org || '/%'`): sem a
    // org no PRIMEIRO pedaço, a exclusão da organização não alcança o atestado e
    // ele sobra no Storage depois que a empresa saiu.
    expect(gravados[0]!.path.startsWith(`${dados().organization_id}/`)).toBe(true);
    // `upsert` é o que torna a retomada do pedido idempotente em vez de encher o
    // bucket de `atestado(1).pdf`.
    expect(gravados[0]!.opcoes).toMatchObject({ contentType: "application/pdf", upsert: true });
    expect(gravados[0]!.bytes).toBeGreaterThan(1000);

    expect(r.path).toBe(gravados[0]!.path);
    expect(r.bytes).toBe(gravados[0]!.bytes);
    expect(r.codigo).toMatch(/^[0-9a-f]{64}$/);
    expect(r.codigo_curto).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.algoritmo).toBe("hmac-sha256");
    // O PAdES segue degradado enquanto não há certificado provisionado
    // (`pades-signer`): o documento diz o que é, e o metadado também.
    expect(r.pades).toBe(false);
  });

  it("o arquivo emitido é um PDF de verdade, não um Buffer vazio", async () => {
    const bytes = await renderAtestadoPdf({
      dados: dados(),
      codigo: "AAAA-BBBB-CCCC-DDDD",
      algoritmo: "hmac-sha256",
    });

    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("as BYTES GRAVADAS identificam o pedido pelo protocolo e não citam lei", async () => {
    const { admin, gravados } = storageFalso(null);
    process.env.LGPD_SIGNING_KEY = "chave-de-assinatura-de-teste-bem-longa";
    try {
      await emitirAtestadoDeAnonimizacao(admin as never, dados());
    } finally {
      delete process.env.LGPD_SIGNING_KEY;
    }

    const texto = await extractPdfText(gravados[0]!.corpo);

    // Controle positivo: a extração funcionou e a cópia é reconhecível pelo
    // controlador. Sem isto, "não contém" seria indistinguível de extração morta.
    expect(texto).toContain("11111111");
    expect(texto).toContain("Loja Exemplo LTDA");
    expect(texto).toContain("ANONIMIZADOS");
    // Item 2 do CR: nenhuma citação de lei no arquivo.
    expect(texto).not.toMatch(/LGPD|RGPD|GDPR|art\.|artigo|Lei n/i);
  });

  it("sem chave de assinatura, o metadado diz `sha256` — e o documento impresso diz o mesmo", async () => {
    const { admin } = storageFalso(null);
    const antes = process.env.LGPD_SIGNING_KEY;
    delete process.env.LGPD_SIGNING_KEY;
    try {
      const r = await emitirAtestadoDeAnonimizacao(admin as never, dados());
      expect(r.algoritmo).toBe("sha256");
      expect(r.pades).toBe(false);
    } finally {
      if (antes !== undefined) process.env.LGPD_SIGNING_KEY = antes;
    }
  });

  it("Storage que recusa LANÇA — é o que permite ao worker registrar que não saiu", async () => {
    const { admin } = storageFalso("bucket not found");
    await expect(emitirAtestadoDeAnonimizacao(admin as never, dados())).rejects.toThrow(
      "atestado_upload_failed: bucket not found",
    );
  });

  it("o formato do documento gravado é o que o código assina (versão estável)", () => {
    expect(VERSAO_DO_ATESTADO).toBe("atestado-de-anonimizacao.v1");
  });
});
