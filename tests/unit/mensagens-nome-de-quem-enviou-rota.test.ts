/**
 * A ROTA DO HISTÓRICO ENTREGA O NOME DE QUEM ENVIOU (#4031).
 *
 * O balão só desenha o que recebe: ele não faz consulta. Então o lugar de
 * provar que "Atendente · Andreia" aparece de verdade é AQUI — o campo tem de
 * sair no JSON de `GET /api/v1/conversations/[id]/messages`, e a leitura do
 * nome tem de acontecer UMA vez por página.
 *
 * Mocks: o handler de mensagens (que faz a consulta RLS e a paginação, coberto
 * por `tests/invariants/messages-list-paginacao.test.ts`), a sessão e o portão
 * de organização. O enriquecimento é o código REAL — mocká-lo provaria o mock.
 * A única dependência externa substituída é o GoTrue Admin API
 * (`nomesDosAtendentes`), que o dublê troca por um mapa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import { GET } from "@/app/api/v1/conversations/[id]/messages/route";
import type { Message } from "@/lib/types/messaging";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ listMessagesHandler: vi.fn() }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const CONVERSA = "11111111-1111-4111-8111-111111111111";

function mensagem(over: Partial<Message>): Message {
  return {
    id: "m1",
    organization_id: "org-1",
    conversation_id: CONVERSA,
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "outbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "texto",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-11-05T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-11-05T12:00:00.000Z",
    ...over,
  };
}

let ultimasOrgsConferidas: string[] = [];

const rodar = () =>
  GET(new NextRequest(`https://crm.example/api/v1/conversations/${CONVERSA}/messages?limit=50`), {
    params: Promise.resolve({ id: CONVERSA }),
  });

beforeEach(() => {
  vi.mocked(nomesDosAtendentes).mockReset();
  vi.mocked(listMessagesHandler).mockReset();
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "u-eu" } }, error: null }) },
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue({ id: "u-eu", idioma: "pt-BR" } as never);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({ ok: true, org: { orgId: "org-1" } } as never);
  // `user_organizations` da org ativa: as duas consultoras são membros.
  const orgsConferidas: string[] = [];
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: (_c: string, orgId: string) => {
          orgsConferidas.push(orgId);
          return {
            in: async (_c2: string, ids: string[]) => ({
              data: orgId === "org-1" ? ids.map((user_id) => ({ user_id })) : [],
              error: null,
            }),
          };
        },
      }),
    }),
  } as never);
  ultimasOrgsConferidas = orgsConferidas;
  vi.mocked(nomesDosAtendentes).mockResolvedValue(
    new Map([
      ["u-andreia", "Andreia Cristina de Souza"],
      ["u-thamyres", "Thamyres Lima"],
    ]),
  );
});

describe("#4031 — o histórico entrega o nome de quem enviou", () => {
  it("o payload traz sent_by_user_name das duas consultoras e mantém a IA sem nome de gente", async () => {
    vi.mocked(listMessagesHandler).mockResolvedValue({
      messages: [
        mensagem({ id: "m-andreia", sent_by_user_id: "u-andreia" }),
        mensagem({
          id: "m-ia",
          sent_via: "ai",
          sent_by_user_id: null,
          metadata: { ai_actor_name: "Clara" },
        }),
        mensagem({ id: "m-thamyres", sent_by_user_id: "u-thamyres" }),
      ],
      cursor: "abc",
      has_more: true,
    });

    const body = (await (await rodar()).json()) as {
      data: Message[];
      meta: { cursor: string; has_more: boolean };
    };

    expect(body.data.map((m) => [m.id, m.sent_by_user_name])).toEqual([
      ["m-andreia", "Andreia Cristina de Souza"],
      ["m-ia", null],
      ["m-thamyres", "Thamyres Lima"],
    ]);
    expect(body.meta).toEqual({ cursor: "abc", has_more: true });
  });

  it("a leitura do nome é UMA por página — 50 mensagens de 2 pessoas não viram 50 consultas", async () => {
    const pagina = Array.from({ length: 50 }, (_, i) =>
      mensagem({ id: `m${i}`, sent_by_user_id: i % 2 === 0 ? "u-andreia" : "u-thamyres" }),
    );
    vi.mocked(listMessagesHandler).mockResolvedValue({
      messages: pagina,
      cursor: null,
      has_more: false,
    });

    const body = (await (await rodar()).json()) as { data: Message[] };

    expect(body.data).toHaveLength(50);
    expect(vi.mocked(nomesDosAtendentes)).toHaveBeenCalledOnce();
    expect(vi.mocked(nomesDosAtendentes).mock.calls[0]![1]).toEqual(["u-andreia", "u-thamyres"]);
    // A conferência de membros usa a org ATIVA resolvida pela rota, uma vez.
    expect(ultimasOrgsConferidas).toEqual(["org-1"]);
  });

  it("página sem mensagem de pessoa não consulta o GoTrue", async () => {
    vi.mocked(listMessagesHandler).mockResolvedValue({
      messages: [mensagem({ id: "m-ia", sent_via: "ai", sent_by_user_id: null })],
      cursor: null,
      has_more: false,
    });

    await rodar();

    expect(vi.mocked(nomesDosAtendentes)).not.toHaveBeenCalled();
  });
});
