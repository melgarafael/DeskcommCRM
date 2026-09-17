import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_DESTINATIONS, NAV_GROUPS } from "@/lib/navigation/registry";

/**
 * O teste que impede a bagunça de voltar.
 *
 * O Living System Checklist já perguntava "onde eu apareço na tela?" — e todas
 * as features respondiam "tenho tela" e passavam. Nenhuma era obrigada a
 * responder POR QUAL PORTA se chega nela. O resultado foram sete telas
 * alcançáveis só por dentro da própria seção e duas sem link nenhum no app.
 *
 * Aqui isso vira mecânico. Rota sem porta reprova o CI; entrada de registro
 * apontando para rota inexistente também.
 *
 * ESCOPO: só `app/app/**` — a navegação do tenant. O admin de plataforma
 * (`app/admin/`), o onboarding e as páginas públicas têm navegação própria.
 */

const RAIZ = process.cwd();
const BASE = path.join(RAIZ, "app", "app");

/**
 * Rotas que existem mas NÃO são destino de navegação.
 *
 * Toda entrada carrega o porquê. É o que separa uma decisão registrada de um
 * esquecimento: quem adicionar uma linha aqui tem de escrever a justificativa,
 * e quem revisar o PR a lê.
 */
const NAV_ALLOWLIST: Record<string, string> = {
  "/app": "redirect para /app/inbox — não é tela, é o ponto de entrada",
  "/app/ai/agents/new":
    "sub-fluxo de criar agente, alcançado pelo botão dentro da lista de Agentes",
  "/app/team/invite": "sub-fluxo de convite, alcançado de dentro de Equipe",
  "/app/settings/tenant/whatsapp": "redirect legado para /app/connections; mantido por links salvos",
  "/app/settings/canal-oficial":
    "redirect para /app/connections?aba=oficial desde o PR #105 — conectar canal passou a ter um lugar só. Conexões é a porta; a aba é navegação interna dela",
  "/app/settings/templates":
    "redirect para /app/connections?aba=oficial&sub=templates — template da Meta só existe por causa do canal oficial, e vive como sub-aba dele",
  "/app/settings/atualizacao":
    "porta é o rodapé de versão (VersionFooter), que aparece justamente quando há versão nova — melhor que um card fixo. Além disso é só do dono do servidor (is_platform_admin), papel que o registro não modela",
};

/** Deriva as rotas estáticas a partir dos arquivos de página que existem. */
function rotasNoDisco(dir: string, prefixo = "/app"): string[] {
  const rotas: string[] = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entrada.isFile() && entrada.name === "page.tsx") rotas.push(prefixo);
    if (!entrada.isDirectory()) continue;
    // `_components` e afins não são segmentos de rota; `[id]` é tela de detalhe,
    // alcançada a partir de uma lista — nunca um item de menu.
    if (entrada.name.startsWith("_") || entrada.name.startsWith("[")) continue;
    rotas.push(...rotasNoDisco(path.join(dir, entrada.name), `${prefixo}/${entrada.name}`));
  }
  return rotas;
}

const ROTAS = rotasNoDisco(BASE).sort();
const NO_REGISTRO = new Set(NAV_DESTINATIONS.map((d) => d.href));
const HUBS = NAV_GROUPS.flatMap((g) => (g.hub ? [g.hub.href] : []));

describe("completude da navegação", () => {
  it("encontrou as rotas do app — se isto zerar, o resto do arquivo não prova nada", () => {
    expect(ROTAS.length).toBeGreaterThan(20);
  });

  it("toda tela tem porta: está no registro ou na allowlist justificada", () => {
    // Um hub é porta tanto quanto um destino — o sidebar linka para ele. Ele só
    // não é `NavDestination` porque não é uma tela do grupo, e sim a vitrine dele.
    const semPorta = ROTAS.filter(
      (r) => !NO_REGISTRO.has(r) && !HUBS.includes(r) && !(r in NAV_ALLOWLIST),
    );
    expect(
      semPorta,
      // ⚠️ O ENDEREÇO AQUI É O `catalogo.ts`, e não o `registry.ts`.
      //
      // Esta mensagem mandava ao `registry.ts` — que é de onde este arquivo
      // IMPORTA, mas onde não há nada a declarar: ele deriva `NAV_DESTINATIONS`
      // de `NAV_CATALOG` e reexporta. Quem fosse reprovado pelo CI abriria um
      // arquivo sem um único lugar para pôr a tela. É a mensagem de erro que a
      // pessoa lê no pior momento; mandá-la ao arquivo errado é o defeito mais
      // caro dos dois (o `CLAUDE.md` repetia o mesmo engano, já corrigido).
      `Tela sem porta — existe mas não se chega nela pela navegação.\n` +
        `Declare em lib/navigation/catalogo.ts (NAV_CATALOG), com seu grupo, ou\n` +
        `à NAV_ALLOWLIST deste arquivo COM a justificativa:\n  ${semPorta.join("\n  ")}`,
    ).toEqual([]);
  });

  it("todo destino do registro aponta para uma tela que existe", () => {
    const mortos = NAV_DESTINATIONS.map((d) => d.href).filter((h) => !ROTAS.includes(h));
    expect(mortos, `Link morto no registro:\n  ${mortos.join("\n  ")}`).toEqual([]);
  });

  it("todo hub de grupo aponta para uma tela que existe", () => {
    const mortos = HUBS.filter((h) => !ROTAS.includes(h));
    expect(mortos, `Hub apontando para rota inexistente:\n  ${mortos.join("\n  ")}`).toEqual([]);
  });

  it("a allowlist não guarda rota que já morreu", () => {
    const obsoletas = Object.keys(NAV_ALLOWLIST).filter((r) => !ROTAS.includes(r));
    expect(obsoletas, `Allowlist cita rota que não existe mais:\n  ${obsoletas.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("toda entrada da allowlist explica o porquê", () => {
    const semJustificativa = Object.entries(NAV_ALLOWLIST)
      .filter(([, motivo]) => motivo.trim().length < 20)
      .map(([rota]) => rota);
    expect(semJustificativa).toEqual([]);
  });
});
