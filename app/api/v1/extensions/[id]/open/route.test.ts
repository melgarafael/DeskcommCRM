import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { CAPACIDADES_DE_PORTA, PORTA_DA_CAPACIDADE } from "@/lib/extensions/capacidades";
import { loadExtensionGuide } from "@/lib/extensions/service";
import { requireSupportWrite } from "@/lib/impersonate/support";

import { POST } from "./route";

/**
 * O DESTINO DO CLIQUE SAI DA CAPACIDADE PEDIDA — não de um literal.
 *
 * ─── O defeito, medido em tela ──────────────────────────────────────────────
 *
 * Esta rota devolvia `{ href: "/app/tasks" }` escrito no código. Com o schema do pedido ainda
 * preso em `tasks.open`, o furo ficava escondido atrás de uma recusa: o botão não abria NADA.
 * Consertado o schema, o furo apareceu inteiro — o clique em `inbox.open` navegava para
 * `/app/tasks`. Seis portas viravam seis botões que abrem Tarefas, que é o contrário do que o
 * perfil v2 promete.
 *
 * ─── Por que este arquivo, e não só o do vocabulário ────────────────────────
 *
 * `tests/unit/caminho-da-porta-aceita-o-vocabulario-inteiro.test.ts` prova que cada capacidade
 * é ACEITA em cada ponto. Aceitar não é resolver: a rota aceitava as seis e respondia uma. A
 * diferença só aparece em quem responde o HTTP, e é o que este arquivo exercita.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/extensions/service", () => ({ loadExtensionGuide: vi.fn() }));

const org = "30000000-0000-4000-8000-000000000001";
const instalacao = "30000000-0000-4000-8000-000000000002";
const CARD = "um-cartao";

function pedido(capability: string) {
  return new Request(`http://localhost/api/v1/extensions/${instalacao}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Expected-Organization-Id": org },
    body: JSON.stringify({ capability, expected_revision: 1, card_id: CARD }),
  });
}

const contexto = { params: Promise.resolve({ id: instalacao }) };

function guiaCom(capability: string) {
  return {
    revision: 1,
    manifest: { contributions: { crm_cards: [{ id: CARD, action: { capability } }] } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: org },
    org: { orgId: org },
  } as never);
});

describe("a rota do clique resolve o destino pela capacidade", () => {
  // Só as capacidades de PORTA: as de EFEITO (`turn.*`) não navegam, e o pedido de abertura as
  // recusa — é `tests/unit/caminho-da-porta-aceita-o-vocabulario-inteiro.test.ts` que prova esse
  // outro lado. Percorrer o vocabulário inteiro aqui pediria um destino que não existe.
  it.each([...CAPACIDADES_DE_PORTA])("%s abre a porta dela, não Tarefas", async (capacidade) => {
    vi.mocked(loadExtensionGuide).mockResolvedValue(guiaCom(capacidade) as never);

    const resposta = await POST(pedido(capacidade), contexto);
    const corpo = (await resposta.json()) as { data?: { href?: string } };

    expect(resposta.status).toBe(200);
    expect(
      corpo.data?.href,
      `${capacidade} devolveu ${corpo.data?.href}: o botão leva a pessoa para o lugar errado`,
    ).toBe(PORTA_DA_CAPACIDADE[capacidade].destino);
  });

  it("controle: os seis destinos são distintos", () => {
    // Sem este caso, um handler que devolvesse sempre o mesmo href passaria no anterior se o
    // mapa também apontasse tudo para um lugar só — que é exatamente o defeito que houve.
    const destinos = CAPACIDADES_DE_PORTA.map((c) => PORTA_DA_CAPACIDADE[c].destino);
    expect(new Set(destinos).size).toBe(destinos.length);
  });

  it("o card da versão instalada manda: capacidade divergente é recusada", async () => {
    // O pacote nomeia a capacidade no pedido, mas quem decide é o card JÁ instalado.
    vi.mocked(loadExtensionGuide).mockResolvedValue(guiaCom("tasks.open") as never);

    const resposta = await POST(pedido("inbox.open"), contexto);

    expect(resposta.status).not.toBe(200);
  });
});
