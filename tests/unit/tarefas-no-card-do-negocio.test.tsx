import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TarefasDoNegocio } from "@/components/kanban/TarefasDoNegocio";
import { TarefasNoCard } from "@/components/kanban/TarefasNoCard";
import type { Tarefa } from "@/lib/tarefas/tipos";

/**
 * Tarefas dentro do card do negócio.
 *
 * Antes, a única porta de criação de tarefa era a tela de Tarefas, que não
 * pergunta de qual negócio ela é: toda tarefa feita à mão nascia avulsa. O que
 * este arquivo prende é o VÍNCULO — a tarefa criada no dossiê sai com o
 * `lead_id` e o `contact_id` do negócio — e as duas regras que a seção traz
 * junto: o responsável padrão é quem cria, e a edição não reenvia um
 * responsável em que ninguém mexeu.
 */

const EU = "u-eu";

const tarefasHook = vi.hoisted(() => ({
  tarefas: [] as Tarefa[],
  criarTarefa: vi.fn(async () => ({})),
  editarTarefa: vi.fn(async () => ({})),
  apagarTarefa: vi.fn(async () => ({})),
  alternarConcluida: vi.fn(async () => ({})),
  chamadas: [] as unknown[][],
}));

vi.mock("@/hooks/tasks/useTasks", () => ({
  useTasks: (...args: unknown[]) => {
    tarefasHook.chamadas.push(args);
    return {
      tarefas: tarefasHook.tarefas,
      carregando: false,
      falhou: false,
      recarregar: vi.fn(),
      criarTarefa: tarefasHook.criarTarefa,
      editarTarefa: tarefasHook.editarTarefa,
      apagarTarefa: tarefasHook.apagarTarefa,
      alternarConcluida: tarefasHook.alternarConcluida,
    };
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: EU }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({
    isSuccess: true,
    data: [
      { user_id: EU, role: "agent", full_name: "Eu Mesmo" },
      { user_id: "u-ana", role: "agent", full_name: "Ana" },
    ],
  }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

function tarefa(resto: Partial<Tarefa> = {}): Tarefa {
  return {
    id: "t-1",
    organization_id: "org-1",
    title: "Ligar para confirmar a entrega",
    description: null,
    due_date: null,
    priority: "medium",
    status: "pending",
    lead_id: "l-1",
    contact_id: "c-1",
    demanda_id: null,
    assigned_to: null,
    created_by: EU,
    created_at: "2026-10-01T12:00:00Z",
    updated_at: "2026-10-01T12:00:00Z",
    ...resto,
  };
}

beforeEach(() => {
  tarefasHook.tarefas = [];
  tarefasHook.chamadas = [];
  vi.clearAllMocks();
});

describe("TarefasDoNegocio — a seção Tarefas do dossiê", () => {
  it("⭐ 'Nova tarefa' cria a tarefa presa ao negócio e ao contato, com quem criou como responsável", async () => {
    render(<TarefasDoNegocio leadId="l-1" contactId="c-1" podeEditar aberto />);

    await userEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    await userEvent.type(screen.getByLabelText("O que precisa ser feito"), "Enviar a proposta revisada");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(tarefasHook.criarTarefa).toHaveBeenCalledTimes(1);
    expect(tarefasHook.criarTarefa).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Enviar a proposta revisada",
        lead_id: "l-1",
        contact_id: "c-1",
        assigned_to: EU,
      }),
    );
  });

  it("consulta só as tarefas DESTE negócio, e só com o dossiê aberto", () => {
    const { rerender } = render(
      <TarefasDoNegocio leadId="l-1" contactId={null} podeEditar aberto={false} />,
    );
    expect(tarefasHook.chamadas.at(-1)).toEqual([{ lead_id: "l-1" }, { enabled: false }]);

    rerender(<TarefasDoNegocio leadId="l-1" contactId={null} podeEditar aberto />);
    expect(tarefasHook.chamadas.at(-1)).toEqual([{ lead_id: "l-1" }, { enabled: true }]);
  });

  it("o cabeçalho conta as abertas e as atrasadas com a régua da lista", () => {
    tarefasHook.tarefas = [
      tarefa({ id: "t-1", due_date: "2000-01-01T12:00:00Z" }),
      tarefa({ id: "t-2", status: "in_progress" }),
      tarefa({ id: "t-3", status: "done", due_date: "2000-01-01T12:00:00Z" }),
    ];
    render(<TarefasDoNegocio leadId="l-1" contactId="c-1" podeEditar aberto />);

    const cabecalho = screen.getByRole("heading", { name: /Tarefas/ });
    expect(cabecalho.textContent).toContain("2 abertas");
    expect(cabecalho.textContent).toContain("1 atrasada");
  });

  it("quem só lê (viewer) vê as tarefas mas não o botão de criar", () => {
    tarefasHook.tarefas = [tarefa()];
    render(<TarefasDoNegocio leadId="l-1" contactId="c-1" podeEditar={false} aberto />);

    expect(screen.getByText("Ligar para confirmar a entrega")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Nova tarefa" })).toBeNull();
  });

  it("editar o título NÃO reenvia um responsável em que ninguém mexeu (ele pode ter saído da equipe)", async () => {
    tarefasHook.tarefas = [tarefa({ assigned_to: "u-que-saiu" })];
    render(<TarefasDoNegocio leadId="l-1" contactId="c-1" podeEditar aberto />);

    await userEvent.click(screen.getByRole("button", { name: "Editar a tarefa" }));
    const titulo = screen.getByLabelText("O que precisa ser feito");
    await userEvent.clear(titulo);
    await userEvent.type(titulo, "Ligar amanhã");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(tarefasHook.editarTarefa).toHaveBeenCalledTimes(1);
    const [, entrada] = tarefasHook.editarTarefa.mock.calls[0] as unknown as [string, object];
    expect(entrada).toMatchObject({ title: "Ligar amanhã" });
    expect(entrada).not.toHaveProperty("assigned_to");
  });
});

describe("TarefasNoCard — o selo do card no quadro", () => {
  it("sem tarefa em aberto, não desenha nada", () => {
    const { container } = render(<TarefasNoCard />);
    expect(container.firstChild).toBeNull();
  });

  it("⭐ diz quantas estão abertas e quantas venceram, por extenso para o leitor de tela", () => {
    render(<TarefasNoCard tarefas={{ abertas: 3, atrasadas: 1 }} />);
    expect(screen.getByRole("img", { name: "3 tarefas abertas · 1 atrasada" })).toBeTruthy();
  });

  it("sem atraso, não menciona atraso", () => {
    render(<TarefasNoCard tarefas={{ abertas: 1, atrasadas: 0 }} />);
    expect(screen.getByRole("img", { name: "1 tarefa aberta" })).toBeTruthy();
  });
});
