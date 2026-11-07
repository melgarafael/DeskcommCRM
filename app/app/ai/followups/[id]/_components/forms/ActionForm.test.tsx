/**
 * Seguimento do #3056 — o passo de modelo cujo id não está em nenhuma lista da
 * conta (importado de outra conta, ou modelo apagado) mostrava o seletor EM
 * BRANCO. Agora mostra o placeholder e um aviso. Sem react-query nem rede: os
 * dois hooks de lista são trocados por teste.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActionForm } from "./ActionForm";

type Consulta<T> = { data?: T; isLoading: boolean; isError: boolean; isSuccess: boolean };
const pronta = <T,>(data: T): Consulta<T> => ({ data, isLoading: false, isError: false, isSuccess: true });

const DA_CONTA = "22222222-2222-4222-8222-222222222222";
const DE_FORA = "33333333-3333-4333-8333-333333333333";
const AVISO = "O modelo que estava aqui não está disponível nesta conta. Escolha um modelo para este passo.";

let textos: Consulta<{ id: string; title: string }[]> = pronta([{ id: DA_CONTA, title: "Boas-vindas" }]);
let aprovados: Consulta<{ id: string; name: string; language: string; texto: string }[]> = pronta([]);
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  // Sem grupo (#3245): a barra e o slash-menu são os de antes dos grupos.
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => textos }));
vi.mock("@/hooks/followup/useModelosAprovadosDoFluxo", () => ({ useModelosAprovadosDoFluxo: () => aprovados }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const renderizar = (templateId: string) =>
  render(<ActionForm config={{ mode: "template", template_id: templateId }} onChange={() => {}} />);

describe("ActionForm — modelo que não existe nesta conta", () => {
  it("mostra o placeholder e o aviso no lugar do seletor em branco", () => {
    textos = pronta([{ id: DA_CONTA, title: "Boas-vindas" }]);
    aprovados = pronta([]);
    renderizar(DE_FORA);
    expect(screen.getByRole("alert").textContent).toBe(AVISO);
    expect(screen.getByRole("combobox", { name: "Modelo de mensagem" }).textContent).toBe("Escolha um modelo");
  });

  it("modelo da conta: sem aviso, com o nome no seletor", () => {
    textos = pronta([{ id: DA_CONTA, title: "Boas-vindas" }]);
    aprovados = pronta([]);
    renderizar(DA_CONTA);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Modelo de mensagem" }).textContent).toBe("Boas-vindas");
  });

  it("lista que falhou não prova ausência: não avisa", () => {
    textos = { data: undefined, isLoading: false, isError: true, isSuccess: false };
    aprovados = pronta([{ id: DA_CONTA, name: "ola", language: "pt_BR", texto: "Olá" }]);
    renderizar(DE_FORA);
    expect(screen.queryByText(AVISO)).toBeNull();
  });
});
