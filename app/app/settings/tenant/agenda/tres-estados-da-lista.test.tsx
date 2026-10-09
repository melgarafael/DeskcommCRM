import { apiClient } from "@/lib/api/client";
/**
 * ERRO DE LEITURA NÃO É LISTA VAZIA.
 *
 * ═══ O defeito, medido em produção (2026-09-16) ═════════════════════════════
 *
 * A tela de Tipos de agendamento mostrava "Nenhum tipo de agendamento ainda"
 * enquanto o banco tinha QUATRO tipos ativos — e, ao tentar criar um deles, a
 * API respondia "Já existe um tipo com o nome Retirada de pedido". As duas
 * telas discordavam e nenhuma parecia quebrada.
 *
 * A causa: a página de servidor fazia `const [{ data: tipos }] = await
 * Promise.all([...])` e DESCARTAVA o `error`. A consulta pedia
 * `reminder_extra_offsets_minutes`, coluna que aquela instalação não tinha
 * (migration 0254 nunca aplicada), o PostgREST recusava a consulta inteira,
 * `data` vinha `null` — e `null` era desenhado como "não existe nada".
 *
 * ═══ Por que testar o COMPONENTE, e não a página ════════════════════════════
 *
 * O `page.tsx` é Server Component com `requireAuth`/Supabase: testá-lo aqui
 * exigiria simular a sessão inteira e mediria o mock. O que precisa estar
 * travado é a REGRA DE DESENHO — três estados distintos —, e ela vive no
 * cliente. A ponte (a página passar `erroDeLeitura`) é cobrada no último caso
 * deste arquivo, por leitura do fonte, porque é uma linha que some sem doer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TiposDeAgendamentoClient, type TipoRow } from "./_client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const TIPO: TipoRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Retirada de pedido",
  slug: "retirada-de-pedido",
  description: null,
  category: "outro",
  duration_minutes: 30,
  location_kind: "presencial",
  location_details: null,
  default_owner_user_id: null,
  requires_confirmation: false,
  is_active: true,
  reminder_enabled: false,
  reminder_minutes_before: 60,
  reminder_extra_offsets_minutes: [],
  // Campos que a v1.41.0 acrescentou a `TipoRow`. A fixture os declara porque o
  // tipo é do OFICIAL: teste privado que constrói literal de tipo oficial
  // envelhece a cada release que soma campo — é colisão por TIPO, não por linha.
  reminder_body: null,
  reminder_bodies: null,
  default_price_cents: null,
};

function montar(props: Partial<React.ComponentProps<typeof TiposDeAgendamentoClient>> = {}) {
  // Um filho desta tela (o cartão do Google) consulta por react-query; sem o
  // provider o render morre antes de chegar à lista, que é o que se mede aqui.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
    <TiposDeAgendamentoClient
      tiposIniciais={[]}
      pessoas={[]}
      podeEditar
      usuarioAtualId="22222222-2222-4222-8222-222222222222"
      podeConfigurarGoogle={false}
      clientePelaAgendaLigado={false}
      podeLigarClientePelaAgenda={false}
      colegasPodemMexerNaAgendaLigado={false}
      podeMudarAgendaDosColegas={false}
      {...props}
    />
    </QueryClientProvider>,
  );
}

describe("os três estados da lista de tipos", () => {
  it("lista vazia DE VERDADE convida a criar o primeiro", () => {
    montar();

    expect(screen.getByTestId("sem-tipos")).toBeTruthy();
    expect(screen.queryByTestId("erro-ao-ler-tipos")).toBeNull();
  });

  it("EXISTING_TYPE_VISIBLE_IN_SETTINGS: tipo cadastrado aparece", () => {
    montar({ tiposIniciais: [TIPO] });

    expect(screen.getByText("Retirada de pedido")).toBeTruthy();
    expect(screen.queryByTestId("sem-tipos")).toBeNull();
    expect(screen.queryByTestId("erro-ao-ler-tipos")).toBeNull();
  });

  it("falha de leitura NUNCA é desenhada como 'não existe nada'", () => {
    montar({
      erroDeLeitura: 'column calendar_event_types.reminder_extra_offsets_minutes does not exist',
    });

    const erro = screen.getByTestId("erro-ao-ler-tipos");
    expect(erro).toBeTruthy();
    expect(erro.getAttribute("role")).toBe("alert");
    // A frase que convidava a criar não pode aparecer junto: seguir o convite
    // levaria ao erro de duplicidade que ninguém consegue explicar.
    expect(screen.queryByTestId("sem-tipos")).toBeNull();
    // A mensagem técnica fica visível para quem for consertar a instalação.
    expect(erro.textContent).toContain("reminder_extra_offsets_minutes");
  });

  it("a página repassa o erro da leitura em vez de descartá-lo", () => {
    // Sem comentários: uma linha comentada não pode contar como ponte presente.
    const fonte = readFileSync(join(__dirname, "page.tsx"), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");

    // O defeito original: `const [{ data: tipos }] = await Promise.all(...)`.
    expect(fonte).toMatch(/\[\s*\{[^}]*\berror:\s*erroTipos\b[^}]*\}/);
    expect(fonte).toMatch(/erroDeLeitura=\{\s*erroTipos\b/);
  });
});


describe("canal dos lembretes pela tela", () => {
  it("seleção explícita chega ao PATCH e o texto explica a prioridade", async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: TIPO.id } } as never);
    montar({ tiposIniciais: [{ ...TIPO, reminder_enabled: true }], canais: [{ id: "clinica", nome: "Clínica · 2218" }, { id: "cursos", nome: "Cursos · 9274" }] });
    fireEvent.click(screen.getByTestId(`editar-${TIPO.id}`));
    const seletor = screen.getByTestId(`editar-lembrete-canal-${TIPO.id}`) as HTMLSelectElement;
    expect(seletor.value).toBe("");
    fireEvent.change(seletor, { target: { value: "clinica" } });
    expect(screen.getByText(/vale para todas as reservas deste tipo/)).toBeTruthy();
    fireEvent.submit(screen.getByTestId(`form-editar-${TIPO.id}`));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/agenda/tipos", expect.objectContaining({ reminder_channel_session_id: "clinica" })));
  });
  it("falha de leitura preserva o canal guardado, sem voltar ao automático", () => {
    montar({ tiposIniciais: [{ ...TIPO, reminder_enabled: true, reminder_channel_session_id: "clinica" }], erroCanais: "falha" });
    fireEvent.click(screen.getByTestId(`editar-${TIPO.id}`));
    const seletor = screen.getByTestId(`editar-lembrete-canal-${TIPO.id}`) as HTMLSelectElement;
    expect(seletor.value).toBe("clinica"); expect(seletor.disabled).toBe(true);
    const dados = new FormData(screen.getByTestId(`form-editar-${TIPO.id}`) as HTMLFormElement);
    expect(dados.has("reminder_channel_session_id")).toBe(false);
    expect(screen.getByText(/A escolha guardada será preservada/)).toBeTruthy();
  });
});
