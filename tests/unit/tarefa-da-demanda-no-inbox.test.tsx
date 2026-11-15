import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TarefasDaDemanda } from "@/components/inbox/TarefasDaDemanda";
import type { Tarefa } from "@/lib/tarefas/tipos";

/**
 * A TAREFA CRIADA DE DENTRO DA CONVERSA (#2818).
 *
 * O que este arquivo prende é o VÍNCULO e a porta: a seção consulta as tarefas
 * da DEMANDA vigente (não do contato), e a tarefa criada aqui sai presa à
 * demanda, ao contato e ao negócio ativo — sem sair da tela e sem nota de
 * texto. A ausência que o teste também cobra: sem demanda vigente, a seção não
 * desenha nada (é o caso da conversa sem atendimento aberto).
 */

const EU = "u-eu";
const DEMANDA = "d-1";

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
    title: "Confirmar o orçamento",
    description: null,
    due_date: null,
    priority: "medium",
    status: "pending",
    lead_id: "l-1",
    contact_id: "c-1",
    demanda_id: DEMANDA,
    assigned_to: null,
    created_by: EU,
    created_at: "2026-10-13T12:00:00Z",
    updated_at: "2026-10-13T12:00:00Z",
    ...resto,
  };
}

beforeEach(() => {
  tarefasHook.tarefas = [];
  tarefasHook.chamadas = [];
  vi.clearAllMocks();
});

describe("TarefasDaDemanda — a seção do inbox", () => {
  it("⭐ 'Nova tarefa' cria a tarefa presa à demanda, ao contato e ao negócio, com quem criou como responsável", async () => {
    render(
      <TarefasDaDemanda demandaId={DEMANDA} contactId="c-1" leadId="l-1" podeEditar />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Nova tarefa/ }));
    await userEvent.type(screen.getByLabelText("O que precisa ser feito"), "Confirmar o orçamento amanhã");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(tarefasHook.criarTarefa).toHaveBeenCalledTimes(1);
    expect(tarefasHook.criarTarefa).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Confirmar o orçamento amanhã",
        demanda_id: DEMANDA,
        contact_id: "c-1",
        lead_id: "l-1",
        assigned_to: EU,
      }),
    );
  });

  it("⭐ consulta as tarefas EM ABERTO da DEMANDA vigente, não do contato", () => {
    render(<TarefasDaDemanda demandaId={DEMANDA} contactId="c-1" podeEditar />);
    expect(tarefasHook.chamadas.at(-1)).toEqual([
      { demanda_id: DEMANDA, aberto: true },
      { enabled: true },
    ]);
  });

  it("sem demanda e sem contato, a seção não desenha nada nem monta a consulta", () => {
    const { container } = render(<TarefasDaDemanda demandaId={null} contactId={null} podeEditar />);
    expect(container.firstChild).toBeNull();
    // O guarda vem ANTES dos hooks: conversa sem contato não pede tarefa nenhuma.
    expect(tarefasHook.chamadas).toHaveLength(0);
  });

  it("⭐ sem demanda vigente, mas com contato, mostra as tarefas EM ABERTO do contato (#4630)", () => {
    // A tarefa criada pelo "Nova tarefa" do painel numa conversa sem demanda
    // precisa aparecer na conversa — é o motivo de a seção existir aqui também.
    tarefasHook.tarefas = [tarefa({ demanda_id: null, title: "Mandar a proposta" })];
    render(<TarefasDaDemanda demandaId={null} contactId="c-1" podeEditar />);

    expect(tarefasHook.chamadas.at(-1)).toEqual([{ contact_id: "c-1", aberto: true }, { enabled: true }]);
    expect(screen.getByRole("heading", { name: /Tarefas do contato/ })).toBeTruthy();
    expect(screen.getByText("Mandar a proposta")).toBeTruthy();
  });

  it("⭐ o divisor é da seção: viaja com ela e não sobra traço quando ela não existe", () => {
    // O painel desenha demanda | tarefas | memória e separa os blocos com um
    // traço. O traço DESTA seção mora aqui dentro, então nasce com ela e some
    // com ela: sem demanda e sem contato não há seção, e não pode sobrar o
    // traço órfão colado no do bloco seguinte.
    const comDemanda = render(<TarefasDaDemanda demandaId={DEMANDA} contactId="c-1" podeEditar />);
    expect(comDemanda.container.firstElementChild?.getAttribute("data-orientation")).toBe("horizontal");
    comDemanda.unmount();

    const soContato = render(<TarefasDaDemanda demandaId={null} contactId="c-1" podeEditar />);
    expect(soContato.container.firstElementChild?.getAttribute("data-orientation")).toBe("horizontal");
    soContato.unmount();

    const semNada = render(<TarefasDaDemanda demandaId={null} contactId={null} podeEditar />);
    expect(semNada.container.querySelectorAll('[data-orientation="horizontal"]')).toHaveLength(0);
  });

  it("a tarefa da demanda aparece na lista, com o prazo que a régua da tela mostra", () => {
    tarefasHook.tarefas = [tarefa({ due_date: "2000-01-01T12:00:00Z", title: "Ligar de volta" })];
    render(<TarefasDaDemanda demandaId={DEMANDA} contactId="c-1" podeEditar />);

    expect(screen.getByText("Ligar de volta")).toBeTruthy();
    // O cabeçalho conta as abertas e as atrasadas com a MESMA régua do resto.
    const cabecalho = screen.getByRole("heading", { name: /Tarefas desta demanda/ });
    expect(cabecalho.textContent).toContain("1 aberta");
    expect(cabecalho.textContent).toContain("1 atrasada");
  });

  it("quem só lê (viewer) vê as tarefas mas não o botão de criar", () => {
    tarefasHook.tarefas = [tarefa()];
    render(<TarefasDaDemanda demandaId={DEMANDA} contactId="c-1" podeEditar={false} />);

    expect(screen.getByText("Confirmar o orçamento")).toBeTruthy();
    expect(screen.queryByTestId("inbox-nova-tarefa")).toBeNull();
  });
});
