/**
 * #3023 — UMA régua de rótulo de membro, e nenhuma tela improvisando a sua.
 *
 * ─── O defeito, como a issue fotografou ─────────────────────────────────────
 *
 * Membro sem `full_name` no cadastro aparecia de cinco jeitos diferentes, e
 * quase todos com o `user_id` na tela: `Atendente 4fa3917a` (oito primeiros
 * dígitos do uuid) na transferência, na menção, no follow-up, nos planos, nos
 * webhooks e na agenda; o **uuid inteiro** na carteira do contato e na
 * auditoria; e `"Sem nome"` / `"Membro sem nome"` / `"Responsável"` no funil.
 * Quem transfere uma conversa não sabe quem é "Atendente 4fa3917a" — e o uuid
 * que sobra na tela é identificador interno que ninguém deveria ler.
 *
 * ─── A régua que este arquivo guarda ────────────────────────────────────────
 *
 * `rotuloDoMembro` (`lib/users/rotulo-do-atendente.ts`) decide, nesta ordem:
 * `full_name` → `email` → `"Atendente" + sufixo curto e estável do HASH do id`
 * → `"Atendente sem nome"`. Nunca o uuid inteiro, nunca o uuid cru, nunca os
 * oito primeiros caracteres dele.
 *
 * ─── O que cada bloco prova ────────────────────────────────────────────────
 *
 *  1. a régua, nos três casos pedidos (com nome, com e-mail, sem nada) e nos
 *     cantos (branco, sem id, estabilidade, hash ≠ prefixo do uuid);
 *  2. três TELAS da lista da issue mostrando o rótulo do helper — carteira do
 *     contato, formulário de tarefa interna do follow-up e ação de webhook
 *     (o ponto que tinha DOIS seletores);
 *  3. a cerca: nenhum arquivo de tela/rota volta a montar rótulo de membro com
 *     `full_name ?? <uuid>`. É leitura de fonte, de propósito: a classe de bug
 *     é "alguém escreveu o fallback de novo numa tela que nenhum teste de
 *     render toca", e só a varredura pega isso.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  membros: vi.fn(),
  carteira: vi.fn(),
  definir: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: deps.membros }));
vi.mock("@/hooks/contacts/useCarteiraDoContato", () => ({
  useCarteiraDoContato: deps.carteira,
  useDefinirCarteira: deps.definir,
}));

import { InternalTaskForm } from "@/app/app/ai/followups/[id]/_components/forms/InternalTaskForm";
import { ActionConfigForm } from "@/app/app/webhooks/_components/ActionConfigForm";
import { CartaoDaCarteira } from "@/components/contacts/CartaoDaCarteira";
import { rotuloDoMembro, sufixoDoMembro } from "@/lib/users/rotulo-do-atendente";

/** O uuid do caso da issue (`4fa3917a…`): o que aparecia cortado ou inteiro. */
const UUID = "4fa3917a-9c1e-4b6d-8f2a-5d7c1e0b3a44";
const SEM_NOME = { user_id: UUID, role: "agent", full_name: null };
const COM_NOME = { user_id: "u-ana", role: "agent", full_name: "Ana Lima" };
const SEM_DONO = { contact_id: "c1", dono_user_id: null, qualificado: false };

const t = (chave: string) => chave;

// O jsdom não implementa `scrollIntoView`, e o Radix Select chama isso no item
// destacado assim que a lista abre: sem o stub, os casos passam mas o runner
// acusa exceção não tratada e o gate fica VERMELHO por um detalhe de ambiente.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.membros.mockReturnValue({ data: [COM_NOME, SEM_NOME], isLoading: false });
  deps.carteira.mockReturnValue({ isLoading: false, data: SEM_DONO });
  deps.definir.mockReturnValue({ mutate: deps.mutate, isPending: false });
});
afterEach(cleanup);

describe("a régua do rótulo de membro (#3023)", () => {
  it("com nome: o nome cadastrado, sem inventar nada", () => {
    expect(rotuloDoMembro({ full_name: "Ana Lima", user_id: UUID }, t)).toBe("Ana Lima");
    expect(rotuloDoMembro({ full_name: "  Ana Lima  ", user_id: UUID }, t)).toBe("Ana Lima");
  });

  it("com e-mail e sem nome: o e-mail", () => {
    expect(rotuloDoMembro({ full_name: null, email: "ana@loja.test", user_id: UUID }, t)).toBe(
      "ana@loja.test",
    );
    // Nome em branco não é nome — e o e-mail vem com espaços nas pontas.
    expect(rotuloDoMembro({ full_name: "   ", email: "  ana@loja.test ", user_id: UUID }, t)).toBe(
      "ana@loja.test",
    );
  });

  it("sem nome e sem e-mail: `Atendente` + sufixo do hash, nunca o uuid", () => {
    const rotulo = rotuloDoMembro({ full_name: null, email: null, user_id: UUID }, t);
    expect(rotulo).toBe(`Atendente ${sufixoDoMembro(UUID)}`);
    // A régua da issue, em três negativas: nada de uuid inteiro, nada dos oito
    // primeiros caracteres, nada de uuid cru.
    expect(rotulo).not.toContain(UUID);
    expect(rotulo).not.toContain(UUID.slice(0, 8));
    expect(rotulo).not.toContain("4fa3917a");
  });

  it("sem nada (nem id): o rótulo genérico, ainda o mesmo texto", () => {
    expect(rotuloDoMembro({ full_name: null, email: null, user_id: null }, t)).toBe(
      "Atendente sem nome",
    );
    expect(rotuloDoMembro({}, t)).toBe("Atendente sem nome");
  });

  it("o sufixo é estável e distingue dois membros sem nome", () => {
    const a = sufixoDoMembro(UUID);
    expect(sufixoDoMembro(UUID)).toBe(a);
    expect(sufixoDoMembro("outro-id-qualquer")).not.toBe(a);
    expect(a).toHaveLength(4);
    // Determinístico entre chamadas do mesmo id — é o que permite o mesmo
    // rótulo em duas telas e na nota salva.
    expect(rotuloDoMembro({ user_id: UUID }, t)).toBe(rotuloDoMembro({ user_id: UUID }, t));
  });
});

describe("as telas da issue mostram o rótulo do helper", () => {
  it("carteira do contato: o seletor de dono lista o membro sem uuid", () => {
    render(<CartaoDaCarteira contactId="c1" papelDoUsuario="manager" />);
    const seletor = screen.getByTestId("carteira-seletor");
    const opcoes = within(seletor as HTMLElement)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(opcoes).toContain("Ana Lima");
    expect(opcoes).toContain(`Atendente ${sufixoDoMembro(UUID)}`);
    for (const opcao of opcoes) expect(opcao).not.toContain("4fa3917a");
  });

  it("tarefa interna do follow-up: «Atribuir a» usa a mesma régua", async () => {
    render(
      <InternalTaskForm
        config={{ titulo: "Ligar de volta", atribuir_a: "dono_do_lead" } as never}
        onChange={() => {}}
      />,
    );
    const gatilho = document.getElementById("internal-task-atribuir");
    expect(gatilho).not.toBeNull();
    fireEvent.click(gatilho as HTMLElement);
    const lista = await screen.findByRole("listbox");
    const rotulos = within(lista)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(rotulos).toContain(`Atendente ${sufixoDoMembro(UUID)}`);
    expect(rotulos.some((r) => r.includes("4fa3917a"))).toBe(false);
  });

  it("ação de webhook (atribuir dono): o seletor de membro não mostra uuid", async () => {
    render(
      <ActionConfigForm
        action={{ type: "assign_owner", config: { user_id: "" } } as never}
        onChange={() => {}}
      />,
    );
    // Dois comboboxes nesta ação: o do MODO ("Um atendente fixo") e o do
    // membro — o segundo é o que a issue fotografou mostrando uuid.
    const [, seletorDeMembro] = screen.getAllByRole("combobox");
    fireEvent.click(seletorDeMembro as HTMLElement);
    const lista = await screen.findByRole("listbox");
    const rotulos = within(lista)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(rotulos).toContain(`Atendente ${sufixoDoMembro(UUID)}`);
    expect(rotulos.some((r) => r.includes("4fa3917a"))).toBe(false);
  });
});

describe("a cerca: nenhuma tela volta a montar o rótulo por conta própria", () => {
  const RAIZ = process.cwd();
  const PASTAS = ["components", "app", "lib", "hooks"];
  /** `full_name ?? …user_id` — o arranjo que a issue fotografou em seis telas. */
  const ARRANJO_ANTIGO = /full_name[^\n]{0,40}\?\?[^\n]{0,60}user_?[iI]d/;

  function arquivosFonte(dir: string, achados: string[] = []): string[] {
    for (const entrada of fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
      const relativo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "node_modules" || entrada.name.startsWith(".")) continue;
        arquivosFonte(relativo, achados);
      } else if (/\.tsx?$/.test(entrada.name) && !/\.test\.tsx?$/.test(entrada.name)) {
        achados.push(relativo);
      }
    }
    return achados;
  }

  it("não sobrou `full_name ?? <uuid>` em tela, rota ou hook", () => {
    const infratores: string[] = [];
    for (const arquivo of PASTAS.flatMap((p) => arquivosFonte(p))) {
      const fonte = fs.readFileSync(path.join(RAIZ, arquivo), "utf8");
      // O próprio helper é a régua: ele compara `full_name` e `user_id`, mas não
      // monta rótulo a partir deles.
      if (arquivo === path.join("lib", "users", "rotulo-do-atendente.ts")) continue;
      if (ARRANJO_ANTIGO.test(fonte)) infratores.push(arquivo);
    }
    expect(infratores).toEqual([]);
  });

  it("os pontos que a issue listou leem o rótulo do helper", () => {
    const PONTOS = [
      "components/inbox/ReassignDialog.tsx",
      "components/inbox/composer/MentionMenu.tsx",
      "components/contacts/CartaoDaCarteira.tsx",
      "components/inbox/ParticipantesDaConversa.tsx",
      "app/app/ai/followups/[id]/_components/forms/InternalTaskForm.tsx",
      "app/app/tasks/planos/_client.tsx",
      "app/app/webhooks/_components/ActionConfigForm.tsx",
      "app/app/settings/tenant/agenda/page.tsx",
      // auditoria mostra o identificador até resolver o nome; o hash não se liga à pessoa
    ];
    const semHelper = PONTOS.filter((arquivo) => {
      const fonte = fs.readFileSync(path.join(RAIZ, arquivo), "utf8");
      // A agenda delega por `lib/agenda/identidade-do-responsavel.ts`; os outros
      // importam o helper direto.
      return !/rotulo-do-atendente|identidade-do-responsavel/.test(fonte);
    });
    expect(semHelper).toEqual([]);
  });
});
