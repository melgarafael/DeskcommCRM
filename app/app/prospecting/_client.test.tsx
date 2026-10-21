import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * Tela da Prospecção (ORDEM A): o contador do "Verificar agora" (A4), o erro da
 * prévia que fica na janela e some ao trocar de campanha (A2) e o painel de
 * configuração que não pode sumir num rascunho com config parcial (A3).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { ProspectingClient } from "./_client";

const COMPLETA = "11111111-1111-4111-8111-111111111111";
const PARCIAL = "11111111-1111-4111-8111-111111111112";
const AGENT = "55555555-5555-4555-8555-555555555555";
const CHANNEL = "22222222-2222-4222-8222-222222222222";
const PIPE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const QUALIFIED = "44444444-4444-4444-8444-444444444445";

const CONFIG = {
  agent_id: AGENT,
  channel_session_id: CHANNEL,
  pipeline_id: PIPE,
  stage_id: STAGE,
  qualified_stage_id: QUALIFIED,
  instruction: "Oferecer uma avaliação comercial.",
  qualification: "Confirmou a necessidade e quer conversar.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "Avaliação real registrada pelo operador",
  ofertas: ["site"],
  funnel_entry: "on_send",
};

const SITE_OK = {
  ver: 1,
  classe: "site-ok",
  problemas: [],
  checklist: { tem: ["tel"], falta: [] },
  final_url: "https://saudavel.test/",
  http_status: 200,
  tempo_ms: 300,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
  provisorio: false,
  tentativas: 0,
};

const PROVISORIO_VELHO = {
  ...SITE_OK,
  classe: "fora-do-ar",
  problemas: ["fora-do-ar"],
  final_url: null,
  http_status: null,
  // Muito antes do intervalo mínimo: elegível para nova rodada.
  verificado_em: "2020-01-01T00:00:00.000Z",
  provisorio: true,
  tentativas: 1,
};

function empresa(name: string, website: string | null, site: unknown) {
  return {
    name,
    phone: "+5511999990000",
    website,
    category: "Serviços",
    address: "Rua X",
    maps_url: null,
    rating: 4.8,
    reviews: 120,
    emails: [],
    socials: [],
    site,
  };
}

function candidato(id: string, campaignId: string, data: unknown, selected?: boolean) {
  return {
    id,
    campaign_id: campaignId,
    data,
    progress: "new",
    message_status: null,
    error: null,
    conversation_id: null,
    ...(selected === undefined ? {} : { selected }),
  };
}

const BUSCA_NOVA = { niche: "x", location: "y", avaliar_site: true, gerar_previa: true };

function fixture() {
  return {
    configured: true,
    campaigns: [
      {
        id: COMPLETA,
        // Busca nova: o formulário grava as duas chaves do preparo (`opcoesDoPreparo`).
        search: BUSCA_NOVA,
        name: "Clínicas de estética",
        status: "draft",
        search_status: "succeeded",
        error: null,
        config: CONFIG,
        result_count: 5,
        skipped_count: 0,
        cost_usd: "0.10",
        next_send_at: "2026-10-10T00:00:00Z",
      },
      {
        id: PARCIAL,
        search: BUSCA_NOVA,
        name: "Imobiliária parcial",
        status: "draft",
        search_status: "succeeded",
        error: null,
        // Config salva pelo meio: instrução e qualificação, SEM agente — a tela
        // não pode tratar isto como campanha configurada.
        config: {
          instruction: "Oferecer uma avaliação comercial.",
          qualification: "Confirmou a necessidade e quer conversar.",
        },
        result_count: 1,
        skipped_count: 0,
        cost_usd: "0.10",
        next_send_at: "2026-10-10T00:00:00Z",
      },
    ],
    candidates: [
      candidato("c1", COMPLETA, empresa("Sem auditoria ainda", "https://a.test/", null)),
      candidato("c2", COMPLETA, empresa("Sem site nenhum", null, null)),
      candidato("c3", COMPLETA, empresa("Com site saudável", "https://saudavel.test/", SITE_OK)),
      candidato(
        "c4",
        COMPLETA,
        empresa("Provisório vencido", "https://b.test/", PROVISORIO_VELHO),
      ),
      candidato("c5", COMPLETA, empresa("Desmarcada", "https://e.test/", null), false),
      candidato("c6", PARCIAL, empresa("Da campanha parcial", "https://f.test/", null)),
    ],
    agents: [{ id: AGENT, name: "Agente existente" }],
    personalizacao: {
      vendedor_nome: "",
      vendedor_apresentacao: "",
      vendedor_diferencial: "",
      vocabulario: {},
    },
    channels: [{ id: CHANNEL, display_name: "Comercial", phone_number: null, status: "WORKING" }],
    stages: [
      { id: STAGE, name: "Novos", pipeline_id: PIPE, pipeline_name: "Comercial" },
      { id: QUALIFIED, name: "Qualificados", pipeline_id: PIPE, pipeline_name: "Comercial" },
    ],
  };
}

function openPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async () => ({ data: fixture() }));
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe("A4: contador da verificação e o sem-site derivado", () => {
  it("conta só quem precisa de rede e não deixa o sem-site em 'A verificar'", async () => {
    openPage();
    const botao = await screen.findByRole("button", { name: /Verificar agora/ });
    // c1 (site na web, sem veredito) + c4 (provisório já elegível). c2 é derivado
    // sem-site; c3 é definitivo; c5 está desmarcado.
    expect(botao).toHaveTextContent("Verificar agora (2)");

    const semSite = screen.getByRole("row", { name: /Sem site nenhum/ });
    expect(within(semSite).queryByText("A verificar")).toBeNull();
    expect(within(semSite).getByRole("button", { name: "Ver detalhes" })).toBeVisible();
  });
});

describe("A2: o aviso da prévia e a troca de campanha", () => {
  it("a falha da prévia fica na janela e não vira aviso geral da página", async () => {
    api.post.mockRejectedValueOnce(new Error("A IA demorou demais."));
    openPage();
    const linha = await screen.findByRole("row", { name: /Com site saudável/ });
    fireEvent.click(within(linha).getByRole("button", { name: "Ver detalhes" }));
    const modal = await screen.findByRole("dialog");
    fireEvent.click(within(modal).getByRole("button", { name: "Prévia da abordagem" }));
    const alerta = await within(modal).findByRole("alert");
    expect(alerta).toHaveTextContent("A IA demorou demais.");
    // Um único alerta: o da janela. Nada sobe para o aviso geral.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("trocar de campanha limpa o aviso geral", async () => {
    api.post.mockRejectedValue(new Error("Falha ao marcar a fila."));
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: "Marcar todas" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha ao marcar a fila.");
    fireEvent.click(screen.getByRole("button", { name: /Imobiliária parcial/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("A3: painel de configuração por estado do rascunho", () => {
  it("config parcial (sem agente) mostra o painel e o formulário não fica travado", async () => {
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: /Imobiliária parcial/ }));
    expect(await screen.findByRole("button", { name: "Configurar por conversa" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Usar agente existente / configurar manualmente" }),
    );
    expect(screen.getByLabelText("O que a IA deve oferecer e como iniciar")).toBeEnabled();
  });

  it("config completa continua travada e sem 'Configurar por conversa'", async () => {
    openPage();
    expect(await screen.findByLabelText("Agente de IA")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Configurar por conversa" })).toBeNull();
  });
});

/**
 * H (ORDEM B2): o preparo automático aparece na lista. A verificação do site e a
 * prévia saem sozinhas, em segundo plano; a tela mostra o andamento e o resultado
 * e para de recarregar quando não há mais nada por fazer.
 */
const TEXTO_LONGO =
  "Olá! Vi que a clínica tem nota alta no Google e queria entender como vocês recebem novos pacientes hoje. " +
  "Posso te mostrar em dois minutos como outras clínicas da região organizaram o atendimento no WhatsApp?";

const PREVIA_VALIDA = {
  texto: TEXTO_LONGO,
  baseada_em: `site-ok@${SITE_OK.verificado_em}`,
  gerada_em: "2026-10-16T10:00:00.000Z",
  agente_id: AGENT,
};

function estado(candidates: unknown[]) {
  return { ...fixture(), candidates };
}

describe("H: o preparo automático na lista", () => {
  it("mostra um TRECHO da prévia (140 caracteres) com o texto inteiro no title", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        candidato("p1", COMPLETA, {
          ...empresa("Com prévia pronta", "https://saudavel.test/", SITE_OK),
          previa: PREVIA_VALIDA,
        }),
      ]),
    }));
    openPage();
    const linha = await screen.findByRole("row", { name: /Com prévia pronta/ });
    const trecho = within(linha).getByTitle(TEXTO_LONGO);
    expect(trecho).toHaveTextContent(`${TEXTO_LONGO.slice(0, 140).trimEnd()}…`);
    expect(trecho.textContent!.length).toBeLessThan(TEXTO_LONGO.length);
    expect(within(linha).queryByText("Gerando prévia…")).toBeNull();
  });

  it("'Gerando prévia…' quando a campanha tem agente e o veredito já é definitivo, sem prévia", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        candidato("g1", COMPLETA, empresa("Esperando prévia", "https://saudavel.test/", SITE_OK)),
        candidato("g2", COMPLETA, empresa("Sem site esperando", null, null)),
        // Ainda sem veredito: a espera é pela VERIFICAÇÃO, não se promete prévia.
        candidato("g3", COMPLETA, empresa("Esperando verificação", "https://a.test/", null)),
      ]),
    }));
    openPage();
    const g1 = await screen.findByRole("row", { name: /Esperando prévia/ });
    expect(within(g1).getByText("Gerando prévia…")).toBeVisible();
    const g2 = screen.getByRole("row", { name: /Sem site esperando/ });
    expect(within(g2).getByText("Gerando prévia…")).toBeVisible();
    const g3 = screen.getByRole("row", { name: /Esperando verificação/ });
    expect(within(g3).queryByText("Gerando prévia…")).toBeNull();
  });

  it("campanha sem agente: 'Prévia: escolha o agente na etapa 2' e nunca 'Gerando prévia…'", async () => {
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: /Imobiliária parcial/ }));
    const linha = await screen.findByRole("row", { name: /Da campanha parcial/ });
    expect(within(linha).getByText("Prévia: escolha o agente na etapa 2")).toBeVisible();
    expect(within(linha).queryByText("Gerando prévia…")).toBeNull();
  });

  it("campanha sem agente MAS com agente padrão na organização: 'Gerando prévia…', não 'escolha o agente'", async () => {
    api.get.mockImplementation(async () => ({
      data: {
        ...estado([candidato("pp", PARCIAL, empresa("Parcial com veredito", "https://saudavel.test/", SITE_OK))]),
        previa_padrao: true,
      },
    }));
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: /Imobiliária parcial/ }));
    const linha = await screen.findByRole("row", { name: /Parcial com veredito/ });
    expect(within(linha).queryByText("Prévia: escolha o agente na etapa 2")).toBeNull();
    expect(within(linha).getByText("Gerando prévia…")).toBeVisible();
  });

  it("interruptor 'Gerar a prévia' desligado na busca: a linha explica e nunca promete 'Gerando prévia…'", async () => {
    api.get.mockImplementation(async () => {
      const base = fixture();
      return {
        data: {
          ...base,
          campaigns: base.campaigns.map((c) =>
            c.id === COMPLETA ? { ...c, search: { niche: "x", location: "y", gerar_previa: false } } : c,
          ),
          candidates: [candidato("i1", COMPLETA, empresa("Sem prévia por escolha", "https://saudavel.test/", SITE_OK))],
        },
      };
    });
    openPage();
    const linha = await screen.findByRole("row", { name: /Sem prévia por escolha/ });
    expect(
      within(linha).getByText("Prévia desligada nesta busca: o agente escreve a mensagem na hora do envio."),
    ).toBeVisible();
    expect(within(linha).queryByText("Gerando prévia…")).toBeNull();
    // E o contador de prévias some: não há prévia a esperar.
    expect(screen.queryByText(/Prévias:/)).toBeNull();
  });

  it("campanha antiga (sem as chaves do preparo): a prévia nasce desligada e o site segue verificado (doc 163, B)", async () => {
    api.get.mockImplementation(async () => {
      const base = fixture();
      return {
        data: {
          ...base,
          campaigns: base.campaigns.map((c) =>
            c.id === COMPLETA ? { ...c, search: { niche: "x", location: "y" } } : c,
          ),
          candidates: [candidato("i1", COMPLETA, empresa("Campanha de antes", "https://saudavel.test/", SITE_OK))],
        },
      };
    });
    openPage();
    const linha = await screen.findByRole("row", { name: /Campanha de antes/ });
    expect(
      within(linha).getByText("Prévia desligada nesta busca: o agente escreve a mensagem na hora do envio."),
    ).toBeVisible();
    expect(within(linha).queryByText("Gerando prévia…")).toBeNull();
    expect(screen.queryByText(/Prévias:/)).toBeNull();
    expect(screen.getByText(/Sites verificados:/)).toBeVisible();
  });

  it("interruptor 'Avaliar o site' desligado: o contador avisa em vez de prometer verificação", async () => {
    api.get.mockImplementation(async () => {
      const base = fixture();
      return {
        data: {
          ...base,
          campaigns: base.campaigns.map((c) =>
            c.id === COMPLETA ? { ...c, search: { niche: "x", location: "y", avaliar_site: false } } : c,
          ),
          candidates: [candidato("i2", COMPLETA, empresa("Sem avaliação", "https://a.test/", null))],
        },
      };
    });
    openPage();
    await screen.findByRole("row", { name: /Sem avaliação/ });
    expect(screen.getByText(/Avaliação automática desligada nesta busca/)).toBeVisible();
    expect(screen.queryByText(/Sites verificados:/)).toBeNull();
  });

  it("formulário de busca: os dois interruptores nascem ligados e vão no pedido; sem avaliação a prévia vai desligada", async () => {
    openPage();
    const avaliar = await screen.findByLabelText("Avaliar o site de cada empresa automaticamente");
    const previa = screen.getByLabelText("Gerar a prévia da mensagem automaticamente (consome crédito de IA)");
    expect(avaliar).toBeChecked();
    expect(previa).toBeChecked();
    fireEvent.click(avaliar);
    expect(previa).toBeDisabled();
    expect(previa).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Público ou segmento"), { target: { value: "clínicas" } });
    fireEvent.change(screen.getByLabelText("Cidade ou região"), { target: { value: "Sorocaba, SP" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar empresas" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const corpo = JSON.stringify(api.post.mock.calls[0]);
    expect(corpo).toContain('"avaliar_site":false');
    expect(corpo).toContain('"gerar_previa":false');
  });

  it("prévia que venceu (o site foi verificado de novo) não é mostrada como pronta nem como 'gerando'", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        candidato("v1", COMPLETA, {
          ...empresa("Prévia vencida", "https://saudavel.test/", SITE_OK),
          previa: { ...PREVIA_VALIDA, baseada_em: "site-ok@2020-01-01T00:00:00.000Z" },
        }),
      ]),
    }));
    openPage();
    const linha = await screen.findByRole("row", { name: /Prévia vencida/ });
    expect(within(linha).queryByTitle(TEXTO_LONGO)).toBeNull();
    expect(within(linha).queryByText("Gerando prévia…")).toBeNull();
    expect(within(linha).getByText(/Prévia desatualizada/)).toBeVisible();
  });

  it("contadores 'x de y' contam só as empresas marcadas", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        // verificada + com prévia
        candidato("k1", COMPLETA, {
          ...empresa("K1", "https://saudavel.test/", SITE_OK),
          previa: PREVIA_VALIDA,
        }),
        // verificada, sem prévia
        candidato("k2", COMPLETA, empresa("K2", "https://saudavel.test/", SITE_OK)),
        // sem site na web: verificada (derivado), sem prévia
        candidato("k3", COMPLETA, empresa("K3", null, null)),
        // ainda por verificar
        candidato("k4", COMPLETA, empresa("K4", "https://a.test/", null)),
        // desmarcada: fora das duas contas
        candidato("k5", COMPLETA, empresa("K5", "https://e.test/", null), false),
      ]),
    }));
    openPage();
    expect(await screen.findByText(/Sites verificados:/)).toHaveTextContent(
      "Sites verificados: 3 de 4 · Prévias: 1 de 4",
    );
  });

  it("campanha sem agente conta só os sites (a prévia não tem como sair)", async () => {
    openPage();
    fireEvent.click(await screen.findByRole("button", { name: /Imobiliária parcial/ }));
    const contador = await screen.findByText(/Sites verificados:/);
    expect(contador).toHaveTextContent("Sites verificados: 0 de 1");
    expect(contador).not.toHaveTextContent("Prévias");
  });

  it("campanha antiga (prévia automática desligada): o botão manual 'Prévia da abordagem' segue habilitado (doc 163, B)", async () => {
    api.get.mockImplementation(async () => {
      const base = fixture();
      return {
        data: {
          ...base,
          campaigns: base.campaigns.map((c) =>
            c.id === COMPLETA ? { ...c, search: { niche: "x", location: "y" } } : c,
          ),
          candidates: [candidato("m1", COMPLETA, empresa("Antiga com agente", "https://saudavel.test/", SITE_OK))],
        },
      };
    });
    openPage();
    const linha = await screen.findByRole("row", { name: /Antiga com agente/ });
    fireEvent.click(within(linha).getByRole("button", { name: "Ver detalhes" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByRole("button", { name: "Prévia da abordagem" })).toBeEnabled();
    expect(within(modal).queryByText("Escolha o agente na etapa 2 para ver a prévia.")).toBeNull();
  });

  it("o detalhe mostra a data da verificação e o próximo passo de quem ainda não foi abordado", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        candidato(
          "e1",
          COMPLETA,
          empresa("Site ruim nunca abordado", "https://ruim.test/", {
            ...SITE_OK,
            classe: "site-ruim",
            problemas: ["nao-mobile"],
          }),
        ),
      ]),
    }));
    openPage();
    const linha = await screen.findByRole("row", { name: /Site ruim nunca abordado/ });
    fireEvent.click(within(linha).getByRole("button", { name: "Ver detalhes" }));
    const modal = await screen.findByRole("dialog");
    // SITE_OK.verificado_em = 2026-10-10T12:00Z; o locale da sessão de teste é pt-BR.
    expect(within(modal).getByText(/Verificado em/)).toHaveTextContent("10/10/2026");
    expect(within(modal).queryByText(/Lead contatado sem resposta/)).toBeNull();
    expect(within(modal).getByText(/Gere a prévia da abordagem, revise com seu tom/)).toBeVisible();
  });

  it("empresa sem site não mostra data de verificação: o veredito é derivado, ninguém verificou", async () => {
    openPage();
    const linha = await screen.findByRole("row", { name: /Sem site nenhum/ });
    fireEvent.click(within(linha).getByRole("button", { name: "Ver detalhes" }));
    const modal = await screen.findByRole("dialog");
    // Controle positivo: a auditoria do derivado está na janela.
    expect(within(modal).getByText("Sem site próprio")).toBeVisible();
    expect(within(modal).queryByText(/Verificado em/)).toBeNull();
  });

  it("veredito sem-site GRAVADO também não mostra data: vereditoPuro não abre conexão", async () => {
    // A cura de site-enrich.ts grava o sem-site com o instante do UPDATE; a prova
    // de tela de 21/10 mostrou "Verificado em 21/10/2026" numa empresa sem site.
    const semSiteGravado = { ...SITE_OK, classe: "sem-site", checklist: { tem: [], falta: [] }, final_url: null, http_status: null, tempo_ms: 0 };
    api.get.mockImplementation(async () => {
      const f = fixture();
      f.candidates[1] = candidato("c2", COMPLETA, empresa("Sem site nenhum", null, semSiteGravado));
      return { data: f };
    });
    openPage();
    const linha = await screen.findByRole("row", { name: /Sem site nenhum/ });
    fireEvent.click(within(linha).getByRole("button", { name: "Ver detalhes" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("Sem site próprio")).toBeVisible();
    expect(within(modal).queryByText(/Verificado em/)).toBeNull();
  });

  it("o botão manual 'Prévia da abordagem' continua no detalhe", async () => {
    openPage();
    const linha = await screen.findByRole("row", { name: /Com site saudável/ });
    fireEvent.click(within(linha).getByRole("button", { name: "Ver detalhes" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByRole("button", { name: "Prévia da abordagem" })).toBeEnabled();
  });
});

describe("H: recarrega sozinha enquanto há o que preparar, e para quando zera", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const passar = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("busca nova em andamento com a lista VAZIA recarrega até as empresas chegarem", async () => {
    const buscando = {
      ...estado([]),
      campaigns: fixture().campaigns.map((c) =>
        c.id === COMPLETA ? { ...c, search_status: "running", result_count: 0 } : c,
      ),
    };
    const concluida = estado([
      candidato("b1", COMPLETA, {
        ...empresa("B1", "https://saudavel.test/", SITE_OK),
        previa: PREVIA_VALIDA,
      }),
    ]);
    api.get.mockResolvedValueOnce({ data: buscando }).mockResolvedValue({ data: concluida });
    openPage();
    await passar(100);
    expect(api.get).toHaveBeenCalledTimes(1);
    await passar(10_000);
    expect(api.get).toHaveBeenCalledTimes(2); // a busca andava: recarregou sem F5
    await passar(60_000);
    expect(api.get).toHaveBeenCalledTimes(2); // busca concluída e nada por preparar: parou
  });

  it("com tudo pronto (sites verificados e prévias geradas) NÃO recarrega", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        candidato("r1", COMPLETA, {
          ...empresa("R1", "https://saudavel.test/", SITE_OK),
          previa: PREVIA_VALIDA,
        }),
        candidato("r2", COMPLETA, {
          ...empresa("R2", null, null),
          previa: { ...PREVIA_VALIDA, baseada_em: "sem-site@derivado" },
        }),
      ]),
    }));
    openPage();
    await passar(100);
    expect(api.get).toHaveBeenCalledTimes(1);
    await passar(60_000);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("com prévia por gerar recarrega a cada 10 s e PARA quando as prévias chegam", async () => {
    const pendente = estado([
      candidato("s1", COMPLETA, empresa("S1", "https://saudavel.test/", SITE_OK)),
    ]);
    const pronto = estado([
      candidato("s1", COMPLETA, {
        ...empresa("S1", "https://saudavel.test/", SITE_OK),
        previa: PREVIA_VALIDA,
      }),
    ]);
    api.get.mockResolvedValueOnce({ data: pendente }).mockResolvedValue({ data: pronto });
    openPage();
    await passar(100);
    expect(api.get).toHaveBeenCalledTimes(1);
    await passar(10_000);
    expect(api.get).toHaveBeenCalledTimes(2); // recarregou: havia prévia por gerar
    await passar(60_000);
    expect(api.get).toHaveBeenCalledTimes(2); // e parou: os dois contadores zeraram
  });

  it("com site por verificar recarrega, e para quando o veredito (e a prévia) chegam", async () => {
    const pendente = estado([candidato("v1", COMPLETA, empresa("V1", "https://a.test/", null))]);
    const verificado = estado([
      candidato("v1", COMPLETA, {
        ...empresa("V1", "https://a.test/", SITE_OK),
        previa: PREVIA_VALIDA,
      }),
    ]);
    api.get.mockResolvedValueOnce({ data: pendente }).mockResolvedValue({ data: verificado });
    openPage();
    await passar(100);
    await passar(10_000);
    expect(api.get).toHaveBeenCalledTimes(2);
    await passar(60_000);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("campanha sem agente não fica recarregando à espera de prévia que não vem", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        candidato("n1", PARCIAL, empresa("N1", null, null)),
        candidato("n2", PARCIAL, empresa("N2", "https://saudavel.test/", SITE_OK)),
      ]),
    }));
    openPage();
    await passar(100);
    await passar(60_000);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("desmarcada e já abordada não seguram o recarregamento", async () => {
    api.get.mockImplementation(async () => ({
      data: estado([
        candidato("d1", COMPLETA, empresa("D1", "https://saudavel.test/", SITE_OK), false),
        {
          ...candidato("d2", COMPLETA, empresa("D2", "https://saudavel.test/", SITE_OK)),
          status: "sent",
        },
      ]),
    }));
    openPage();
    await passar(100);
    await passar(60_000);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
