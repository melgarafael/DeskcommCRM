/**
 * A MÍDIA DA ABORDAGEM PRECISA SER UM ARQUIVO DESTA ORGANIZAÇÃO (#4581).
 *
 * O worker assina a URL do arquivo com a service role (`prepararMidiaDaAbordagem`),
 * que lê QUALQUER caminho do bucket. A única coisa entre a configuração da
 * campanha e o arquivo de outro cliente é a conferência de posse em
 * `validateConfig` — que roda no `start` e de novo em cada rodada do worker.
 *
 * Perder essa linha não quebra nenhum outro teste: o schema confere tipo e
 * tamanho, não dono. Este arquivo é a guarda dela.
 */
import { describe, expect, it, vi } from "vitest";

import { ProspectingError } from "@/lib/prospecting/provider";
import { validateConfig } from "@/lib/prospecting/store";

const ORG = "0b110000-0000-4000-8000-000000000001";
const OUTRA_ORG = "0b110000-0000-4000-8000-000000000009";

const CONFIG = {
  agent_id: "0b110000-1111-4000-8000-000000000001",
  channel_session_id: "0b110000-2222-4000-8000-000000000002",
  pipeline_id: "0b110000-3333-4000-8000-000000000003",
  stage_id: "0b110000-4444-4000-8000-000000000004",
  qualified_stage_id: "0b110000-4444-4000-8000-000000000005",
  instruction: "Oferecer uma avaliação comercial.",
  qualification: "Confirmou a necessidade e quer conversar.",
  ofertas: ["site"],
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "Avaliação de legítimo interesse nº 03/2026",
};

const comMidia = (storage_path: string) => ({
  ...CONFIG,
  midia_da_abordagem: { storage_path, media_mime: "image/jpeg", media_size_bytes: 320_000 },
});

const MENSAGEM_DE_POSSE = "A mídia da abordagem precisa ser um arquivo desta organização";

/** Banco vazio: depois da conferência de posse, a próxima recusa é a do agente. */
async function recusa(config: unknown): Promise<ProspectingError> {
  const db = { query: vi.fn(async () => ({ rows: [] })) };
  try {
    await validateConfig(db as never, ORG, config as never);
  } catch (erro) {
    if (erro instanceof ProspectingError) return erro;
    throw erro;
  }
  throw new Error("validateConfig não recusou");
}

describe("mídia da abordagem × posse do arquivo", () => {
  it("arquivo de OUTRA organização é recusado com 422, antes de qualquer consulta", async () => {
    const erro = await recusa(comMidia(`${OUTRA_ORG}/templates/t1/foto.jpg`));
    expect(erro.message).toContain(MENSAGEM_DE_POSSE);
    expect(erro.status).toBe(422);
  });

  it("subir de pasta a partir do prefixo da organização também é recusado", async () => {
    const erro = await recusa(comMidia(`${ORG}/../${OUTRA_ORG}/templates/t1/foto.jpg`));
    expect(erro.message).toContain(MENSAGEM_DE_POSSE);
  });

  it("controle: o arquivo DESTA organização passa da posse e cai na conferência seguinte", async () => {
    const erro = await recusa(comMidia(`${ORG}/templates/t1/foto.jpg`));
    expect(erro.message).not.toContain(MENSAGEM_DE_POSSE);
  });
});
