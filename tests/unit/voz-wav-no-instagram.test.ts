/**
 * NOTA DE VOZ DA IA NO INSTAGRAM — em WAV, o formato que a DM aceita.
 *
 * ─── De onde vem ────────────────────────────────────────────────────────────
 *
 * Instalação real, 15/11/2026: o agente mandava mp3 numa DM de Instagram e o
 * provedor respondia 400 em toda tentativa. O primeiro conserto calou a voz nas
 * redes sociais (`voiceNote: "none"`). Este devolve a voz onde ela foi MEDIDA:
 * um WAV (PCM 16 bits, mono, 24 kHz, o cabeçalho de `embrulharPcmEmWav`) mandado
 * pelo mesmo corpo do adapter voltou 200 com o id de mensagem do Instagram e
 * tocou no aplicativo. O Facebook, que usa o mesmo provedor e não foi medido,
 * segue em texto.
 *
 * ─── O que se cobra aqui ───────────────────────────────────────────────────
 *
 *  1. a matriz: a sessão social do Instagram entrega WAV; a do Facebook, e a
 *     sem rede gravada, não entregam nada;
 *  2. o turno lê provedor E rede da sessão (`loadNotaDeVozDoCanal`);
 *  3. a síntese pede PCM à ElevenLabs e devolve WAV com a etiqueta audio/wav;
 *  4. a lista de canais da tela diz a mesma coisa que o turno.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { CHANNEL_PROVIDER_SOCIAL, notaDeVozDoCanal } from "@/lib/channels/capabilities";
import { loadNotaDeVozDoCanal } from "@/lib/agent-engine/guardrails/before-send";
import { formatoDaVozParaCanal } from "@/lib/ai/voz/formato";
import { sintetizarVoz } from "@/lib/ai/voz/sintetizar";
import { ehContainerWav } from "@/lib/ai/voz/wav";
import { listSelectableChannels } from "@/lib/channels/selectable";

const ORG = "33333333-3333-4333-8333-333333333333";

describe("matriz — a voz da rede social é da REDE, não só do provedor", () => {
  it("Instagram (medido) entrega WAV", () => {
    expect(notaDeVozDoCanal(CHANNEL_PROVIDER_SOCIAL, "instagram")).toBe("wav-only");
    expect(formatoDaVozParaCanal(notaDeVozDoCanal(CHANNEL_PROVIDER_SOCIAL, "instagram"))).toBe("wav");
  });

  it("Facebook (não medido) e sessão sem rede gravada seguem em texto", () => {
    expect(notaDeVozDoCanal(CHANNEL_PROVIDER_SOCIAL, "facebook")).toBe("none");
    expect(notaDeVozDoCanal(CHANNEL_PROVIDER_SOCIAL, null)).toBe("none");
  });

  it("nome de rede que é chave de todo objeto não vira capacidade", () => {
    expect(notaDeVozDoCanal(CHANNEL_PROVIDER_SOCIAL, "constructor")).toBe("none");
    expect(notaDeVozDoCanal(CHANNEL_PROVIDER_SOCIAL, "__proto__")).toBe("none");
  });

  it("a rede só pesa no provedor social; os outros seguem a matriz", () => {
    expect(notaDeVozDoCanal("waha", "instagram")).toBe("server-convert");
    expect(notaDeVozDoCanal("meta_cloud", null)).toBe("opus-only");
    expect(notaDeVozDoCanal("provedor_que_este_build_nao_conhece", "instagram")).toBe("none");
    expect(notaDeVozDoCanal("toString", null)).toBe("none");
    expect(notaDeVozDoCanal(null, null)).toBe("none");
  });
});

describe("turno — `loadNotaDeVozDoCanal` lê provedor e rede da sessão", () => {
  const poolCom = (rows: Record<string, unknown>[]) => ({ query: vi.fn().mockResolvedValue({ rows }) });

  it("sessão do Instagram: WAV, com a organização filtrada à mão", async () => {
    const db = poolCom([{ provider: CHANNEL_PROVIDER_SOCIAL, rede_social: "instagram" }]);
    await expect(loadNotaDeVozDoCanal(db as never, ORG, "canal-1")).resolves.toBe("wav-only");
    const [sql, params] = db.query.mock.calls[0]!;
    expect(String(sql)).toContain("metadata->>'social_platform'");
    expect(String(sql)).toContain("organization_id = $1");
    expect(params).toEqual([ORG, "canal-1"]);
  });

  it("sessão do Facebook: texto", async () => {
    const db = poolCom([{ provider: CHANNEL_PROVIDER_SOCIAL, rede_social: "facebook" }]);
    await expect(loadNotaDeVozDoCanal(db as never, ORG, "canal-1")).resolves.toBe("none");
  });

  it("sessão que não existe: o provedor padrão, a mesma régua de `loadChannelProvider`", async () => {
    await expect(loadNotaDeVozDoCanal(poolCom([]) as never, ORG, "canal-1")).resolves.toBe("server-convert");
  });
});

describe("síntese em WAV — PCM da ElevenLabs com cabeçalho", () => {
  const resposta = (bytes: number[], tipo = "audio/pcm") =>
    new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": tipo } });

  it("pede `output_format=pcm_24000` e devolve WAV etiquetado audio/wav", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resposta([0x01, 0x00, 0x02, 0x00]));
    const r = await sintetizarVoz({ apiKey: "sk", voiceId: "v1", texto: "olá", formato: "wav" }, fetchMock);

    expect(String(fetchMock.mock.calls[0]![0])).toContain("?output_format=pcm_24000");
    expect(r.mimeType).toBe("audio/wav");
    expect(ehContainerWav(r.audio)).toBe(true);
    expect(r.audio.readUInt32LE(24)).toBe(24_000);
    expect(r.audio.subarray(44).equals(Buffer.from([0x01, 0x00, 0x02, 0x00]))).toBe(true);
    expect(r.caracteres).toBe(3);
  });

  it("contêiner no lugar do PCM (mp3, ogg) lança — o envio cai para texto em vez de mandar chiado", async () => {
    for (const bytes of [[0x49, 0x44, 0x33, 0x04], [0x4f, 0x67, 0x67, 0x53]]) {
      const fetchMock = vi.fn().mockResolvedValue(resposta(bytes));
      await expect(
        sintetizarVoz({ apiKey: "sk", voiceId: "v1", texto: "olá", formato: "wav" }, fetchMock),
      ).rejects.toThrow("synthesis_formato_inesperado");
    }
  });
});

describe("lista de canais da tela — a mesma régua do turno", () => {
  function dbCom(linhas: Record<string, unknown>[]): SupabaseClient {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(resolve);
    return { from: () => b } as unknown as SupabaseClient;
  }
  const linha = (id: string, metadata: Record<string, unknown> | null) => ({
    id,
    display_name: id,
    status: "WORKING",
    phone_number: null,
    waha_session_name: null,
    provider: CHANNEL_PROVIDER_SOCIAL,
    metadata,
  });

  it("a conta de Instagram promete voz; a de Facebook e a sem rede, não", async () => {
    const canais = await listSelectableChannels(
      dbCom([
        linha("instagram", { social_platform: "instagram" }),
        linha("facebook", { social_platform: "facebook" }),
        linha("sem-rede", null),
      ]),
      ORG,
    );
    expect(Object.fromEntries(canais.map((c) => [c.id, c.enviaNotaDeVoz]))).toEqual({
      instagram: true,
      facebook: false,
      "sem-rede": false,
    });
  });
});
