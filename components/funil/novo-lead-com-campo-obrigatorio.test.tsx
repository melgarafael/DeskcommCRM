/**
 * NOVO LEAD: O CAMPO QUE A ETAPA EXIGE APARECE NO PRÓPRIO FORMULÁRIO (#3038).
 *
 * ─── O defeito relatado ─────────────────────────────────────────────────────
 *
 * Com um campo personalizado marcado como obrigatório na etapa Prospecção
 * (`settings.fields[].obrigatorio_em.etapas`), clicar em "Criar lead" no
 * formulário "Novo Lead" (`components/kanban/NewLeadDialog.tsx`) devolvia
 * "Preencha os campos obrigatórios antes de continuar: Tipo de cliente" — a
 * recusa do `createLeadHandler` (#1710, a régua da etapa em que o negócio
 * NASCE) — e NÃO havia input de "Tipo de cliente" na tela: o botão ficava em
 * "Criando…" e o lead não nascia. Não havia saída: nem preencher, nem criar.
 *
 * ─── A saída escolhida (declarada no PR) ────────────────────────────────────
 *
 * (a) EXIBIR no formulário os campos que a etapa exige. O motivo de não ser a
 * (b) "não exigir na criação": a #1710 decidiu de propósito que criar direto
 * numa etapa exigente é o MESMO gatilho do arrasto — afrouxar aqui deixaria o
 * negócio nascendo na coluna com o campo em branco, que é exatamente o estado
 * que a régua existe para impedir, e a cobrança só apareceria na escrita
 * seguinte. Com (a) a regra continua idêntica nos dois lados (arrasto, lote,
 * encerramento, MCP, import, clone) e ganhou porta de entrada: o formulário
 * monta os campos com a MESMA função do servidor (`camposExigidosNoDestino`,
 * o recorte que `validaCamposExigidos` percorre) e os manda em
 * `custom_fields` na criação.
 *
 * ─── O que estes casos provam ───────────────────────────────────────────────
 *
 * 1. campo obrigatório de TEXTO: aparece, é preenchido no formulário e a
 *    criação leva `custom_fields`;
 * 2. DOIS campos obrigatórios ao mesmo tempo: os dois aparecem; com um só
 *    preenchido a criação NÃO vai à rede (e diz o que falta), com os dois ela
 *    vai;
 * 3. campo obrigatório de SELEÇÃO: o combobox com as opções do funil e o valor
 *    canônico no payload;
 * 4. campo obrigatório de DATA: o input é `type=date` e o valor viaja;
 * 5. CONTROLE — a exigência da ETAPA continua valendo para quem move/salva o
 *    negócio (mesma régua, `destino` de escrita) e o bloco não é do funil
 *    inteiro: etapa sem exigência não ganha campo nenhum;
 * 6. o aviso antigo nunca mais aparece SEM SAÍDA: sem preencher, o diálogo não
 *    chama a API que sabidamente recusaria e a frase lista o que falta AO LADO
 *    do campo;
 * 7. a ROTA aceita os campos: `createLeadSchema` não descarta `custom_fields`
 *    em silêncio — sem isto o formulário coletaria e o servidor recusaria.
 *
 * Sabotagem (previsto × medido): revertido `NewLeadDialog.tsx` ao pré-fix
 * caem os casos 1, 2, 3, 4 e 6 — previsto 5 de 7, medido 5 de 7 — e ficam
 * verdes os dois controles (5 e 7). Revertido `lib/schemas/leads.ts` era
 * previsto só o caso 7 e a medição deu 5 (1, 2, 3, 4 e 7): o `NewLeadDialog`
 * passa o payload por `createLeadSchema.safeParse` antes de enviar, e o zod
 * DESCARTA em silêncio a chave que o schema não declara — o mesmo silêncio que
 * o defeito relatava, agora medido. O caso 6 segue verde aí porque ele não olha
 * o payload: ele prova que não houve ida à rede.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const criarLead = vi.fn();
vi.mock("@/hooks/kanban/useCreateLead", () => ({
  useCreateLead: () => ({ mutateAsync: criarLead, isPending: false }),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// `tests/unit/calendario-do-funil-por-campo-de-data.test.tsx` e de
// `app/app/pipelines/[id]/trocar-funil.test.tsx`): sem eles a lista de opções
// não abre e o campo de seleção fica impossível de exercitar.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { createLeadSchema } from "@/lib/schemas/leads";
import { validaCamposExigidos } from "@/lib/leads/campos-exigidos";
import type { Stage } from "@/lib/kanban/types";

const ETAPA_PROSPECCAO = "11111111-1111-4111-8111-111111111111";
const ETAPA_SEM_EXIGENCIA = "22222222-2222-4222-8222-222222222222";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";

function etapa(id: string, name: string): Stage {
  return {
    id,
    pipeline_id: FUNIL,
    name,
    is_won: false,
    is_lost: false,
    is_archived: false,
  } as unknown as Stage;
}

const PROSPECCAO = etapa(ETAPA_PROSPECCAO, "Prospecção");
const SEM_EXIGENCIA = etapa(ETAPA_SEM_EXIGENCIA, "Triagem");

/** O campo OBRIGATÓRIO da etapa Prospecção — o "Tipo de cliente" da issue. */
function campoTexto() {
  return {
    key: "tipo_de_cliente",
    label: "Tipo de cliente",
    type: "text",
    obrigatorio_em: { etapas: [ETAPA_PROSPECCAO] },
  };
}

function campoSelecao() {
  return {
    key: "segmento",
    label: "Segmento",
    type: "select",
    options: [
      { value: "varejo", label: "Varejo" },
      { value: "industria", label: "Indústria" },
    ],
    obrigatorio_em: { etapas: [ETAPA_PROSPECCAO] },
  };
}

function campoData() {
  return {
    key: "renovacao",
    label: "Renovação",
    type: "date",
    obrigatorio_em: { etapas: [ETAPA_PROSPECCAO] },
  };
}

function settingsCom(fields: unknown[]): Record<string, unknown> {
  return { fields };
}

/**
 * O diálogo como o funil e o Inbox o montam: `contactId` (o seletor de contato
 * não entra neste recorte) e o `settings` do funil, que é de onde saem os
 * campos exigidos da etapa.
 */
function abrir(settings: Record<string, unknown>, stages: Stage[] = [PROSPECCAO]) {
  return render(
    <NewLeadDialog
      open
      onOpenChange={() => {}}
      pipelineId={FUNIL}
      stages={stages}
      contactId={CONTATO}
      settings={settings}
    />,
  );
}

async function preencherTitulo(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Título"), "Consulta trabalhista");
}

function clicarEmCriarLead(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByRole("button", { name: "Criar lead" }));
}

beforeEach(() => {
  criarLead.mockReset();
  criarLead.mockResolvedValue({ data: { id: "lead-1" } });
});

afterEach(cleanup);

describe("Novo Lead numa etapa que exige campo personalizado (#3038)", () => {
  it("campo de texto obrigatório aparece no formulário e a criação leva o valor", async () => {
    const user = userEvent.setup();
    abrir(settingsCom([campoTexto()]));

    // O input que o formulário não tinha: sem ele a pessoa era avisada de um
    // campo que não existia na tela.
    await user.type(await screen.findByLabelText("Tipo de cliente"), "Varejo");
    await preencherTitulo(user);
    await clicarEmCriarLead(user);

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({
      title: "Consulta trabalhista",
      custom_fields: { tipo_de_cliente: "Varejo" },
    });
  });

  it("dois campos obrigatórios ao mesmo tempo: os dois aparecem, e só cria com os dois", async () => {
    const user = userEvent.setup();
    abrir(settingsCom([campoTexto(), campoSelecao()]));

    expect(await screen.findByLabelText("Tipo de cliente")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Segmento" })).toBeTruthy();

    // Com um só preenchido, a criação não vai à rede: a ida e volta que o
    // servidor recusaria é o "Criando…" que não terminava.
    await user.type(screen.getByLabelText("Tipo de cliente"), "Varejo");
    await preencherTitulo(user);
    await clicarEmCriarLead(user);
    expect(criarLead).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Segmento");

    await user.click(screen.getByRole("combobox", { name: "Segmento" }));
    await user.click(await screen.findByRole("option", { name: "Indústria" }));

    expect(screen.queryByRole("alert")).toBeNull();
    await clicarEmCriarLead(user);

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({
      custom_fields: { tipo_de_cliente: "Varejo", segmento: "industria" },
    });
  });

  it("campo obrigatório de seleção: o combobox traz as opções do funil", async () => {
    const user = userEvent.setup();
    abrir(settingsCom([campoSelecao()]));

    await user.click(await screen.findByRole("combobox", { name: "Segmento" }));
    await user.click(await screen.findByRole("option", { name: "Varejo" }));
    await preencherTitulo(user);
    await clicarEmCriarLead(user);

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({
      custom_fields: { segmento: "varejo" },
    });
  });

  it("campo obrigatório de data: o input é de data e o valor viaja", async () => {
    const user = userEvent.setup();
    abrir(settingsCom([campoData()]));

    const campo = await screen.findByLabelText("Renovação");
    expect(campo.getAttribute("type")).toBe("date");
    fireEvent.change(campo, { target: { value: "2026-12-01" } });

    await preencherTitulo(user);
    await clicarEmCriarLead(user);

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({
      custom_fields: { renovacao: "2026-12-01" },
    });
  });

  it("CONTROLE: a exigência da etapa continua valendo para quem move o negócio, e não é do funil inteiro", async () => {
    const settings = settingsCom([campoTexto()]);
    const destinoDaEscrita = { stageId: ETAPA_PROSPECCAO, desfecho: null };

    // Mover/salvar o negócio nesta etapa: a régua NÃO foi afrouxada — é a
    // mesma pergunta, com o mesmo destino, que o `/move` e o PATCH fazem.
    const faltando = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil: settings,
      destino: destinoDaEscrita,
      motivoDeGanho: null,
    }).faltando;
    expect(faltando.map((campo) => campo.chave)).toEqual(["tipo_de_cliente"]);

    // E o valor preenchido satisfaz a MESMA régua (a porta de entrada não
    // pediu uma regra nova, só deu onde digitar).
    const comValor = validaCamposExigidos({
      lead: { custom_fields: { tipo_de_cliente: "Varejo" } },
      settingsDoFunil: settings,
      destino: destinoDaEscrita,
      motivoDeGanho: null,
    }).faltando;
    expect(comValor).toEqual([]);

    // O recorte é da ETAPA, não do funil: numa etapa que não exige nada, o
    // formulário não ganha campo nenhum.
    abrir(settings, [SEM_EXIGENCIA]);
    await screen.findByLabelText("Título");
    expect(screen.queryByLabelText("Tipo de cliente")).toBeNull();
  });

  it("o aviso de campo obrigatório nunca mais aparece sem saída", async () => {
    const user = userEvent.setup();
    abrir(settingsCom([campoTexto()]));

    await preencherTitulo(user);
    await clicarEmCriarLead(user);

    // Nada de rede: a API só saberia recusar, e era isso que deixava o botão
    // em "Criando…" — a frase "Preencha os campos obrigatórios…" sozinha, sem
    // um único input para preencher.
    expect(criarLead).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Criar lead" })).toBeTruthy();
    // O aviso continua existindo — mas agora AO LADO do campo que ele pede.
    expect(screen.getByLabelText("Tipo de cliente")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Tipo de cliente");
  });

  it("a rota de criação aceita os campos: o schema não os descarta em silêncio", () => {
    const parsed = createLeadSchema.safeParse({
      pipeline_id: FUNIL,
      stage_id: ETAPA_PROSPECCAO,
      title: "Negócio novo",
      custom_fields: { tipo_de_cliente: "Varejo" },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.custom_fields : null).toEqual({
      tipo_de_cliente: "Varejo",
    });
  });
});
