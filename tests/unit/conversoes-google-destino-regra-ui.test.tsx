import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegrasDeConversaoGoogle } from "@/app/app/settings/conversoes/_regrasGoogle";
import { HistoricoDeEnvios } from "@/app/app/settings/conversoes/_historico";
import type { RegraDeConversaoGoogle } from "@/lib/conversoes/regras-google";
import { lerFiltros, type LinhaDoHistorico } from "@/lib/conversoes/historico";

const mock = vi.hoisted(() => ({ salvar: vi.fn(), criar: vi.fn() }));
vi.mock("@/app/actions/settings/salvarRegrasDeConversaoGoogle", () => ({
  salvarRegrasDeConversaoGoogle: mock.salvar,
}));
vi.mock("@/app/actions/settings/acoesDeConversaoGoogle", () => ({
  criarAcaoDeConversaoGoogle: mock.criar,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/settings/conversoes/_reprocessar", () => ({ ReprocessarConversao: () => null }));
vi.mock("@/app/app/settings/conversoes/_linkDoNegocio", () => ({ LinkDoNegocio: () => null }));

const ETAPA = { id: "et1", nome: "Qualificado", funil: "Vendas", primeira: false };
const PADRAO = "1111111111";
const CONTA = "2222222222";
const MCC = "9999999999";
const regra = (id: string, customerId: string | null, enabled = true): RegraDeConversaoGoogle => ({
  id,
  stageId: ETAPA.id,
  eventName: `Etapa:${ETAPA.id}`,
  label: `Lead ${id}`,
  googleActionId: id === "global" ? "11" : "22",
  googleCustomerId: customerId,
  googleLoginCustomerId: null,
  category: "QUALIFIED_LEAD",
  includedInConversions: true,
  channel: "todos",
  enabled,
  configuredAt: "2026-11-25T12:00:00Z",
});
function abrir(regras: RegraDeConversaoGoogle[] = []) {
  render(
    <RegrasDeConversaoGoogle
      etapas={[ETAPA]}
      regras={regras}
      idioma="pt-BR"
      podeCriarAcao
      contaPadraoId={PADRAO}
      contaPadraoMcc={MCC}
      contasSugeridas={[{ customerId: CONTA, label: "Clínica Barra", loginCustomerId: null }]}
    />,
  );
}
const linha = (id = ETAPA.id) => within(screen.getByTestId(`regra-${id}`));
const salvar = () => fireEvent.click(screen.getByRole("button", { name: "Salvar regras" }));
const ligar = (id = ETAPA.id) =>
  fireEvent.click(linha(id).getByRole("switch", { name: "Enviar conversão nesta etapa" }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.salvar.mockResolvedValue({ ok: true });
  mock.criar.mockResolvedValue({ ok: true, dados: { id: "555", nome: "Lead criado" } });
});

describe("destino por regra do Google na tela", () => {
  it("preserva duas contas na mesma etapa, incluindo a regra padrão", async () => {
    abrir([regra("global", null), regra("barra", CONTA)]);
    expect(screen.getByTestId("destino-et1")).toHaveTextContent(
      `Conta padrão · ${PADRAO} · MCC ${MCC}`,
    );
    expect(screen.getByTestId("destino-et1-barra")).toHaveTextContent(
      `Conta específica · ${CONTA} · Clínica Barra · Acesso direto`,
    );
    expect(linha().getByLabelText("Ação de conversão (ID)")).toHaveValue("11");
    expect(linha("et1-barra").getByLabelText("Ação de conversão (ID)")).toHaveValue("22");
    expect(screen.getByTestId("etapas-enviando")).toHaveTextContent("1 de 1");
    salvar();
    await waitFor(() =>
      expect(mock.salvar).toHaveBeenCalledWith([
        expect.objectContaining({
          stage_id: ETAPA.id,
          google_customer_id: null,
          google_action_id: "11",
        }),
        expect.objectContaining({
          stage_id: ETAPA.id,
          google_customer_id: CONTA,
          google_login_customer_id: null,
          google_action_id: "22",
        }),
      ]),
    );
    expect(screen.getByText(/Conectar uma conta para relatórios não autoriza/)).toBeInTheDocument();
  });

  it("adiciona conta, cria a ação no destino selecionado e salva esse destino", async () => {
    abrir([regra("global", null)]);
    fireEvent.click(screen.getByRole("button", { name: "Adicionar conta nesta etapa" }));
    const nova = linha("et1-nova-0");
    expect(nova.getByRole("button", { name: "Criar no Google" })).toBeDisabled();
    fireEvent.change(nova.getByLabelText("ID da conta de destino"), {
      target: { value: "222-222-2222" },
    });
    expect(nova.getByLabelText("ID da conta de destino")).toHaveValue(CONTA);
    fireEvent.change(nova.getByLabelText("ID da conta administradora (MCC, opcional)"), {
      target: { value: MCC },
    });
    fireEvent.click(nova.getByRole("button", { name: "Criar no Google" }));
    await waitFor(() =>
      expect(mock.criar).toHaveBeenCalledWith({
        nome: "Lead qualificado",
        categoria: "QUALIFIED_LEAD",
        incluir_em_conversoes: true,
        google_customer_id: CONTA,
        google_login_customer_id: MCC,
      }),
    );
    await waitFor(() => expect(nova.getByLabelText("Ação de conversão (ID)")).toHaveValue("555"));
    salvar();
    await waitFor(() =>
      expect(mock.salvar).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            google_customer_id: CONTA,
            google_login_customer_id: MCC,
            google_action_id: "555",
          }),
        ]),
      ),
    );
    await waitFor(() => expect(nova.queryByRole("button", { name: "Descartar" })).toBeNull());
  });

  it("regras explícitas existentes não ganham uma regra padrão ao usar o recomendado", () => {
    abrir([regra("barra", CONTA)]);
    fireEvent.click(screen.getByRole("button", { name: "Usar o recomendado" }));
    expect(screen.getAllByLabelText("Conta de destino")).toHaveLength(1);
    expect(linha().getByLabelText("Conta de destino")).toHaveValue("especifica");
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
  });

  it("descarta uma conta nova incompleta e deixa salvar as regras existentes", async () => {
    abrir([regra("global", null)]);
    fireEvent.click(screen.getByRole("button", { name: "Adicionar conta nesta etapa" }));
    const nova = linha("et1-nova-0");
    fireEvent.change(nova.getByLabelText("ID da conta de destino"), { target: { value: "123" } });
    fireEvent.click(nova.getByRole("button", { name: "Descartar" }));
    expect(screen.queryByTestId("regra-et1-nova-0")).toBeNull();
    salvar();
    await waitFor(() =>
      expect(mock.salvar).toHaveBeenCalledWith([
        expect.objectContaining({ google_customer_id: null, google_action_id: "11" }),
      ]),
    );
  });

  it("limpa a ação ao trocar conta, MCC ou voltar ao padrão", () => {
    abrir([regra("global", null)]);
    const campos = linha();
    const destino = campos.getByLabelText("Conta de destino");
    fireEvent.change(destino, { target: { value: "especifica" } });
    const acao = campos.getByLabelText("Ação de conversão (ID)");
    expect(acao).toHaveValue("");
    fireEvent.change(acao, { target: { value: "99" } });
    fireEvent.change(campos.getByLabelText("ID da conta de destino"), { target: { value: CONTA } });
    expect(acao).toHaveValue("");
    fireEvent.change(acao, { target: { value: "99" } });
    fireEvent.change(campos.getByLabelText("ID da conta administradora (MCC, opcional)"), {
      target: { value: MCC },
    });
    expect(acao).toHaveValue("");
    fireEvent.change(acao, { target: { value: "99" } });
    fireEvent.change(destino, { target: { value: "padrao" } });
    expect(acao).toHaveValue("");
  });

  it("pausa sem perder destino ou ação e mostra os campos ao religar", async () => {
    abrir([regra("global", null), regra("barra", CONTA)]);
    ligar("et1-barra");
    expect(linha("et1-barra").queryByLabelText("Ação de conversão (ID)")).toBeNull();
    salvar();
    await waitFor(() =>
      expect(mock.salvar).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            enabled: false,
            google_customer_id: CONTA,
            google_action_id: "22",
            label: "Lead barra",
          }),
        ]),
      ),
    );
    ligar("et1-barra");
    expect(linha("et1-barra").getByLabelText("Ação de conversão (ID)")).toHaveValue("22");
  });

  it("recusa completar um ID criado para a conta anterior após a troca de destino", async () => {
    let terminar!: (value: unknown) => void;
    mock.criar.mockImplementation(
      () =>
        new Promise((resolve) => {
          terminar = resolve;
        }),
    );
    abrir([regra("global", null)]);
    fireEvent.click(linha().getByRole("button", { name: "Criar no Google" }));
    await waitFor(() => expect(mock.criar).toHaveBeenCalledOnce());
    fireEvent.change(linha().getByLabelText("Conta de destino"), {
      target: { value: "especifica" },
    });
    fireEvent.change(linha().getByLabelText("ID da conta de destino"), {
      target: { value: CONTA },
    });
    await act(async () => terminar({ ok: true, dados: { id: "555", nome: "Conta anterior" } }));
    expect(linha().getByLabelText("Ação de conversão (ID)")).toHaveValue("");
  });
});

it("o histórico mostra a conta do recibo e traço quando o legado não tem snapshot", () => {
  const historico: LinhaDoHistorico = {
    id: "h1",
    leadId: "lead",
    tituloDoLead: "Consulta",
    plataforma: "google_ads",
    evento: "Purchase",
    status: "sent",
    motivo: null,
    detalhe: null,
    eventoId: "evento",
    protocolo: null,
    acaoGoogle: "22",
    googleCustomerId: CONTA,
    valorCentavos: null,
    moeda: "BRL",
    ocorridoEm: null,
    tentadoEm: "2026-11-25T12:00:00Z",
  };
  render(
    <HistoricoDeEnvios
      linhas={[historico, { ...historico, id: "h2", googleCustomerId: null }]}
      total={2}
      filtros={lerFiltros({})}
      regras={[]}
      idioma="pt-BR"
    />,
  );
  expect(screen.getByText(`Conta de destino: ${CONTA}`)).toBeInTheDocument();
  expect(screen.getByText("Conta de destino: —")).toBeInTheDocument();
});
