/**
 * A PRÉVIA DO LOGO NÃO DEPENDE DO `router.refresh()` CHEGAR.
 *
 * ── O defeito que este arquivo guarda ───────────────────────────────────────
 *
 * `CampoDeLogo` sobe o arquivo por `fetch`, mostra "Logo atualizado" e pedia ao
 * `router.refresh()` que trouxesse o render novo com a prévia. O refresh é uma
 * requisição RSC solta, sem retentativa e sem ninguém esperando por ela — e
 * nesta base ela perde a corrida contra a rajada de prefetch da barra lateral.
 *
 * MEDIDO no trace do run 31888655412 (caso (1) de `tests/e2e/marca-logo.spec.ts`,
 * `trace: retain-on-failure`), na ordem em que os eventos saíram:
 *
 *   14:18:45.983  POST /api/v1/marca/logo           200  {"data":{"logo_url":"…/platform/4f9c…png"}}
 *   14:18:46.497  GET  /admin/marca?_rsc=3gU9L6A6…  net::ERR_ABORTED   bodySize=-1
 *   14:18:47.07 → 14:19:01   NADA na rede. Nenhuma retentativa.
 *
 * Que o aborto é fato de transporte, e não como o Playwright grava todo stream
 * RSC, está calibrado no mesmo arquivo: 25 respostas `_rsc=` do mesmo trace
 * gravaram corpo (`/admin/audit?_rsc=OOqhuDY82…`, 14:18:46.773, bodySize=1030 —
 * 276ms DEPOIS do refresh abortado, mesmo servidor, mesma janela).
 *
 * O resultado na tela: a prévia continuou mostrando o nome em texto e a seção
 * "De onde vem cada coisa" continuou dizendo "padrão do sistema", logo abaixo de
 * um toast dizendo que o logo foi atualizado. Para quem instala numa VPS, é a
 * primeira impressão do produto contradizendo a si mesma.
 *
 * ── Por que o teste dubla o refresh como NO-OP ──────────────────────────────
 *
 * Um refresh abortado é, do ponto de vista do componente, um refresh que nunca
 * repõe as props. É exatamente isso que `refreshMock` faz: é chamado e não muda
 * nada. Se a prévia aparecer assim, ela não depende mais dele — que é a
 * propriedade, e não "o teste é rápido".
 *
 * O caso (3) existe para o conserto não passar do ponto: quando o servidor DE
 * FATO traz novidade (navegação, refresh que chegou, outra aba), quem manda
 * volta a ser a prop. Um estado local grudento esconderia o servidor — trocaria
 * um defeito por outro, e este arquivo ficaria verde nos dois.
 *
 * ⚠️ E o (3) rerenderiza com `{ url: null }` — objeto NOVO, valor IGUAL ao de
 * antes — porque é exatamente esse o caso que a primeira versão deste conserto
 * errava. Com `logoDaCamada: string | null`, identidade É igualdade: um render
 * novo dizendo `null` para uma camada que já estava `null` não se distinguia de
 * render nenhum, e a prévia ficava grudada no que o cliente tinha escrito. O
 * teste pegou; foi por isso que a prop virou objeto. Se alguém "simplificar" o
 * tipo de volta para a string, é este caso que fica vermelho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampoDeLogo } from "@/components/branding/CampoDeLogo";

const URL_SUBIDA =
  "http://127.0.0.1:54321/storage/v1/object/public/brand-logos/platform/4f9c10de.png";
const URL_HERDADA = "http://127.0.0.1:54321/storage/v1/object/public/brand-logos/padrao.png";

const fetchMock = vi.fn();

/** A resposta que a rota real devolve — copiada do corpo gravado no trace. */
function respostaOk(corpo: unknown): Response {
  return {
    ok: true,
    json: async () => corpo,
  } as unknown as Response;
}

function pintar(props: Partial<Parameters<typeof CampoDeLogo>[0]> = {}) {
  return render(
    <CampoDeLogo
      escopo="instalacao"
      logoDaCamada={{ url: null }}
      logoHerdado={null}
      origemDoHerdado="do arquivo de instalação do servidor"
      nomeEmVigor="SonghaiCRM"
      {...props}
    />,
  );
}

/** O `<img>` da prévia clara — o mesmo seletor que a spec e2e mede. */
function previaClara(): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>("[data-previa-do-logo='claro'] img");
}

function escolherArquivo() {
  const entrada = document.querySelector<HTMLInputElement>("#logo-instalacao")!;
  const arquivo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", {
    type: "image/png",
  });
  fireEvent.change(entrada, { target: { files: [arquivo] } });
}

describe("a prévia do logo não espera o router.refresh()", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    refreshMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("(1) mostra o logo subido mesmo quando o refresh nunca repõe as props", async () => {
    fetchMock.mockResolvedValue(
      respostaOk({ data: { logo_path: "platform/4f9c10de.png", logo_url: URL_SUBIDA } }),
    );
    pintar({ logoDaCamada: { url: null }, logoHerdado: null });

    // Estado de partida: sem logo em camada nenhuma, a prévia é o nome em texto.
    expect(previaClara()).toBeNull();

    escolherArquivo();

    await waitFor(() => expect(previaClara()).not.toBeNull());
    expect(previaClara()!.getAttribute("src")).toBe(URL_SUBIDA);
    // O botão só existe quando ESTA camada tem logo próprio — e agora ela tem.
    expect(screen.getByRole("button", { name: /^remover$/i })).toBeInTheDocument();
    // E o texto acima da prévia não pode dizer "sem logo próprio" com o logo à vista.
    expect(screen.queryByText(/Sem logo próprio/i)).toBeNull();
  });

  it("(2) remover devolve a prévia ao herdado sem esperar o refresh", async () => {
    fetchMock.mockResolvedValue(respostaOk({ data: { logo_path: null, logo_url: null } }));
    pintar({ logoDaCamada: { url: URL_SUBIDA }, logoHerdado: URL_HERDADA });

    expect(previaClara()!.getAttribute("src")).toBe(URL_SUBIDA);

    fireEvent.click(screen.getByRole("button", { name: /^remover$/i }));

    // `logo_url: null` é "esta camada ficou sem logo próprio", e não "a resposta
    // não trouxe o campo": a prévia tem de CAIR no herdado, não continuar no que
    // acabou de ser apagado.
    await waitFor(() => expect(previaClara()!.getAttribute("src")).toBe(URL_HERDADA));
    expect(screen.queryByRole("button", { name: /^remover$/i })).toBeNull();
  });

  it("(3) o servidor volta ao comando quando um render novo traz outra coisa", async () => {
    fetchMock.mockResolvedValue(
      respostaOk({ data: { logo_path: "platform/4f9c10de.png", logo_url: URL_SUBIDA } }),
    );
    const { rerender } = pintar({ logoDaCamada: { url: null }, logoHerdado: null });

    escolherArquivo();
    await waitFor(() => expect(previaClara()?.getAttribute("src")).toBe(URL_SUBIDA));

    // O refresh chegou (ou a pessoa navegou, ou outra aba trocou o logo) e o
    // servidor diz outra coisa. Quem manda é ele, não a memória do clique.
    rerender(
      <CampoDeLogo
        escopo="instalacao"
        logoDaCamada={{ url: null }}
        logoHerdado={URL_HERDADA}
        origemDoHerdado="do arquivo de instalação do servidor"
        nomeEmVigor="SonghaiCRM"
      />,
    );

    expect(previaClara()!.getAttribute("src")).toBe(URL_HERDADA);
    expect(screen.queryByRole("button", { name: /^remover$/i })).toBeNull();
  });

  it("(4) o refresh continua sendo disparado — o resto da página ainda depende dele", async () => {
    fetchMock.mockResolvedValue(
      respostaOk({ data: { logo_path: "platform/4f9c10de.png", logo_url: URL_SUBIDA } }),
    );
    pintar({ logoDaCamada: { url: null }, logoHerdado: null });

    escolherArquivo();

    // A seção "De onde vem cada coisa" é irmã deste componente e continua vindo
    // do servidor: parar de chamar o refresh consertaria a prévia e deixaria
    // aquela seção mentindo até a próxima navegação.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });
});
