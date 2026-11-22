/**
 * O ESTADO DA TELA com a marca "Não enviar aviso de caso" (#4989): é a mesma
 * função que o GET da rota devolve.
 *
 * Duas respostas diferentes que a tela precisa distinguir: "ninguém está
 * marcado" e "não deu para ler quem está marcado". A segunda trava os
 * interruptores — senão a tela mostraria todos desligados e um clique
 * "desmarcaria" quem a pessoa nunca viu marcado.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: vi.fn(async () => []) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, `Nome ${id.slice(0, 4)}`]))),
}));

const { lerEstadoDaTelaDeAviso } = await import("@/lib/escalacao/tela-do-aviso");

const ORG = "11111111-1111-4111-8111-111111111111";
const ANA = "5f000000-0000-4000-8000-00000000a001";
const FILA = "5f000000-0000-4000-8000-00000000a002";

type Resposta = { data: unknown; error: { message: string } | null };

/** Um client que responde por tabela; o que não foi pedido volta vazio. */
function clienteFalso(tabelas: Record<string, { lista?: Resposta; uma?: Resposta }> = {}) {
  const from = vi.fn((tabela: string) => {
    const t = tabelas[tabela] ?? {};
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit", "gte", "lte", "not", "neq", "or", "filter", "lt", "gt"]) {
      c[m] = () => c;
    }
    c.maybeSingle = async () => t.uma ?? { data: null, error: null };
    c.single = async () => t.uma ?? { data: null, error: null };
    c.then = (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
      Promise.resolve(t.lista ?? { data: [], error: null }).then(ok, falha);
    return c;
  });
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) } as never;
}

const EQUIPE = {
  lista: {
    data: [
      { user_id: ANA, whatsapp_e164: "+5531988881111" },
      { user_id: FILA, whatsapp_e164: null },
    ],
    error: null,
  },
};

describe("a equipe no estado da tela", () => {
  it("cada membro vem com a marca lida de organizations.settings", async () => {
    const estado = await lerEstadoDaTelaDeAviso({
      db: clienteFalso(),
      admin: clienteFalso({
        user_organizations: EQUIPE,
        organizations: {
          uma: { data: { settings: { aviso_de_caso_nao_avisar: { user_ids: [FILA] } } }, error: null },
        },
      }),
      organizationId: ORG,
      urlPublica: "https://crm.exemplo.com.br",
    });
    expect(estado.equipe.map((m) => [m.user_id, m.nao_avisar])).toEqual([
      [ANA, false],
      [FILA, true],
    ]);
    expect(estado.nao_avisar_indisponivel).toBe(false);
    // A FILA está entre os vínculos ativos lidos: há alguém marcado.
    expect(estado.algum_membro_sem_aviso).toBe(true);
  });

  it("a marca não pôde ser lida: a equipe vem, e a resposta diz que a marca está indisponível", async () => {
    const estado = await lerEstadoDaTelaDeAviso({
      db: clienteFalso(),
      admin: clienteFalso({
        user_organizations: EQUIPE,
        organizations: { uma: { data: null, error: { message: "statement timeout" } } },
      }),
      organizationId: ORG,
      urlPublica: "https://crm.exemplo.com.br",
    });
    expect(estado.equipe).toHaveLength(2);
    expect(estado.nao_avisar_indisponivel).toBe(true);
  });
});
