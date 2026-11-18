import { headers } from "next/headers";

import { CABECALHO_SEM_CSS } from "@/lib/branding/sem-css-personalizado";
import { cssDoTemaDaPlataforma } from "@/lib/extensions/tema-da-plataforma";

/**
 * O `<style>` do TEMA DA PLATAFORMA no layout raiz (#3790).
 *
 * ── Por que no `<head>` do layout RAIZ ─────────────────────────────────────
 *
 * O tema de extensão por organização só alcança o `/app` de quem escolheu: o
 * marcador `[data-tema-extensao]` nasce em `app/app/layout.tsx`, e o CSS é
 * escopado por `body:has(...)`. Login, `/admin` e organizações sem tema ficavam
 * na paleta de fábrica. Aqui o bloco é emitido em TODA tela, escopado em
 * `:root:root` (`ESCOPO_DA_INSTALACAO`), e vale enquanto o `<html>` existir.
 *
 * ── A ORDEM é a decisão: marca → tema → CSS personalizado ──────────────────
 *
 * A marca (`#marca-instalacao`) declara a COR DE AÇÃO e vem primeiro; o tema
 * declara superfícies/bordas/textos e vem depois; o CSS personalizado da
 * instalação vem por último, porque é o ajuste do operador e o último a falar
 * é o que ele espera ver. Empatar a ordem faria a escolha da extensão vencer a
 * cor da tela Marca — e o tema NÃO recebe as chaves `--color-accent*`
 * (`semAsChavesDaCorDeAcao`), então nem chega a haver disputa.
 *
 * ── Nada muda para quem não usa ───────────────────────────────────────────
 *
 * Sem escolha, sem linha em `platform_config`, sem instalação válida: `null`,
 * nenhum nó, nenhum byte. É o caso comum — quem revende sem tema de extensão
 * continua vendo exatamente o produto de fábrica.
 *
 * `?sem_css=1` desliga, como no CSS personalizado: quem depura um problema
 * visual precisa poder ver o produto sem as folhas que a instalação aplicou.
 */
export async function EstiloDoTemaDaPlataforma() {
  const desligada = (await headers()).get(CABECALHO_SEM_CSS) === "1";
  // Nunca lança: a leitura degrada para `null` com aviso no log. Ver o
  // cabeçalho de `lib/extensions/tema-da-plataforma.ts`.
  const css = await cssDoTemaDaPlataforma(desligada);
  if (!css) return null;
  // Conteúdo derivado de um manifesto que já passou pela allowlist de nome e
  // pela régua de forma de `lib/extensions/tema.ts`, que recusa `<` e `;}` e
  // devolve `null` em vez de string parcial. Mesmo contrato de
  // `#marca-css-personalizado`. O `id` é o que torna o bloco identificável em
  // tela, em e2e e no suporte.
  return <style id="tema-da-plataforma" dangerouslySetInnerHTML={{ __html: css }} />;
}
