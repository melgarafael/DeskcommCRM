/**
 * A MARCA VISTA PELO CLIENT COMPONENT É A MESMA NOS DOIS LADOS DA FRONTEIRA.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO EXISTE PARA IMPEDIR ═══
 *
 * `branding()` (`lib/branding.ts`) lê fontes DIFERENTES em cada lado:
 * `window.__PUBLIC_ENV__` no navegador, `process.env` no servidor. Enquanto o
 * `<PublicEnvScript/>` injetava o `.env` cru, as duas diziam a mesma coisa e a
 * assimetria era invisível. Quando `app/layout.tsx` passou a injetar a marca
 * RESOLVIDA (banco acima do `.env`), elas divergiram — e o caso que dispara a
 * divergência é o NORMAL: operador sobe o logo pela tela, `APP_LOGO_URL` fica
 * vazio no `.env`.
 *
 * Medido no HEAD anterior a esta correção, com exatamente esse estado:
 *
 *   servidor  → <span class="font-semibold …">SonghaiCRM</span>
 *   navegador → <link rel="preload" as="image" …><img src="…/logo.png" …>
 *
 * Trocar o TIPO do elemento entre SSR e hidratação é React #418: o CI acusou em
 * 7 de 7 telas de `/app/ai/*`, e o React descarta e regera a árvore no cliente.
 *
 * ═══ POR QUE A COMPARAÇÃO ABAIXO É FIEL, E NÃO UM TRUQUE DE jsdom ═══
 *
 * Em jsdom `typeof window !== "undefined"` é SEMPRE verdadeiro, então não dá
 * para "desligar o servidor". Não é preciso: o que distingue os dois lados no
 * produto é o VALOR que cada um enxerga, e ele é reproduzível aqui.
 *
 *   - Lado servidor: não existe `window.__PUBLIC_ENV__` (o script ainda não
 *     rodou) e o `.env` está vazio → a marca que `branding()` devolve é o padrão
 *     do produto. É o que o SSR produz numa instalação de fábrica com logo só no
 *     banco.
 *   - Lado navegador: `window.__PUBLIC_ENV__` carrega a marca do banco.
 *
 * Se o componente lê a marca por PROP do servidor, os dois renders são iguais
 * por construção. Se ele volta a lê-la de uma fonte que só um dos lados enxerga,
 * eles divergem — e é isso que o `toBe` cobra.
 *
 * ═══ SABOTAGEM QUE ESTE ARQUIVO JÁ REPROVOU ═══
 *
 * `useMarcaDaInstalacao()` devolvendo `branding()` em vez do valor do contexto
 * (ou seja: o defeito de volta, com o conserto no lugar): 3 asserções vermelhas
 * — os dois casos de igualdade e a catraca de `"use client"`.
 */
import fs from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { Sidebar } from "@/components/shell/Sidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/ai/agents" }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
// Buscam estado do servidor e não falam de marca — fora do que se mede aqui.
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "dono@exemplo.test",
  is_platform_admin: false,
  organizations: [],
} as unknown as AuthUser;

/**
 * SEM `marca`: a organização que nunca abriu a tela de marca é quem expõe a
 * marca da INSTALAÇÃO na barra — que é justamente a que divergia. Com marca da
 * organização definida, `activeOrg.marca` venceria e a comparação mediria um
 * valor que já vinha por prop, passando sem tocar no defeito.
 */
const org = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  name: "Loja da Ana",
  role: "admin",
} as ActiveOrg;

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: usuario, activeOrg: org }),
}));

/** A marca GRAVADA PELA TELA: nome e logo no banco, nada no `.env`. */
const MARCA_DO_BANCO = {
  name: "Sistema do Revendedor",
  logoUrl: "https://cdn.exemplo.test/revendedor.png",
  initial: "S",
} as const;

/** O que o `<PublicEnvScript/>` põe no navegador a partir dessa mesma marca. */
const PUBLIC_ENV_DO_NAVEGADOR = {
  APP_NAME: MARCA_DO_BANCO.name,
  APP_LOGO_URL: MARCA_DO_BANCO.logoUrl,
};

type PublicEnv = Record<string, string> | undefined;

function renderComAmbiente(no: PublicEnv, arvore: React.ReactElement): string {
  (window as unknown as { __PUBLIC_ENV__?: unknown }).__PUBLIC_ENV__ = no;
  return renderToStaticMarkup(
    <MarcaDaInstalacaoProvider marca={MARCA_DO_BANCO}>{arvore}</MarcaDaInstalacaoProvider>,
  );
}

beforeEach(() => {
  // O `.env` VAZIO é metade da precondição do defeito: é o estado de quem subiu
  // o logo pela tela e nunca editou o arquivo. Declarado aqui para o caso não
  // mudar de significado em silêncio se a máquina de CI tiver as chaves postas.
  vi.stubEnv("APP_NAME", "");
  vi.stubEnv("APP_LOGO_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as unknown as { __PUBLIC_ENV__?: unknown }).__PUBLIC_ENV__;
});

describe("a marca não diverge entre o SSR e a hidratação", () => {
  it("a barra lateral renderiza IGUAL com e sem a marca no ambiente do navegador", () => {
    const noServidor = renderComAmbiente(undefined, <Sidebar collapsed={false} />);
    const noNavegador = renderComAmbiente(PUBLIC_ENV_DO_NAVEGADOR, <Sidebar collapsed={false} />);

    expect(
      noServidor,
      "SSR e hidratação renderizaram HTML diferente para a MESMA marca. É React #418:\n" +
        "o componente voltou a ler a marca de uma fonte que só um dos lados enxerga\n" +
        "(`branding()` / `window.__PUBLIC_ENV__`) em vez do contexto alimentado pelo servidor.",
    ).toBe(noNavegador);
  });

  it("a barra do admin de plataforma também", () => {
    // A segunda instância, e não só a primeira: as duas liam `branding()` e a do
    // admin troca TEXTO (não elemento), que é o mesmo #418 com outra assinatura.
    const noServidor = renderComAmbiente(undefined, <AdminSidebar userEmail="dono@exemplo.test" />);
    const noNavegador = renderComAmbiente(
      PUBLIC_ENV_DO_NAVEGADOR,
      <AdminSidebar userEmail="dono@exemplo.test" />,
    );

    expect(noServidor).toBe(noNavegador);
  });

  it("GUARDA DE VACUIDADE: com logo no contexto, a barra desenha mesmo o `<img>`", () => {
    // Sem este caso, os dois de cima passariam num componente que nunca mostra
    // logo nenhum — dois vazios são iguais. O que se afirma aqui é que a marca
    // do contexto ALCANÇA a tela: o `<img>` do banco está no HTML dos dois lados.
    const noServidor = renderComAmbiente(undefined, <Sidebar collapsed={false} />);

    expect(noServidor).toContain(`src="${MARCA_DO_BANCO.logoUrl}"`);
    expect(noServidor).toContain(`alt="${MARCA_DO_BANCO.name}"`);
    // E o `<span>` de texto — o outro lado da troca de tipo — não está junto.
    expect(noServidor).not.toContain(`>${MARCA_DO_BANCO.name}</span>`);
  });
});

/**
 * A CATRACA DE CLASSE — porque consertar as quatro ocorrências de hoje não
 * impede a quinta.
 *
 * As três acima guardam duas INSTÂNCIAS. Esta guarda a REGRA: `branding()` é
 * server-only. Um client component novo que a chame reintroduz exatamente o
 * defeito, e nem typecheck nem lint têm como saber disso — o comentário no topo
 * de `lib/branding.ts` não reprova build nenhum.
 */
describe("catraca: `branding()` é server-only", () => {
  const RAIZ = process.cwd();
  const RAIZES_VARRIDAS = ["app", "components", "hooks", "lib", "workers"] as const;

  function arquivos(dir: string): string[] {
    const achados: string[] = [];
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "node_modules" || entrada.name.startsWith(".")) continue;
        achados.push(...arquivos(completo));
      } else if (/\.tsx?$/.test(entrada.name) && !/\.test\.tsx?$/.test(entrada.name)) {
        achados.push(completo);
      }
    }
    return achados;
  }

  /**
   * Comentário não conta — senão os próprios comentários que EXPLICAM a regra
   * (em `contexto.tsx`, na `Sidebar`, aqui ao lado) reprovariam a catraca, e o
   * caminho de menor resistência seria apagá-los.
   *
   * ⚠️ A REGRA DE `tests/unit/branding.test.ts` NÃO SERVE AQUI, e a primeira
   * versão deste arquivo copiou-a e pagou na hora. Lá o filtro é por PREFIXO DE
   * LINHA (`//`, `*`, `/*`), o que basta para docblock. Mas em `.tsx` o
   * comentário que mais fala de código é o bloco JSX `{/* … *␣/}`, cujas linhas
   * do meio começam com palavra comum — e `app/admin/(protected)/marca/_form.tsx`
   * tem exatamente isso, citando `branding()` numa prosa de 12 linhas. O filtro
   * de prefixo o acusou como infrator.
   *
   * Por isso aqui o corte é por BLOCO (`/* … *␣/`), depois por linha `//`. O erro
   * possível troca de lado — em vez de acusar comentário, poderia engolir código
   * se um `/*` aparecesse dentro de string —, e é por isso que a guarda de
   * instrumento abaixo confere que os call sites REAIS continuam visíveis.
   */
  function semComentarios(fonte: string): string {
    return fonte
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((linha) => !linha.trimStart().startsWith("//"))
      .join("\n");
  }

  const varridos = RAIZES_VARRIDAS.flatMap((r) => arquivos(path.join(RAIZ, r)));
  const chamaBranding = (arquivo: string) =>
    /\bbranding\(\)/.test(semComentarios(fs.readFileSync(arquivo, "utf8")));

  it("a varredura enxerga arquivo de verdade", () => {
    // Uma lista vazia faria a asserção principal passar sem medir nada — que é o
    // modo nº 1 de um gate ficar verde por engano.
    expect(varridos.length).toBeGreaterThan(500);
    const clientes = varridos.filter((f) => /^["']use client["']/m.test(fs.readFileSync(f, "utf8")));
    expect(clientes.length).toBeGreaterThan(100);
  });

  it("o corte de comentário derruba a citação e PRESERVA a chamada", () => {
    // O par que separa as duas falhas possíveis do instrumento.
    expect(semComentarios(`{/*\n  fala de branding() na prosa\n*/}\nconst x = 1;`)).not.toMatch(
      /\bbranding\(\)/,
    );
    expect(semComentarios(`const nome = branding().name; // usa a marca`)).toMatch(/\bbranding\(\)/);
  });

  it("os call sites REAIS de `branding()` continuam visíveis à varredura", () => {
    // A guarda contra o erro NOVO que o corte por bloco introduz: se o regex de
    // `/* … */` engolisse código, esta lista esvaziaria e a catraca ficaria verde
    // por cegueira — o mesmo defeito que ela existe para impedir, do lado do
    // instrumento. Estes quatro são servidores e DEVEM chamar `branding()`.
    const esperados = [
      "app/(public)/login/page.tsx",
      "app/(public)/signup/page.tsx",
      "app/onboarding/layout.tsx",
      "lib/legal/operador.ts",
    ];
    const vistos = varridos.filter(chamaBranding).map((f) => path.relative(RAIZ, f));
    expect(esperados.filter((e) => !vistos.includes(e))).toEqual([]);
  });

  it("nenhum componente `\"use client\"` chama `branding()`", () => {
    const infratores = varridos.filter(
      (arquivo) =>
        /^["']use client["']/m.test(fs.readFileSync(arquivo, "utf8")) && chamaBranding(arquivo),
    );

    expect(
      infratores.map((f) => path.relative(RAIZ, f)),
      "`branding()` lê `window.__PUBLIC_ENV__` no navegador e `process.env` no\n" +
        "servidor, e as duas fontes divergem desde que o layout raiz passou a\n" +
        "injetar a marca do BANCO. Num client component isso é hydration mismatch\n" +
        "(React #418). Use `useMarcaDaInstalacao()` de `lib/branding/contexto.tsx`.",
    ).toEqual([]);
  });

  it("o layout raiz monta o provedor em volta de `children`", () => {
    // Sem o provedor na RAIZ, o hook devolve o padrão do produto e a marca do
    // revendedor some — sem erro, sem log, em toda tela. Os casos de cima não
    // pegariam: eles montam o provedor à mão.
    const layoutRaiz = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");
    expect(layoutRaiz).toMatch(/<MarcaDaInstalacaoProvider\s/);
    expect(layoutRaiz).toMatch(/<MarcaDosClientComponents>/);
  });
});
