/**
 * O {{nome}} das respostas prontas chega até o cliente final pela MESMA régua
 * de `nomeDoContato` que o Inbox e o kanban usam: `name` primeiro, depois o
 * `display_name` do perfil do WhatsApp.
 *
 * Motivo (issue #3000): o `select` do contato em
 * `lib/operacao/modelos-de-mensagem.ts:293` trazia só `id, name, phone_number,
 * email` — sem `display_name`. Quando um contato chegava pelo WhatsApp com
 * `name` nulo (o normal antes do atendente preencher a ficha), o render
 * resolvia `{{nome}}` para string vazia e a mensagem saía "Olá , tudo bem?"
 * mesmo com o `display_name` gravado pela ingestão (`pushName` do aparelho).
 *
 * A prova aqui: contato com `name: null` e `display_name` preenchido tem que
 * sair no lugar de `{{nome}}`. Sabotar o `select` (remover `display_name`)
 * derruba este caso — e só ele da suíte — porque a projeção do dublê filtra
 * a coluna que o render passa a não enxergar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { preencherModeloDeMensagem } from "@/lib/operacao/modelos-de-mensagem";
import { ORG_ID, makeDb } from "@/tests/helpers/stages-db-double";

const TOKEN: Actor = { type: "api_token", id: "tok-1" };

function deps(db: ReturnType<typeof makeDb>): DepsDaOperacao {
  return {
    supabase: db.client as unknown as SupabaseClient,
    organizationId: ORG_ID,
    actor: TOKEN,
    requestId: "req-1",
  };
}

function comModelo(corpo: string, contato?: Record<string, unknown>) {
  const db = makeDb();
  (db.tabelas as unknown as Record<string, unknown[]>).message_templates = [
    {
      id: "t-boasvindas",
      organization_id: ORG_ID,
      owner_user_id: null,
      title: "Boas-vindas",
      body: corpo,
    },
  ];
  (db.tabelas as unknown as Record<string, unknown[]>).contacts = contato ? [contato] : [];
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preencher modelo — {{nome}} pela régua de nomeDoContato", () => {
  it("⭐ {{nome}} resolve pelo display_name quando o contato do WhatsApp tem name nulo", async () => {
    // O caso do bug (#3000): contato recém-chegado pelo WhatsApp, `name` ainda
    // vazio (o atendente não preencheu a ficha), `display_name` gravado pela
    // ingestão (`pushName` do aparelho). Sem o `display_name` no `select` da
    // linha 293, o render não enxergava a coluna e devolvia "Olá , tudo bem?".
    const contato = {
      id: "c-wpp",
      organization_id: ORG_ID,
      name: null,
      display_name: "Marcos Silva",
      phone_number: "+5511999998888",
      email: null,
    };
    const db = comModelo("Olá {{nome}}, tudo bem?", contato);

    const r = await preencherModeloDeMensagem(deps(db), {
      templateId: "t-boasvindas",
      contactId: "c-wpp",
    });

    expect(r.texto).toBe("Olá Marcos Silva, tudo bem?");
    expect(r.lacunas).toEqual([]);
  });

  it("quando existe name, ele ganha de display_name (mesma régua de nomeDoContato)", async () => {
    // A ordem da régua é intencional (lib/contacts/rotulo-do-contato.ts):
    // `name` é o que o atendente cadastrou, `display_name` é o pushName do
    // aparelho. O render tem de respeitar.
    const contato = {
      id: "c-misto",
      organization_id: ORG_ID,
      name: "Marcos",
      display_name: "Máquina do Zé",
      phone_number: "+5511999998888",
      email: null,
    };
    const db = comModelo("Olá {{nome}}, tudo bem?", contato);

    const r = await preencherModeloDeMensagem(deps(db), {
      templateId: "t-boasvindas",
      contactId: "c-misto",
    });

    expect(r.texto).toBe("Olá Marcos, tudo bem?");
    expect(r.lacunas).toEqual([]);
  });

  it("name nulo e display_name vazio: {{nome}} vira lacuna, não string vazia escondida", async () => {
    // Sem nome de gente e sem pushName, a régua devolve `null` e o render
    // trata como lacuna — o operador VÊ o que falta antes de mandar.
    const contato = {
      id: "c-sem-nome",
      organization_id: ORG_ID,
      name: null,
      display_name: "Contato 543134@lid", // identificador técnico: a régua recusa
      phone_number: "+5511999998888",
      email: null,
    };
    const db = comModelo("Olá {{nome}}, tudo bem?", contato);

    const r = await preencherModeloDeMensagem(deps(db), {
      templateId: "t-boasvindas",
      contactId: "c-sem-nome",
    });

    expect(r.texto).toBe("Olá , tudo bem?");
    expect(r.lacunas).toEqual(["nome"]);
  });

  it("com texto de reserva, o nome vazio sai a reserva e não vira lacuna", async () => {
    const contato = {
      id: "c-sem-nome",
      organization_id: ORG_ID,
      name: null,
      display_name: "Contato 543134@lid",
      phone_number: "+5511999998888",
      email: null,
    };
    const db = comModelo('Olá {{nome|"aluno"}}, tudo bem?', contato);

    const r = await preencherModeloDeMensagem(deps(db), {
      templateId: "t-boasvindas",
      contactId: "c-sem-nome",
    });

    expect(r.texto).toBe("Olá aluno, tudo bem?");
    expect(r.lacunas).toEqual([]);
  });
});
