/**
 * NOTA DE VOZ DA IA NUM CANAL QUE NÃO A ENTREGA — Instagram/Facebook.
 *
 * ─── O defeito, do jeito que o dono viveu ───────────────────────────────────
 *
 * Instalação real, 15/11/2026: agente com "Enviar nota de voz" ligado, atendendo
 * uma DM de Instagram que chegou como áudio. O agente sintetizava mp3 e mandava
 * pelo provedor; o provedor respondia HTTP 400 em TODA tentativa ("O provedor não
 * concluiu a operação (HTTP 400)"). Texto, no mesmo canal, saía. E a fila
 * re-tentava o turno com envio `failed`, então cada volta deixava mais uma bolha
 * de áudio falhada na conversa. O dono desligou a voz do agente para contornar.
 *
 * A causa era a matriz: a rede social declarava `voiceNote: "server-convert"`
 * ("o canal converte áudio"), e a Meta não aceita mp3 (nem ogg/opus) em DM do
 * Instagram — só aac, m4a, wav e mp4. O canal passa a declarar `none`.
 *
 * ─── O que se cobra aqui ───────────────────────────────────────────────────
 *
 *  1. a matriz: as redes sociais (e o bot do Telegram, cujo adapter recusa
 *     todo envio que não seja texto) não prometem nota de voz;
 *  2. o formato: canal `none` não tem formato de síntese — `null`, não um
 *     formato "de reserva" que pagaria uma bolha falhada;
 *  3. a lista de canais da tela leva a capacidade (`enviaNotaDeVoz`);
 *  4. a tela do agente avisa, ao lado da chave de voz, que naquele canal a
 *     resposta sai em texto — e só quando a voz está ligada E o canal não fala.
 *
 * A decisão do turno (o agente não sintetiza nem consome orçamento num canal
 * `none`) está em `tests/unit/resolver-voz-do-turno.test.ts`, junto com os
 * outros casos de `resolverVozDoTurno`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_SOCIAL,
  CHANNEL_PROVIDER_TELEGRAM,
  PROVIDERS_DE_MENSAGEM,
  capabilitiesOf,
} from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { formatoDaVozParaCanal } from "@/lib/ai/voz/formato";
import { listSelectableChannels } from "@/lib/channels/selectable";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CANAL = "22222222-2222-4222-8222-222222222222";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/app/ai/agents/${AGENTE}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: vi.fn(),
  publishAgentAction: vi.fn(),
  createMcpAgentAction: vi.fn(),
}));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

describe("matriz — quem entrega nota de voz da IA", () => {
  it("rede social (Instagram/Facebook) declara `none`: a Meta recusa mp3 e ogg/opus em DM", () => {
    expect(capabilitiesOf(CHANNEL_PROVIDER_SOCIAL).voiceNote).toBe("none");
  });

  it("bot do Telegram declara `none`: o adapter da v1 recusa todo envio que não seja texto", async () => {
    expect(capabilitiesOf(CHANNEL_PROVIDER_TELEGRAM).voiceNote).toBe("none");
    // A declaração tem de bater com o adapter: se a T2 passar a mandar áudio,
    // este caso fica vermelho e a capability muda junto.
    await expect(
      getAdapter(CHANNEL_PROVIDER_TELEGRAM).send({
        kind: "audio",
        to: "1",
        sessionRef: "s",
        organizationId: ORG,
        media: { url: "https://exemplo.test/a.ogg", mime: "audio/ogg" },
      } as never),
    ).rejects.toThrow(/telegram_media_not_supported/);
  });

  it("os canais de WhatsApp seguem falando — o conserto não cala quem entrega", () => {
    const quemFala = PROVIDERS_DE_MENSAGEM.filter((p) => CHANNEL_CAPABILITIES[p].voiceNote !== "none");
    expect([...quemFala].sort()).toEqual(["datafy", "meta_cloud", "waha", "zernio"]);
  });
});

describe("formato da síntese por canal", () => {
  it("canal `none` não tem formato: nenhuma síntese é pedida", () => {
    expect(formatoDaVozParaCanal("none")).toBeNull();
  });

  it("os outros dois seguem como antes", () => {
    expect(formatoDaVozParaCanal("server-convert")).toBe("mp3");
    expect(formatoDaVozParaCanal("opus-only")).toBe("ogg_opus");
  });
});

/** Client falso: devolve as linhas pedidas para qualquer consulta encadeada. */
function dbCom(linhas: Record<string, unknown>[]): SupabaseClient {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "order"]) b[m] = () => b;
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(resolve);
  return { from: () => b } as unknown as SupabaseClient;
}

describe("lista de canais da tela — `enviaNotaDeVoz`", () => {
  const linha = (id: string, provider: string) => ({
    id,
    display_name: id,
    status: "WORKING",
    phone_number: null,
    waha_session_name: null,
    provider,
    metadata: null,
  });

  it("vem da capability, nunca do nome do provedor", async () => {
    const canais = await listSelectableChannels(
      dbCom([
        linha("pareado", "waha"),
        linha("oficial", "meta_cloud"),
        linha("instagram", CHANNEL_PROVIDER_SOCIAL),
        linha("futuro", "provedor_que_este_build_nao_conhece"),
      ]),
      ORG,
    );
    const porId = Object.fromEntries(canais.map((c) => [c.id, c.enviaNotaDeVoz]));
    expect(porId).toEqual({ pareado: true, oficial: true, instagram: false, futuro: false });
  });
});

const AGENTE_ROW = {
  id: AGENTE,
  organization_id: ORG,
  name: "Sofia",
  description: "assistente",
  priority: 0,
  model: "claude-sonnet-5",
  system_prompt: "x",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: null,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function rascunho(vozEnabled: boolean) {
  return {
    id: "v1",
    organization_id: ORG,
    agent_id: AGENTE,
    version_number: 1,
    status: "draft",
    system_prompt: "Você é a Sofia, assistente da loja. Atenda com acolhimento.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    credential_id: null,
    tool_ids: [],
    channel_session_id: CANAL,
    max_steps: 10,
    token_budget: 50000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    cases_enabled: false,
    split_messages: false,
    split_max_chars: 600,
    followup: { enabled: false, flow_pointer_ids: [] },
    voz_enabled: vozEnabled,
    voz_quando: "espelhar",
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    knowledge_source_ids: [],
    trigger_config: null,
    published_at: null,
    superseded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
  };
}

function abrirEditor(opcoes: { vozEnabled: boolean; enviaNotaDeVoz: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const canal = {
    id: CANAL,
    display_name: "Instagram da loja",
    status: "WORKING",
    phone_number: null,
    aceitaMensagemLivre: false,
    reportaConversao: false,
    enviaNotaDeVoz: opcoes.enviaNotaDeVoz,
    acessoDaAi: { mode: "open", testNumbersCount: 0 },
  };
  const versao = rascunho(opcoes.vozEnabled);
  render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE_ROW as never}
        credentials={[] as never}
        provedoresDaInstalacao={["anthropic"]}
        channelSessions={[canal] as never}
        draft={versao as never}
        published={null}
        base={versao as never}
        draftObsoleto={null}
      />
    </QueryClientProvider>,
  );
}

describe("tela do agente — voz ligada num canal que não entrega nota de voz", () => {
  it("avisa que ali a resposta sai em texto", () => {
    abrirEditor({ vozEnabled: true, enviaNotaDeVoz: false });
    expect(screen.getByTestId("voz-canal-sem-nota")).toHaveTextContent(/responde em texto/i);
  });

  it("canal que entrega nota de voz: nenhum aviso", () => {
    abrirEditor({ vozEnabled: true, enviaNotaDeVoz: true });
    expect(screen.queryByTestId("voz-canal-sem-nota")).toBeNull();
  });

  it("voz desligada: nenhum aviso — não há o que explicar", () => {
    abrirEditor({ vozEnabled: false, enviaNotaDeVoz: false });
    expect(screen.queryByTestId("voz-canal-sem-nota")).toBeNull();
  });
});
