import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * O LOGO NA FACHADA — as telas que existem antes de qualquer sessão.
 *
 * POR QUE ESTE ARQUIVO EXISTE: até esta onda o login renderizava só texto, e
 * `platform_branding.logo_url` não tinha um único leitor no produto. Quem
 * instala o sistema para clientes mostra a marca dele exatamente aqui — é a
 * primeira tela que o cliente do revendedor abre na vida, e a última que alguém
 * lembra de conferir.
 *
 * ── Por que renderizar o LAYOUT, e não a página ───────────────────────────────
 *
 * O `<img>` mora em `app/(public)/layout.tsx` porque são SEIS telas no grupo
 * (login, cadastro, recuperação, redefinição, MFA, códigos de recuperação) e uma
 * cópia por página divergiria na primeira vez que alguém mexesse numa só. O
 * teste segue o código: mede a casca, que é onde a decisão está.
 *
 * ── Por que `renderToStaticMarkup`, e não Testing Library ─────────────────────
 *
 * É um Server Component async: `render()` da Testing Library não sabe esperar a
 * promessa. Chamar a função e renderizar a árvore que ela devolve é o caminho
 * honesto — e mede o HTML de verdade, não a presença do símbolo `logoUrl` no
 * arquivo.
 */

const marcaDaSaida = vi.hoisted(() => vi.fn());
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida }));
// A casca passou a resolver o idioma da interface (ver `IdiomaProvider` no
// próprio layout) e por isso chama `createClient()`, que lê cookies — algo que
// só existe dentro de uma requisição real. Fora do login quase nunca há
// sessão, e o mock reflete exatamente isso: nenhum usuário.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));

const MARCA: MarcaDeSaida = {
  nome: "Vendas Turbo",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
};

async function fachada(marca: MarcaDeSaida): Promise<string> {
  marcaDaSaida.mockResolvedValue(marca);
  const { default: PublicLayout } = await import("@/app/(public)/layout");
  return renderToStaticMarkup(await PublicLayout({ children: <p>formulário</p> }));
}

describe("a casca das telas de acesso", () => {
  beforeEach(() => {
    vi.resetModules();
    marcaDaSaida.mockReset();
  });

  it("com logo configurado, a fachada o desenha", async () => {
    const html = await fachada({ ...MARCA, logoUrl: "https://cdn.exemplo.test/revenda.png" });

    expect(html).toContain('src="https://cdn.exemplo.test/revenda.png"');
    // Legendado com a marca DESTA resolução: é ela que produziu a imagem.
    expect(html).toContain('alt="Vendas Turbo"');
    // Guarda de vacuidade: sem o conteúdo, a asserção de cima poderia estar
    // medindo uma casca que engoliu o formulário de login.
    expect(html).toContain("formulário");
  });

  it("sem marca configurada, a fachada desenha o logo do produto", async () => {
    // O padrão do produto resolve `logoUrl` para o lockup em `public/brand/`:
    // a primeira tela que alguém abre já carrega a marca, em vez de texto.
    const { DEFAULT_APP_NAME } = await import("@/lib/branding");
    const html = await fachada({
      nome: DEFAULT_APP_NAME,
      logoUrl: "/brand/canti-crm-logo-full.png",
      accent: "#2f6f4e",
      accentFg: "#ffffff",
      origens: { nome: "padrao", cor: "padrao" },
    });

    expect(html).toContain('src="/brand/canti-crm-logo-full.png"');
    expect(html).toContain(`alt="${DEFAULT_APP_NAME}"`);
    expect(html).toContain("formulário");
  });

  it("sem logo, nenhuma imagem — e nunca um `src` vazio", async () => {
    const html = await fachada(MARCA);

    // `<img src="">` faz o navegador pedir a própria página e desenhar o ícone
    // de imagem quebrada no topo do login. É o estado de fábrica de TODA
    // instalação nova, então o caminho normal não pode ter esse defeito.
    expect(html).not.toContain("<img");
    expect(html).toContain("formulário");
  });

  it("a fachada resolve a marca SEM organização — é o que `null` declara ali", async () => {
    await fachada(MARCA);

    // `marcaDaSaida(orgId)` com um id monta a pilha da organização. Na tela de
    // login não existe organização resolvida (ninguém entrou), e passar
    // qualquer outra coisa aqui seria inventar um tenant para pintar a fachada.
    expect(marcaDaSaida).toHaveBeenCalledWith(null);
  });
});
