import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AuditoriaDoCandidato, type PreviaDaAbordagem } from "./_auditoria-site";
import type { Prospect } from "@/lib/prospecting/schema";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

function candidato(site: Prospect["site"]): Prospect {
  return {
    key: "k",
    name: "Clínica Vitta",
    phone: "+5511999990000",
    website: "https://vitta.test/",
    category: "Estética",
    address: "Rua X",
    maps_url: null,
    rating: 5.0,
    reviews: 120,
    emails: [],
    socials: [],
    site,
  };
}

const SITE_OK: NonNullable<Prospect["site"]> = {
  ver: 1,
  classe: "site-ok",
  problemas: [],
  checklist: { tem: ["tel"], falta: [] },
  final_url: "https://vitta.test/",
  http_status: 200,
  tempo_ms: 300,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
  provisorio: false,
  tentativas: 0,
};

function props(data: Prospect) {
  return {
    candidateId: "cand-1",
    data,
    ofertas: ["site"] as Array<"site">,
    nicho: "clínica",
    status: "new",
    disabled: false,
    // Campanha com agente: o caso comum. O caso sem agente é testado à parte.
    temAgente: true,
    onReanalisar: vi.fn(async () => undefined),
    onPrevia: vi.fn(async () => null),
  };
}

beforeAll(() => {
  // jsdom não implementa `scrollIntoView`; o A1 depende dele para trazer a
  // prévia para a área visível da janela.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("AuditoriaDoCandidato: resumo na linha, total no modal", () => {
  it("sem site mostra só o pendente com esqueleto, sem botões", () => {
    render(<AuditoriaDoCandidato {...props(candidato(null))} />);
    expect(screen.getByText("A verificar")).toBeVisible();
    expect(document.querySelector("[data-esqueleto]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Ver detalhes" })).toBeNull();
    expect(screen.queryByText(/Score/)).toBeNull();
  });

  it("com site mostra score + veredito de uma linha, sem o total", () => {
    render(<AuditoriaDoCandidato {...props(candidato({ ...SITE_OK }))} />);
    // "Score" e o número vivem em nós de texto separados dentro do Badge.
    // site-ok + nota 5.0 + 120 avaliações = 40 + 30 + 10 = 80.
    expect(screen.getByText((_, el) => el?.textContent === "Score 80")).toBeVisible();
    // Estratégia e objeções moram no modal, não na linha.
    expect(screen.queryByText("Estratégia de abordagem")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reanalisar site" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ver detalhes" })).toBeVisible();
  });

  it("abrir o modal mostra o total + ações, e a prévia renderiza a mensagem", async () => {
    const onPrevia = vi.fn(async () => ({
      mensagem: "Olá!",
      estrategia: { cenario: "", angulo: "", ganchos: [], objecoes: [], proximoPasso: "" },
      score: { valor: 0, motivo: "" },
    }));
    render(<AuditoriaDoCandidato {...props(candidato({ ...SITE_OK }))} onPrevia={onPrevia} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reanalisar site" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Prévia da abordagem" }));
    await waitFor(() => expect(screen.getByText("Olá!")).toBeVisible());
    expect(onPrevia).toHaveBeenCalledWith("cand-1");
  });

  it("motivo igual ao veredito não repete na linha", () => {
    const semSite = {
      ver: 1,
      classe: "sem-site",
      problemas: [],
      checklist: { tem: [], falta: ["whatsapp", "tel"] },
      final_url: null,
      http_status: null,
      tempo_ms: 0,
      conteudo_resumo: null,
      pagespeed: null,
      verificado_em: "2026-10-10T12:00:00.000Z",
      provisorio: false,
      tentativas: 0,
    } as NonNullable<Prospect["site"]>;
    const { container } = render(<AuditoriaDoCandidato {...props(candidato(semSite))} />);
    const ocorrencias = container.textContent?.match(/sem site próprio/gi) ?? [];
    expect(ocorrencias).toHaveLength(1);
  });

  const PREVIA: PreviaDaAbordagem = {
    mensagem: "Olá, vi o site de vocês.",
    estrategia: { cenario: "", angulo: "", ganchos: [], objecoes: [], proximoPasso: "" },
    score: { valor: 0, motivo: "" },
  };

  it("A1: a prévia pede rolagem para o próprio texto, com block=nearest", async () => {
    const rolagem = vi.mocked(Element.prototype.scrollIntoView);
    rolagem.mockClear();
    const onPrevia = vi.fn(async () => PREVIA);
    render(<AuditoriaDoCandidato {...props(candidato({ ...SITE_OK }))} onPrevia={onPrevia} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Prévia da abordagem" }));
    await screen.findByText(PREVIA.mensagem);
    const rolado = rolagem.mock.contexts.find(
      (alvo) => alvo instanceof Element && alvo.textContent?.includes(PREVIA.mensagem),
    );
    expect(rolado, "o elemento rolado precisa ser o que contém o texto da prévia").toBeTruthy();
    expect(
      rolagem.mock.calls.some(
        ([opcoes]) =>
          typeof opcoes === "object" && opcoes !== null && opcoes.block === "nearest",
      ),
    ).toBe(true);
  });

  it("A2: falha da prévia aparece na janela e não sobe para o aviso geral", async () => {
    const onPrevia = vi.fn(async () => {
      throw new Error("A IA não respondeu a tempo.");
    });
    render(<AuditoriaDoCandidato {...props(candidato({ ...SITE_OK }))} onPrevia={onPrevia} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    const modal = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Prévia da abordagem" }));
    const alerta = await within(modal).findByRole("alert");
    expect(alerta).toHaveTextContent("A IA não respondeu a tempo.");
    // Um único alerta: o da janela. Nada vaza para o aviso geral da página.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("A3: sem agente na campanha, a prévia fica desabilitada com a explicação ao lado", async () => {
    render(
      <AuditoriaDoCandidato
        {...props(candidato({ ...SITE_OK }))}
        temAgente={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Prévia da abordagem" })).toBeDisabled();
    expect(screen.getByText("Escolha o agente na etapa 2 para ver a prévia.")).toBeVisible();
  });

  it("A3: com agente, a prévia fica habilitada e a frase não aparece", async () => {
    render(<AuditoriaDoCandidato {...props(candidato({ ...SITE_OK }))} temAgente />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Prévia da abordagem" })).toBeEnabled();
    expect(screen.queryByText("Escolha o agente na etapa 2 para ver a prévia.")).toBeNull();
  });
});
