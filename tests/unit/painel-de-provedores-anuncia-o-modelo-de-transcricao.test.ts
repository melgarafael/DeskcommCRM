/**
 * GET /api/v1/ai/providers — o ponto "Ouvir o áudio" anuncia o modelo que RODA.
 *
 * O ponto fixo de transcrição declara `whisper-1`, mas `TRANSCRIPTION_MODEL` (o
 * mesmo `.env` do app e do worker) troca o modelo que o worker usa — inclusive
 * com a chave da OpenAI da organização. A tela lia só o ponto e dizia
 * `whisper-1` com outro modelo em uso. Agora ela lê pela mesma função do worker
 * (`modeloDeTranscricaoEmVigor`), e este arquivo mede as duas pontas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(ok, erro),
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
  vi.stubEnv("TRANSCRIPTION_MODEL", t.model);
  vi.stubEnv("TRANSCRIPTION_API_KEY", t.apiKey ?? "");
  vi.stubEnv("TRANSCRIPTION_BASE_URL", t.baseUrl ?? "");
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
