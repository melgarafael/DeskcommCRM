/**
 * GET /api/v1/ai/providers — o ponto "Ouvir o áudio" anuncia o modelo que RODA.
 *
 * O ponto fixo de transcrição declara `whisper-1`, mas `TRANSCRIPTION_MODEL` (o
 * mesmo `.env` do app e do worker) troca o modelo que o worker usa — inclusive
 * com a chave da OpenAI da organização. A tela lia só o ponto e dizia
 * `whisper-1` com outro modelo em uso. Agora ela roda a mesma escada do worker
 * (`decidirTranscricao`, #2190), e este arquivo mede a rota de ponta a ponta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeEnv from "@/lib/env";

import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

// A escada lê o trio da transcrição pela régua `env` (`lib/env.ts`), como a
// guarda de destino do worker (#855/#964) — `vi.stubEnv` não alcança esse
// caminho. O módulo real segue inteiro; só o trio vem de um objeto do caso.
const transcricaoDoEnv = vi.hoisted(() => ({ apiKey: "", baseUrl: "", model: "" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDeEnv>();
  return {
    env: {
      ...real.env,
      get TRANSCRIPTION_API_KEY() {
        return transcricaoDoEnv.apiKey;
      },
      get TRANSCRIPTION_BASE_URL() {
        return transcricaoDoEnv.baseUrl;
      },
      get TRANSCRIPTION_MODEL() {
        return transcricaoDoEnv.model;
      },
      TRANSCRIPTION_LANGUAGES: "",
    },
  };
});
// O banco responde por TABELA: vazio por padrão, e o caso da #2190 preenche a
// credencial e o padrão da organização.
const banco = vi.hoisted(() => ({
  lista: {} as Record<string, unknown[]>,
  unica: {} as Record<string, unknown>,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: banco.unica[tabela] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: banco.lista[tabela] ?? [], error: null }).then(ok, erro),
      };
      for (const m of ["select", "eq", "is", "not", "order", "limit"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/ai/providers/route";

type Ponto = { id: string; efetivo: { modelId: string | null } };

async function pontos(): Promise<Ponto[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { pontos: Ponto[] } }).data.pontos;
}

function modeloDo(lista: Ponto[], id: string): string | null {
  const ponto = lista.find((p) => p.id === id);
  expect(ponto, `ponto ${id} sumiu do painel`).toBeDefined();
  return ponto!.efetivo.modelId;
}

beforeEach(() => {
  vi.clearAllMocks();
  banco.lista = {};
  banco.unica = {};
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "actor", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// As três chaves juntas, sempre: um `.env.local` com TRANSCRIPTION_BASE_URL
// mudaria o que a tela anuncia e o caso mediria a máquina, não o código.
function comTranscricaoNoEnv(t: { model: string; apiKey?: string; baseUrl?: string }): void {
  transcricaoDoEnv.model = t.model;
  transcricaoDoEnv.apiKey = t.apiKey ?? "";
  transcricaoDoEnv.baseUrl = t.baseUrl ?? "";
  // A escada só entra no degrau OpenAI se EXISTIR chave OpenAI — e é essa a
  // pergunta que a tela, como o worker, precisa responder (#2190). Sem esta
  // chave os casos abaixo cairiam no degrau do modelo de conversa (a
  // organização mockada não tem padrão nenhum) e anunciariam "—".
  vi.stubEnv("OPENAI_API_KEY", "chave-openai-de-controle");
}

describe("GET /api/v1/ai/providers — modelo de transcrição em vigor", () => {
  it("sem TRANSCRIPTION_MODEL, anuncia whisper-1 — o de sempre", async () => {
    comTranscricaoNoEnv({ model: "" });
    expect(modeloDo(await pontos(), "transcricao_de_audio")).toBe("whisper-1");
  });

  it("com TRANSCRIPTION_MODEL, anuncia o modelo do .env — e só no ponto de transcrição", async () => {
    comTranscricaoNoEnv({ model: "gpt-transcribe" });
    const lista = await pontos();
    expect(modeloDo(lista, "transcricao_de_audio")).toBe("gpt-transcribe");
    const outros = lista.filter((p) => p.id !== "transcricao_de_audio");
    expect(outros.length).toBeGreaterThan(0);
    expect(outros.map((p) => p.efetivo.modelId)).not.toContain("gpt-transcribe");
  });

  it("modelo de outro serviço (BASE_URL sem API_KEY) não é o que roda: anuncia whisper-1", async () => {
    comTranscricaoNoEnv({ model: "whisper-large-v3", baseUrl: "https://api.groq.com/openai/v1" });
    expect(modeloDo(await pontos(), "transcricao_de_audio")).toBe("whisper-1");
  });
});

describe("GET /api/v1/ai/providers — a organização da #2190 (Gemini, sem OpenAI)", () => {
  it("anuncia o modelo de conversa da organização, e não whisper-1", async () => {
    // Nenhuma chave OpenAI em lugar nenhum: nem na instalação, nem na org.
    transcricaoDoEnv.model = "";
    transcricaoDoEnv.apiKey = "";
    transcricaoDoEnv.baseUrl = "";
    vi.stubEnv("OPENAI_API_KEY", "");
    banco.lista.ai_provider_credentials = [
      { id: "cred-g", provider: "google", validated_at: "2026-10-01T00:00:00Z", is_active: true },
    ];
    banco.unica.organizations = {
      settings: { llm: { provider: "google", default_model: "gemini-3.5-flash" } },
    };

    const lista = (await (await GET()).json()) as {
      data: { pontos: { id: string; efetivo: { provider: string; modelId: string | null } }[] };
    };
    const ponto = lista.data.pontos.find((p) => p.id === "transcricao_de_audio");
    expect(ponto, "ponto transcricao_de_audio sumiu do painel").toBeDefined();
    // É a rota que entrega o modelo de conversa à escada; se ela deixar de
    // entregar, a escada cai em "nada" e a tela diz "—" a quem transcreve.
    expect(ponto!.efetivo.modelId).toBe("gemini-3.5-flash");
    expect(ponto!.efetivo.provider).toBe("google");
  });
});
