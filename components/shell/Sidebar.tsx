"use client";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ArrowRight, CaretDoubleLeft, CaretDoubleRight, CaretDown, Gear } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { ContadorDeCasos } from "@/components/shell/ContadorDeCasos";
import { ContadorDaFila } from "@/components/shell/ContadorDaFila";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { marcaEhADoProduto } from "@/lib/branding";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { GRUPO_NO_RODAPE, sidebarGroups } from "@/lib/navigation/registry";

const CHAVE_GRUPOS_FECHADOS = "sidebar-grupos-fechados";

interface SidebarContentProps {
  collapsed: boolean;
  showCollapseControl?: boolean;
  onNavigate?: () => void;
}

/**
 * Navegação principal, agrupada por objetivo.
 *
 * Não decide nada: `sidebarGroups()` (lib/navigation/registry.ts) resolve quais
 * grupos e destinos este papel vê, e este componente desenha. Antes, a lista de
 * itens e sete `usePermission()` viviam aqui — e divergiam do hub de
 * Configurações e das abas de IA, que mantinham suas próprias listas.
 */
export function SidebarContent({
  collapsed,
  showCollapseControl = true,
  onNavigate,
}: SidebarContentProps) {
  // A barra lateral aparece em TODA tela — traduzi-la aqui é o que faz a
  // escolha de idioma virar algo visível no primeiro clique.
  const t = useT();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const { user, activeOrg } = useAuth();
  const todos = sidebarGroups(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
    activeOrg?.modulos_ligados ?? [],
    activeOrg?.capacidades_ligadas ?? [],
  );
  // Configurações sai da área que rola e vai para o rodapé fixo: medido em
  // 1280x768, ele caía fora da dobra mesmo em telas de 1080px.
  const grupos = todos.filter((g) => g.group.id !== GRUPO_NO_RODAPE);
  const rodape = todos.find((g) => g.group.id === GRUPO_NO_RODAPE)?.group.hub;

  /**
   * Grupo fechado é preferência POR NAVEGADOR, não por conta: começa vazio (tudo
   * aberto) em toda renderização — servidor, primeira pintura do cliente e nos
   * testes, que nunca clicam em nada — e só muda depois do mount, se o
   * `localStorage` tiver algo salvo. Guardar o CONJUNTO DOS FECHADOS, e não dos
   * abertos, é o que faz "sem preferência salva" já significar "tudo aberto".
   */
  const [gruposFechados, setGruposFechados] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      const salvo = window.localStorage.getItem(CHAVE_GRUPOS_FECHADOS);
      if (salvo) setGruposFechados(new Set(JSON.parse(salvo) as string[]));
    } catch {
      // Storage bloqueado (aba privada) — fica tudo aberto, que é o padrão.
    }
  }, []);
  function toggleGrupo(id: string) {
    setGruposFechados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(CHAVE_GRUPOS_FECHADOS, JSON.stringify([...next]));
      } catch {
        // Clique continua funcionando nesta sessão; só não sobrevive a um F5.
      }
      return next;
    });
  }

  const brand = useMarcaDaInstalacao();
  /**
   * O CONSUMIDOR do nome por organização.
   *
   * Sem ele, `settings.branding.app_name` seria campo decorativo: medido, o nome
   * da org não aparece em lugar nenhum da casca para o cliente típico de um
   * revendedor — o único leitor é o `TenantSwitcher`, e ele devolve `null` com
   * uma organização só.
   *
   * A marca da INSTALAÇÃO continua embaixo: a organização que não definiu nome
   * vê exatamente o que via antes. O que mudou é POR ONDE ela chega — era
   * `branding()`, que no navegador lê `window.__PUBLIC_ENV__` e no servidor lê
   * `process.env`, e essas duas fontes passaram a divergir quando o layout raiz
   * começou a injetar a marca do BANCO. Divergência entre SSR e cliente aqui não
   * é detalhe: com logo no banco e `APP_LOGO_URL` vazio, o servidor desenhava o
   * `<span>` de baixo e o cliente desenhava o `<img>` — React #418 em toda tela.
   * Hoje a marca vem por PROP do servidor (`useMarcaDaInstalacao`), pela mesma
   * rota de `activeOrg`, e os dois lados leem o mesmo objeto por construção.
   */
  const nome = activeOrg?.marca?.nome ?? brand.name;
  /**
   * O mesmo desenho para o LOGO — e é este par de linhas que fecha o caminho do
   * `logo_url` gravado até a tela.
   *
   * `||` e não `??`: vazio é AUSÊNCIA de logo, não "logo em branco". É a regra
   * que `resolveBranding` e `primeiroDefinido` já aplicam nas camadas de baixo, e
   * com `??` um `""` vindo de cima apagaria o logo do revendedor em vez de
   * descer para ele — que é o contrário do que a precedência por campo promete.
   */
  const logo = activeOrg?.marca?.logoUrl || brand.logoUrl;
  const logoEscuro =
    activeOrg?.marca?.logoDarkUrl !== undefined
      ? activeOrg.marca.logoDarkUrl
      : activeOrg?.marca?.logoUrl
        ? null
        : brand.logoDarkUrl;
  // Só quando NINGUÉM — nem a instalação, nem a organização — pôs marca própria:
  // é a condição de `lib/branding.ts`, avaliada sobre o que a barra vai mostrar.
  const marcaDoProduto = marcaEhADoProduto({ name: nome, logoUrl: logo ?? null });

  return (
    <>
      <div
        className={cn(
          "flex h-14 items-center border-b px-4",
          collapsed ? "justify-center" : "justify-start",
        )}
      >
        {(logo || logoEscuro) && !collapsed ? (
          // Sem arte própria para o escuro, preserva a proteção de contraste.
          <div
            className={cn(
              // `min-w-0`: item de flex não encolhe abaixo do `min-width: auto`,
              // que é o valor padrão — sem isso, uma arte própria larga empurra o
              // botão de recolher para fora da barra em vez de encolher.
              "min-w-0 rounded-md",
              !logoEscuro && "dark:bg-white dark:px-2 dark:py-1 dark:shadow-sm",
            )}
          >
            {/* <img> em vez de next/image de propósito: a URL vem de quem hospeda
              (banco ou .env), e next/image exige allowlist de domínios fechada em
              build — a imagem pré-buildada rejeitaria o domínio do self-hoster.
              Altura fixa e largura livre porque a arte enviada tem proporção
              desconhecida; forçar as duas distorceria o logo de quem configurou. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {logo ? (
              <img
                src={logo}
                alt={nome}
                className={cn(
                  // `max-w-[min(10rem,100%)]` e não `max-w-[10rem]` sozinho, como o
                  // review mediu (#2723): a linha da logo tem ~207px úteis na barra
                  // aberta e o botão de recolher disputa o mesmo espaço. Uma arte
                  // própria larga (160px) vazava 7px do fundo claro e ficava a 1px
                  // do botão. O teto de 10rem continua valendo, mas agora a imagem
                  // encolhe antes de estourar.
                  //
                  // `max-w-[10rem]` + `max-w-full` não valem os dois: disputam a
                  // MESMA propriedade no CSS e só um sobrevive — a pegadinha que o
                  // review apontou, e por isso o teto é um único `min()`.
                  "h-7 w-auto max-w-[min(10rem,100%)] object-contain",
                  logoEscuro && "dark:hidden",
                )}
              />
            ) : (
              // `truncate` + `title`: o nome longo (uma clínica com nome grande,
              // medido no review) virava 3 linhas dentro de uma linha de 56px e
              // estourava a barra. Uma linha com reticências, e o nome completo
              // continua no tooltip. `block` porque este wrapper não é flex: inline,
              // o `truncate` não corta e o nome passa por cima do botão.
              <span className="block min-w-0 truncate dark:hidden" title={nome}>
                {nome}
              </span>
            )}
            {logoEscuro ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoEscuro}
                alt={nome}
                className="hidden h-7 w-auto max-w-[min(10rem,100%)] object-contain dark:block"
              />
            ) : null}
          </div>
        ) : marcaDoProduto ? (
          // O desenho do produto, inline (ver `components/branding/MarcaDoProduto.tsx`):
          // logotipo com a barra aberta, só o símbolo com ela recolhida.
          collapsed ? (
            <SimboloDoProduto nome={nome} className="h-8 w-8" />
          ) : (
            <LogotipoDoProduto nome={nome} className="h-8 w-auto" />
          )
        ) : (
          <span
            className={cn(
              "min-w-0 truncate font-semibold tracking-tight",
              collapsed && "sr-only",
            )}
            title={nome}
          >
            {nome}
          </span>
        )}
        {collapsed && !marcaDoProduto && (
          <span aria-hidden className="text-lg font-bold text-primary">
            {/* Spread e não `[0]`: nome começando com emoji ou acento composto
                quebraria no meio do code point. Mesma regra de `resolveBranding`
                — a inicial precisa acompanhar o nome que a barra mostra, senão
                recolher o menu troca a marca. */}
            {[...nome][0]?.toUpperCase() ?? brand.initial}
          </span>
        )}
        {/* Issue #2722 — o controle de recolher mora no ALTO, como no
            mercado: na linha da logo, à direita, quando a barra está aberta. */}
        {showCollapseControl && !collapsed && (
          // `shrink-0`: sem isso o botão é o primeiro a ser espremido quando a
          // marca é larga — e ele é o controle, não sobra.
          <div className="ml-auto shrink-0 pl-2">
            <BotaoDeRecolher
              collapsed={false}
              isPending={isPending}
              soIcone
              onClick={() => startTransition(() => toggleSidebar(collapsed))}
            />
          </div>
        )}
      </div>
      {/* Issue #2722 — no trilho recolhido (64px) não cabe controle ao lado
          do símbolo: ele vira uma faixa imediatamente abaixo da marca. */}
      {showCollapseControl && collapsed && (
        <div className="border-b px-2 py-1">
          <BotaoDeRecolher
            collapsed
            isPending={isPending}
            onClick={() => startTransition(() => toggleSidebar(collapsed))}
          />
        </div>
      )}
      {/*
        A DENSIDADE É MEDIDA, NÃO ESTÉTICA.

        O e2e `navegacao.spec.ts` exige que o menu inteiro caiba em 1280×900 sem
        rolar — porque um grupo abaixo da dobra é indistinguível de um grupo que
        não existe. Com 18 links a margem era de ~4px: a tela nova de Produtos
        estourou a dobra por uma linha, e reprovou no CI.

        `py-1.5` → `py-1` (linha de 32px para 28px) e o intervalo entre grupos de
        12px para 8px devolvem ~90px — folga para o próximo item, em vez de
        deixar a próxima tela nova repetir esta corrida.

        ⚠️ Isto é remendo de densidade, não conserto estrutural. O menu vai
        estourar de novo: a saída existente é o HUB (o grupo IA já a usa — nove
        das treze telas dele moram atrás do "Ver tudo em IA"), e o CRM ainda não
        tem um. Quando o quinto destino de CRM aparecer, é hub que se cria, não
        mais 4px que se raspa.

        ✅ O QUINTO APARECEU, e a promessa foi paga. Tarefas (PR #546) levou o
        CRM a cinco telas e a dobra estourou em 13px — medido em 1280×900,
        `scrollHeight` 776 contra 763 de altura. O conserto foi `/app/crm`, o
        hub do grupo: Produtos e Etapas do funil saíram do menu para dentro
        dele, e nenhum valor deste arquivo mudou por causa disso.

        Fica valendo o mesmo, agora para o próximo grupo: com hub em CRM, IA e
        Organização, tela nova de qualquer um dos três não pressiona mais o
        menu. Quem pressionar é um grupo SEM hub — Atendimento (4), Canais (3)
        ou Análise (3). Quando um deles passar de quatro, a resposta é a mesma:
        cria-se o hub, não se raspa densidade.

        ✅ ANÁLISE FOI A SEGUINTE, e a regra valeu igual. Atividades (PR #583)
        levou o grupo a cinco telas e a dobra estourou de novo — medido em
        1280×900, logado como admin: `scrollHeight` 776 contra 763 de altura
        visível, 13px de excesso, com o link "Audit Log" 13px abaixo da caixa de
        conteúdo da nav. O conserto foi `/app/analise`, o hub do grupo: Evolução
        da IA e Audit Log saíram do menu para dentro dele, e NENHUM valor deste
        arquivo mudou por causa disso. Sobrou 19px de folga — a mesma que havia
        antes de Atividades chegar.

        Ficam sem hub Atendimento e Canais (4 e 2 destinos quando isto foi
        medido) — em qualquer um deles, o quinto destino é que cria o hub, nunca
        mais densidade raspada. A conta é fechada e vale conferir antes de abrir
        o PR: cada linha custa 32px (28px de altura + 4px de `space-y-1`), e
        trocar N destinos do menu por um único link de hub devolve (N-1)×32px.
      */}
      <nav className="flex-1 space-y-2 overflow-y-auto p-2" aria-label={t("Navegação principal")}>
        {grupos.map(({ group, items }) => {
          const tituloId = `nav-grupo-${group.id}`;
          // Recolhido o sidebar inteiro (rail de 64px), o grupo sempre mostra
          // seus itens — não há onde desenhar cabeçalho nem seta para fechá-lo.
          const aberto = collapsed || !gruposFechados.has(group.id);
          return (
            <div key={group.id} className="space-y-1">
              {/* Colapsado, o sidebar tem 64px: seis rótulos ali seriam ilegíveis.
                  Vira um filete separador, que preserva o agrupamento sem texto. */}
              {collapsed ? (
                <div aria-hidden className="mx-2 border-t first:hidden" />
              ) : (
                <h2 id={tituloId}>
                  <button
                    type="button"
                    onClick={() => toggleGrupo(group.id)}
                    aria-expanded={aberto}
                    className="flex w-full items-center justify-between rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                  >
                    {t(group.label)}
                    <CaretDown
                      size={12}
                      weight="bold"
                      className={cn(
                        "shrink-0 text-text-subtle transition-transform",
                        !aberto && "-rotate-90",
                      )}
                      aria-hidden
                    />
                  </button>
                </h2>
              )}
              {aberto && (
                <ul
                  aria-labelledby={collapsed ? undefined : tituloId}
                  aria-label={collapsed ? t(group.label) : undefined}
                  className="space-y-1"
                >
                  {items.map((item) => {
                    const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          title={collapsed ? t(item.label) : undefined}
                          aria-current={isActive ? "page" : undefined}
                          onClick={onNavigate}
                          className={cn(
                            "relative flex items-center gap-3 rounded-md px-3 py-1 text-sm transition-colors",
                            isActive
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            collapsed && "justify-center px-2",
                          )}
                        >
                          <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
                          {!collapsed && <span className="truncate">{t(item.label)}</span>}
                          {item.healthDot && (
                            <ConnectionHealthDot
                              className={cn(collapsed ? "absolute top-1.5 right-1.5" : "ml-auto")}
                            />
                          )}
                          {item.contador === "casos" && <ContadorDeCasos compacto={collapsed} />}
                          {item.contador === "fila" && <ContadorDaFila compacto={collapsed} />}
                        </Link>
                      </li>
                    );
                  })}
                  {group.hub && (
                    <li>
                      <Link
                        href={group.hub.href}
                        title={collapsed ? t(group.hub.label) : undefined}
                        aria-current={pathname === group.hub.href ? "page" : undefined}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-1 text-sm transition-colors",
                          pathname === group.hub.href
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                          collapsed && "justify-center px-2",
                        )}
                      >
                        <ArrowRight size={18} aria-hidden />
                        {!collapsed && <span className="truncate">{t(group.hub.label)}</span>}
                      </Link>
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      <div className="border-t p-2">
        {rodape && (
          <Link
            href={rodape.href}
            title={collapsed ? t(rodape.label) : undefined}
            aria-current={pathname.startsWith(rodape.href) ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "mb-1 flex items-center gap-3 rounded-md px-3 py-1 text-sm transition-colors",
              pathname.startsWith(rodape.href)
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              collapsed && "justify-center px-2",
            )}
          >
            <Gear size={18} aria-hidden />
            {!collapsed && <span className="truncate">{t(rodape.label)}</span>}
          </Link>
        )}
        <VersionFooter collapsed={collapsed} onNavigate={onNavigate} />
      </div>
    </>
  );
}

/**
 * Issue #2722 — o MESMO controle de antes (classes, `toggleSidebar` via
 * `startTransition`, `isPending`, `aria-label` Recolher/Expandir), só que no
 * ALTO: na linha da logo quando aberta (padrão de mercado), e numa faixa sob
 * o símbolo quando recolhida — os 64px do trilho não comportam botão ao lado
 * da marca sem espremer.
 */
function BotaoDeRecolher({
  collapsed,
  isPending,
  onClick,
  soIcone = false,
}: {
  collapsed: boolean;
  isPending: boolean;
  onClick: () => void;
  /**
   * Barra aberta, sem o rótulo. O review mediu (#2723) que o rótulo custa
   * ~54px de uma linha com ~207px úteis, e uma logo-palavra de 5:1 (140px)
   * já estourava por causa disso. Só o ícone devolve ~161px para a marca.
   *
   * Acessibilidade não muda: o `aria-label` é o mesmo ("Recolher sidebar"),
   * e o `title` cobre o hover para quem só enxerga o desenho.
   */
  soIcone?: boolean;
}) {
  const t = useT();
  // Um rótulo só para `aria-label` e `title`: os dois nomeiam a MESMA ação.
  const rotulo = collapsed ? t("Expandir sidebar") : t("Recolher sidebar");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        (collapsed || soIcone) && "justify-center px-2",
      )}
      aria-label={rotulo}
      title={collapsed || soIcone ? rotulo : undefined}
    >
      {collapsed ? (
        <CaretDoubleRight size={14} aria-hidden />
      ) : (
        <CaretDoubleLeft size={14} aria-hidden />
      )}
      {!collapsed && !soIcone && <span>{t("Recolher")}</span>}
    </button>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={cn(
        // ⚠️ `sticky`, e NUNCA `fixed`.
        //
        // Com `fixed` a barra sai do fluxo: ela não ocupa lugar nenhum na linha,
        // e quem afastava o conteúdo era um `md:ml-16`/`md:ml-60` do lado de lá.
        // Duas medidas para a mesma coisa, em componentes diferentes — e no dia
        // em que discordassem (largura de 60 com margem de 16), a barra passava
        // POR CIMA da lista de conversas, escondendo o começo de cada linha.
        //
        // Foi assim que apareceu numa instalação real: a barra expandida, com as
        // etiquetas legíveis, e a lista atrás dela cortada. Um F5 "consertava",
        // que é a assinatura de servidor e navegador terem pintado estados
        // diferentes — e `AppShell` e `Sidebar` são ambos `"use client"`.
        //
        // `sticky top-0 h-dvh` dá o mesmo efeito visual (a barra não rola com
        // a página) e ela VOLTA a ocupar lugar: sobra para o conteúdo exatamente
        // o que ela não usou, e não há segunda medida para discordar.
        //
        // `h-dvh` e não `h-screen`: `100vh` é a janela com a barra de endereço
        // RECOLHIDA, e o navegador nunca corrige esse valor. No tablet entre 768
        // e 1023px — onde esta barra JÁ aparece, porque a casca a mostra a partir
        // de `md` — a barra media mais que a janela e o fim dela ficava fora do
        // alcance. `dvh` acompanha a barra do navegador aparecendo e sumindo.
        // Princípio 2 de `docs/design-system/screen-flow/07-responsive-strategy.md`.
        //
        // `shrink-0` porque item de flex encolhe por padrão, e uma barra de 60
        // espremida para caber é o mesmo defeito por outro caminho.
        //
        // `duration-base` em vez do `duration-200` literal: 200ms é o mesmo
        // número, mas vindo de `--duration-base`. A Lei de movimento fecha a
        // tabela de durações, e número solto é o que a faz apodrecer.
        "sticky top-0 z-30 flex h-dvh shrink-0 flex-col border-r bg-card transition-[width] duration-base",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}
