/**
 * A casca do /admin provê o `TooltipProvider`. O que estes testes protegem:
 *
 *  - tela nova renderizada DENTRO da casca nasce funcionando, sem precisar
 *    lembrar do Provider — e nos dois valores de `userEmail` que o call site
 *    real pode entregar, porque ele passa `user.email ?? ""`;
 *  - o segundo caso prova que a exigência é do Radix, não do teste: sem ele o
 *    primeiro passaria mesmo que nada estivesse sendo exigido.
 *
 * Por que merece catraca: sem um Provider ANCESTRAL o `Tooltip` do Radix lança
 * no cliente e o React derruba a árvore inteira — não é um tooltip sem estilo,
 * é a tela inteira sumindo. Como não existe `app/admin/error.tsx`, quem captura
 * é o boundary da RAIZ (`app/error.tsx` → `components/feedback/SegmentError.tsx`),
 * então some junto a casca: o dono vê "Algo deu errado" e um ID. Rastro existe,
 * mas não onde se procura primeiro — o throw é do cliente, então não há linha no
 * log do servidor Next; quem recebe é o Sentry, que numa instalação padrão é o
 * da comunidade (`SENTRY_DSN` vazio no `.env.example` cai no `DEFAULT_SENTRY_DSN`).
 * Com `SENTRY_DSN=off` não sobra rastro nenhum.
 *
 * Quem é atingido, e quem não é — está medido em `components/admin/AdminShell.tsx`
 * e não é repetido aqui. Dois pontos de lá que mudam como se lê um vermelho:
 * o consumidor sem Provider próprio é o `TenantBadge`, montado em /admin/inbox,
 * /admin/inbox/[conversationId], /admin/lgpd e /admin/lgpd/requests/[id]; e
 * /admin/usage NÃO está na lista, apesar do nome colidir, porque os gráficos de
 * lá importam um `Tooltip` do recharts, que não usa Provider nenhum.
 *
 * LIMITE DECLARADO — o que estes testes NÃO guardam: o elo entre a casca e as
 * telas. Quem monta a casca é `app/admin/(protected)/layout.tsx`, e se ele
 * deixar de usar o `AdminShell` as 4 telas quebram de novo com estes casos
 * verdes. Pelo mesmo motivo, "tela nova" acima quer dizer tela sob
 * `app/admin/(protected)`: o `app/admin/layout.tsx` é passthrough deliberado, e
 * `app/admin/forbidden` já renderiza fora da casca hoje. Guardar esse elo
 * exigiria montar um layout async que chama `requirePlatformAdmin`; o teste
 * frágil que sairia daí vale menos que esta frase precisa.
 *
 * Sabotagem que confirma que a guarda vigia: remover o `<TooltipProvider>` de
 * `AdminShell.tsx` deixa o primeiro caso vermelho, nos dois valores de e-mail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AdminShell } from "@/components/admin/AdminShell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Único mock: o `AdminSidebar` é client component e chama `usePathname`. O
// banner e o sidebar continuam reais — a casca sob teste é a casca de verdade,
// não uma maquete dela. Mesmo padrão de `tests/unit/sidebar-grupos.test.tsx`.
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/inbox",
}));

/** Consumidor sem Provider próprio, como o `TenantBadge`. */
function UsaTooltipSemProviderProprio() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button">gatilho</button>
      </TooltipTrigger>
      <TooltipContent>dica</TooltipContent>
    </Tooltip>
  );
}

afterEach(cleanup);

describe("AdminShell", () => {
  // Os dois valores que `app/admin/(protected)/layout.tsx:7` pode passar:
  // `user.email ?? ""`. Sem o caso vazio, uma casca que condicionasse o
  // Provider ao e-mail passaria verde e quebraria para quem não tem e-mail.
  it.each([
    ["e-mail preenchido", "dono@exemplo.com"],
    ["e-mail vazio, como em user.email ?? ''", ""],
  ])(
    "provê o TooltipProvider aos filhos com %s — tela nova nasce funcionando",
    (_rotulo, userEmail) => {
      expect(() =>
        render(
          <AdminShell userEmail={userEmail}>
            <UsaTooltipSemProviderProprio />
          </AdminShell>,
        ),
      ).not.toThrow();

      expect(screen.getByRole("button", { name: "gatilho" })).toBeInTheDocument();
    },
  );

  it("o mesmo filho SEM a casca lança — prova que a guarda vem do AdminShell", () => {
    // Com a mensagem fixada: `.toThrow()` sozinho aceita QUALQUER lançamento, e
    // aí um import quebrado no stand-in manteria o verde enquanto o caso
    // deixaria de provar que a exigência é do Radix.
    expect(() => render(<UsaTooltipSemProviderProprio />)).toThrow(
      /must be used within `TooltipProvider`/,
    );
  });
});
