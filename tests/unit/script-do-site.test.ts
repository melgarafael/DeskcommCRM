// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { CHAVES_DE_CAPTURA_GOOGLE } from "@/lib/plataformas-de-anuncio/google/metadados-da-campanha";

const source = readFileSync("public/rastreio/v1.js", "utf8");
const windows: JSDOM[] = [];
function site(query = "", stored?: string, extra = "", blocked = false) {
  const dom = new JSDOM(
    `<a id="target" href="https://wa.me/5511999999999?text=original">WhatsApp</a><a id="other" href="https://wa.me/5521888888888">Outro</a><a id="lookalike" href="https://wa.me.evil.test/5511999999999">Falso</a><script src="https://crm.example/rastreio/v1.js" data-org="loja" data-google-whatsapp="5511999999999" data-meta-whatsapp="5511999999999" ${extra}></script>`,
    { url: `https://site.example/${query}`, runScripts: "outside-only" },
  );
  windows.push(dom);
  const { window } = dom;
  const key = "rastreio:v1:https://crm.example:loja";
  if (stored) window.sessionStorage.setItem(key, stored);
  if (blocked)
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  Object.defineProperty(window.document, "currentScript", {
    value: window.document.querySelector("script"),
  });
  const run = () => runInContext(source, dom.getInternalVMContext());
  run();
  return {
    dom,
    window,
    key,
    run,
    link: window.document.querySelector<HTMLAnchorElement>("#target")!,
  };
}
afterEach(() => {
  windows.splice(0).forEach((dom) => dom.window.close());
});

describe("script público do site", () => {
  it("a lista da página acompanha as chaves de campanha que o servidor aceita", () => {
    for (const chave of CHAVES_DE_CAPTURA_GOOGLE) expect(source).toContain(`"${chave}"`);
  });
  it("preserva IDs decimais longos e rótulos, descarta macros e dados privados", () => {
    const { link, window, key } = site(`?${new URLSearchParams({
      gclid: "click-real",
      campaignid: "90071992547409930001",
      adgroupid: "456",
      ad_id: "789",
      google_customer_id: "1234567890",
      utm_campaign: "Pesquisa Rio",
      utm_adset: "Grupo Barra",
      utm_ad: "Anúncio A",
      creative: "{creative}",
      customerid: "gclid-nao-e-conta",
      utm_content: "https://site.example/privado",
      phone: "privado",
    })}`);
    expect(Object.fromEntries(new URL(link.href).searchParams)).toEqual({
      gclid: "click-real",
      campaignid: "90071992547409930001",
      adgroupid: "456",
      ad_id: "789",
      google_customer_id: "1234567890",
      utm_campaign: "Pesquisa Rio",
      utm_adset: "Grupo Barra",
      utm_ad: "Anúncio A",
    });
    expect(window.sessionStorage.getItem(key)).not.toContain("privado");
    expect(window.sessionStorage.getItem(key)).not.toContain("{creative}");
  });
  it.each(["gclid", "gbraid", "wbraid"])(
    "preserva %s, filtra parâmetros e só muda o número configurado",
    (name) => {
      const { window, link, key } = site(`?${name}=real-123&utm_campaign=oferta&email=privado`);
      const url = new URL(link.href);
      expect(url.origin + url.pathname).toBe("https://crm.example/api/v1/anuncios/google/loja");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        [name]: "real-123",
        utm_campaign: "oferta",
      });
      expect(window.sessionStorage.getItem(key)).not.toContain("privado");
      expect(window.document.querySelector("#other")!.getAttribute("href")).toBe(
        "https://wa.me/5521888888888",
      );
      expect(window.document.querySelector("#lookalike")!.getAttribute("href")).toContain(
        "evil.test",
      );
    },
  );
  it("recupera a origem na próxima página e envia UTMs ao caminho do site", () => {
    const first = site("?utm_source=instagram&utm_campaign=oferta&utm_adset=grupo");
    const next = site("catalogo", first.window.sessionStorage.getItem(first.key)!);
    expect(next.link.href).toContain("/anuncios/meta/loja?");
    expect(new URL(next.link.href).searchParams.get("utm_adset")).toBe("grupo");
  });
  it("parâmetro genérico de conta numa página comum não troca a origem da sessão", () => {
    const { link } = site("?customer_id=1234567890", JSON.stringify({ gclid: "clique-anterior", utm_campaign: "Anterior" }));
    expect(Object.fromEntries(new URL(link.href).searchParams)).toEqual({ gclid: "clique-anterior", utm_campaign: "Anterior" });
  });
  it("UTM não Google mantém a truncagem anterior", () => {
    const { link } = site(`?utm_campaign=${"a".repeat(201)}`);
    expect(new URL(link.href).searchParams.get("utm_campaign")).toBe("a".repeat(200));
  });
  it("não mistura campanhas novas com um clique antigo", () => {
    const { link } = site(
      "?wbraid=novo",
      JSON.stringify({ gclid: "velho", utm_campaign: "antiga" }),
    );
    expect(new URL(link.href).searchParams.toString()).toBe("wbraid=novo");
  });
  it("sem origem, com macro ou storage corrompido mantém o WhatsApp", () => {
    for (const query of ["", "?gclid=%7Bgclid%7D", "?gclid=%3Cscript%3E"]) {
      expect(site(query, "bad-json").link.href).toBe("https://wa.me/5511999999999?text=original");
    }
  });
  it("uma origem explícita inválida limpa a anterior em vez de reaproveitar outro clique", () => {
    const { link, window, key } = site("?gclid=%7Bgclid%7D", JSON.stringify({ gclid: "antigo" }));
    expect(link.href).toBe("https://wa.me/5511999999999?text=original");
    expect(window.sessionStorage.getItem(key)).toBe("{}");
  });
  it("storage bloqueado ou desligado não impede capturar a página atual", () => {
    expect(site("?gclid=real", undefined, "", true).link.href).toContain("gclid=real");
    const disabled = site("?gclid=real", undefined, 'data-storage="none"');
    expect(disabled.link.href).toContain("gclid=real");
    expect(disabled.window.sessionStorage.getItem(disabled.key)).toBeNull();
  });
  it("links dinâmicos, exclusão e alteração pelo site não geram loop", async () => {
    const { window, link } = site("?gclid=real");
    const dynamic = window.document.createElement("a");
    dynamic.href = "https://api.whatsapp.com/send?phone=5511999999999";
    window.document.body.append(dynamic);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dynamic.href).toContain("/anuncios/google/");
    link.setAttribute("data-rastreio-ignorar", "");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(link.href).toBe("https://wa.me/5511999999999?text=original");
    dynamic.href = "https://example.org/";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dynamic.href).toBe("https://example.org/");
  });
  it("duas inclusões e cliques com teclado preservam uma única captura", () => {
    const { window, link, run } = site("?gclid=primeiro");
    run();
    window.history.pushState({}, "", "/novo?wbraid=segundo");
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    // Evita navegação apenas no teste; o script não pode cancelar o clique.
    link.addEventListener("click", (e) => {
      expect(e.defaultPrevented).toBe(false);
      e.preventDefault();
    });
    link.dispatchEvent(event);
    expect(new URL(link.href).searchParams.toString()).toBe("wbraid=segundo");
  });
});

describe("script com link nomeado", () => {
  const id = "11223344-1111-4111-8111-112233445566";
  const attrs = `data-link-id="${id}" data-whatsapp="5511999999999"`;
  it("captura clique orgânico sem alterar o outro número", () => {
    const { link, window } = site("", undefined, attrs);
    expect(link.href).toBe(`https://crm.example/api/v1/rastreio/${id}`);
    expect(window.document.querySelector<HTMLAnchorElement>("#other")!.href).toBe(
      "https://wa.me/5521888888888",
    );
  });
  it("preserva identificadores sem parâmetros privados", () => {
    const { link } = site("?gbraid=abc&utm_campaign=teste&email=privado", undefined, attrs);
    expect(new URL(link.href).searchParams.toString()).toBe("gbraid=abc&utm_campaign=teste");
  });
  it("UUID inválido desliga o script em vez de construir rota arbitrária", () => {
    expect(
      site("?gclid=real", undefined, 'data-link-id="../admin" data-whatsapp="5511999999999"').link
        .href,
    ).toContain("wa.me");
  });
});
