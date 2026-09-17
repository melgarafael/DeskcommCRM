import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

/**
 * Tags do CONTATO sem sugestão (#852, item 1 da divisão). O editor de tags da
 * conversa já oferecia as tags em uso; o do contato obrigava a digitar do zero,
 * e cada operador criava a sua variação ("google", "gogle", "google ads").
 *
 * Dois lados, porque um sem o outro não resolve:
 *  - a ROTA precisa devolver as tags que existem, só da organização da sessão;
 *  - o EDITOR precisa oferecê-las e gravar a escolhida.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ logger: { error: logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const ORG = "org-1";
type Linha = Record<string, unknown>;
/**
 * Aplica `eq`, `neq` (com `{}` = lista vazia), `order` e `limit`: um dublê que
 * os ignorasse vazaria a outra organização — e, no caso de `order`/`limit`,
 * deixaria passar uma rota que lê a tabela INTEIRA de contatos.
 */
function bancoFalso(linhas: Linha[], erro: { message: string } | null = null) {
  const from = () => {
    let rows = [...linhas];
    let limite = Infinity;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => ((rows = rows.filter((l) => l[col] === val)), chain),
      neq: (col: string, val: unknown) => {
        rows = rows.filter((l) => (val === "{}" ? (l[col] as unknown[]).length > 0 : l[col] !== val));
        return chain;
      },
      order: (col: string, o: { ascending: boolean }) => {
        rows = [...rows].sort(
          (x, y) => String(x[col]).localeCompare(String(y[col])) * (o.ascending ? 1 : -1),
        );
        return chain;
      },
      limit: (n: number) => ((limite = n), chain),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: erro ? null : rows.slice(0, limite), error: erro }).then(res),
    };
    return chain;
  };
  return { from } as never;
}

async function chamaRota() {
  const { GET } = await import("@/app/api/v1/contact-tags/route");
  const res = await GET(new NextRequest("http://x/api/v1/contact-tags"));
  return {
    status: res.status,
    body: (await res.json()) as { data?: string[]; error?: { message: string } },
  };
}

beforeEach(() => {
  logError.mockReset();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG, name: "Org", role: "agent" } } as never);
});

describe("GET /api/v1/contact-tags", () => {
  it("devolve as tags em uso nos contatos da organização, sem repetir e em ordem", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso([
      { organization_id: ORG, tags: ["vip", "google"] },
      { organization_id: ORG, tags: ["google"] },
      { organization_id: ORG, tags: [] },
      { organization_id: "org-2", tags: ["segredo-de-outra-org"] },
    ]));

    const { status, body } = await chamaRota();

    expect(status).toBe(200);
    expect(body.data).toEqual(["google", "vip"]);
  });

  /**
   * O rótulo do chip tem de dizer exatamente o que o clique grava. Cru, "VIP",
   * "vip " e "vip" viravam TRÊS chips que gravam a MESMA tag — e os dois
   * primeiros nunca sumiam da tela, porque o filtro do editor compara com
   * sensibilidade a caixa. Controle decorativo, e a duplicação que a sugestão
   * veio impedir. Os três exemplos são os da própria issue #852.
   */
  it("normaliza como o editor grava: 'VIP', 'vip ' e 'vip' são UMA tag", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso([
      { organization_id: ORG, tags: ["VIP"] },
      { organization_id: ORG, tags: ["vip "] },
      { organization_id: ORG, tags: ["vip"] },
    ]));

    const { status, body } = await chamaRota();

    expect(status).toBe(200);
    expect(body.data).toEqual(["vip"]);
  });

  /**
   * `.order("updated_at", { ascending: false })` e `.limit(1000)` são UMA
   * decisão só — "os mil contatos com tag mais recentes" — e nenhuma das duas
   * metades era medida: o dublê no-opava a ordenação e a fixture tinha 4 linhas
   * contra um teto de 1000, então o corte nunca era exercitado.
   *
   * Apagar o `.limit` faz a rota ler a tabela inteira de contatos de uma
   * organização grande para montar oito chips. Apagar o `.order` troca "as mais
   * recentes" por "as mil que o Postgres devolver primeiro", que numa tabela com
   * churn é justamente o lixo antigo. As duas ficavam verdes.
   *
   * A fixture tem 1001 linhas, e o contato ANTIGO é o PRIMEIRO da lista: sem
   * ordenação ele entra no corte; sem corte ele entra por não haver corte.
   */
  it("lê os contatos mais recentes e para no teto: a tag antiga não entra", async () => {
    const antigo = { organization_id: ORG, tags: ["antiga"], updated_at: "2020-01-01T00:00:00.000Z" };
    const recentes = Array.from({ length: 1000 }, () => ({
      organization_id: ORG, tags: ["recente"], updated_at: "2026-09-15T12:00:00.000Z",
    }));
    vi.mocked(createClient).mockResolvedValue(bancoFalso([antigo, ...recentes]));

    const { status, body } = await chamaRota();

    expect(status).toBe(200);
    expect(body.data).toEqual(["recente"]);
  });

  /**
   * O teto de 200 tags no corpo. A fixture de 4 linhas nunca o alcançava, e o
   * editor ainda corta em 8 na tela — mas quem responde pelo tamanho da resposta
   * é a rota, e sem este caso o `.slice(TETO_DE_TAGS)` podia sumir sem doer.
   */
  it("devolve no máximo 200 tags, as primeiras em ordem", async () => {
    const muitas = Array.from({ length: 250 }, (_, i) => `tag-${String(i).padStart(3, "0")}`);
    vi.mocked(createClient).mockResolvedValue(bancoFalso([
      { organization_id: ORG, tags: muitas, updated_at: "2026-09-15T12:00:00.000Z" },
    ]));

    const { status, body } = await chamaRota();

    expect(status).toBe(200);
    expect(body.data).toHaveLength(200);
    expect(body.data?.[199]).toBe("tag-199");
    expect(body.data).not.toContain("tag-200");
  });

  it("falha na leitura vira erro, não lista vazia", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso([], { message: "boom" }));

    const { status } = await chamaRota();

    expect(status).toBe(500);
  });

  /**
   * Fechada na AÇÃO, aberta na INFORMAÇÃO. A mensagem crua do Postgres é para
   * quem opera a instalação, não para o navegador; e trocá-la por uma frase
   * fixa SEM registrar a causa deixaria o operador com um 500 mudo e nenhum
   * lugar onde procurar — pior que o estado anterior. Os dois lados juntos,
   * porque separados um estraga o outro.
   */
  it("o cliente recebe a frase do produto e o log recebe a causa", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso([], { message: "permission denied for table contacts" }));

    const { body } = await chamaRota();

    expect(body.error?.message).toBe("Não foi possível carregar as tags.");
    expect(JSON.stringify(body)).not.toContain("permission denied");
    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cause: "permission denied for table contacts", orgId: ORG }),
    );
  });
});
