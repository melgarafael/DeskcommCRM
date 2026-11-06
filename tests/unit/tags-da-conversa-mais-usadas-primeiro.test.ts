import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

/**
 * A ORDEM DAS SUGESTÕES DE ETIQUETA DA CONVERSA É A DE USO (#3180).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `GET /api/v1/conversation-tags` devolvia a união (sementes da organização +
 * o que está em uso) em ORDEM ALFABÉTICA. O editor de etiquetas da conversa
 * (`ConversationTagsEditor`) sugere as primeiras dessa lista quando o campo
 * está vazio — então eram sempre as mesmas oito do começo do alfabeto, com 73
 * etiquetas na organização. O que serve de sugestão é o que a equipe MAIS usa.
 *
 * ─── Por que o caso da amostra importa ──────────────────────────────────────
 *
 * A lista continua vindo de `fn_tags_de_conversa_em_uso` (todas as conversas,
 * teto de 200 na própria função); a leitura das conversas só ORDENA. E ela é
 * uma AMOSTRA: além do teto, ordem por `updated_at` descendente, como a rota
 * irmã `/api/v1/contact-tags` já documenta. Se essa leitura falhar, a lista
 * continua inteira (quem respondeu foi a função) e a ORDEM volta a ser
 * alfabética — o caso 2 prova as duas metades disso.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { warn: logWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const ORG = "org-1";

type Conversa = { tags: string[] | null; updated_at?: string };

function bancoFalso(args: {
  canonicas?: string[];
  emUso?: string[];
  conversas?: Conversa[];
  erroDaContagem?: { message: string } | null;
}) {
  const from = (tabela: string) => {
    if (tabela === "organizations") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { settings: { canonical_conversation_tags: args.canonicas ?? [] } },
              error: null,
            }),
          }),
        }),
      };
    }
    // `conversations`: só a contagem de uso. O recorte da organização é da RLS
    // (o client é o da sessão), então o dublê não filtra — o que ele honra é o
    // `limit`, que é o teto da amostra.
    let limite = Infinity;
    const chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      order: () => chain,
      limit: (n: number) => ((limite = n), chain),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: args.erroDaContagem ? null : (args.conversas ?? []).slice(0, limite),
          error: args.erroDaContagem ?? null,
        }).then(res),
    };
    return chain;
  };
  return {
    from,
    rpc: async () => ({
      data: (args.emUso ?? []).map((tag) => ({ tag })),
      error: null,
    }),
  } as never;
}

async function chamaRota() {
  const { GET } = await import("@/app/api/v1/conversation-tags/route");
  const res = await GET(new NextRequest("http://x/api/v1/conversation-tags"));
  return { status: res.status, body: (await res.json()) as { data?: string[] } };
}

beforeEach(() => {
  logWarn.mockReset();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, name: "Org", role: "agent" },
  } as never);
});

describe("GET /api/v1/conversation-tags", () => {
  it("as mais usadas vêm primeiro, não as primeiras do alfabeto", async () => {
    // Alfabeto e uso em ordens DIFERENTES: "zebra" é a mais usada, "abelha" a
    // menos, e a semente do vocabulário não está em conversa nenhuma.
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({
        canonicas: ["aaa-semente"],
        emUso: ["abelha", "zebra", "aaa-semente"],
        conversas: [{ tags: ["zebra"] }, { tags: ["zebra"] }, { tags: ["abelha"] }],
      }),
    );

    const { status, body } = await chamaRota();

    expect(status).toBe(200);
    // A mais usada primeiro; as de uso zero (a semente) descem juntas, em ordem
    // alfabética — nada desaparece da lista.
    expect(body.data).toEqual(["zebra", "abelha", "aaa-semente"]);
  });

  it("a lista sai inteira e a contagem para no teto da amostra", async () => {
    // A amostra tem teto (1000): as "abelha" são mil conversas recentes e as
    // "zebra" ficam FORA do corte. Quem apagar o `.limit` faz a zebra virar a
    // mais usada e a ordem inverte — é este caso que segura o teto.
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({
        emUso: ["abelha", "zebra"],
        conversas: [
          ...Array.from({ length: 1000 }, () => ({ tags: ["abelha"] })),
          ...Array.from({ length: 2000 }, () => ({ tags: ["zebra"] })),
        ],
      }),
    );

    const { body } = await chamaRota();

    expect(body.data).toEqual(["abelha", "zebra"]);
  });

  it("falha na contagem não derruba a lista: ordem alfabética e a causa no log", async () => {
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({
        canonicas: ["aaa-semente"],
        emUso: ["abelha", "zebra"],
        erroDaContagem: { message: "boom" },
      }),
    );

    const { status, body } = await chamaRota();

    // A resposta existe e está completa: quem respondeu QUAIS etiquetas existem
    // foi a função do banco. Só a ordem se perde — e a perda vai para o log em
    // vez de virar um 500 sobre uma lista que está lá.
    expect(status).toBe(200);
    expect(body.data).toEqual(["aaa-semente", "abelha", "zebra"]);
    expect(logWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ orgId: ORG, cause: "boom" }),
    );
  });
});
