"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Gauge,
  ChatsCircle,
  Buildings,
  ClipboardText,
  Scales,
  Warning,
  ChartBar,
  Users,
  ShieldCheck,
  CalendarBlank,
  Palette,
  Key,
  EnvelopeSimple,
  Gear,
  Plugs,
  WebhooksLogo,
  ArrowRight,
  Lock,
  PuzzlePiece,
} from "@/lib/ui/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { marcaEhADoProduto } from "@/lib/branding";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { useT } from "@/hooks/i18n/useT";

interface NavItem {
  href: string;
  label: string;
  icon: PhosphorIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/admin/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/admin/inbox", label: "Inbox", icon: ChatsCircle },
  { href: "/admin/tenants", label: "Tenants", icon: Buildings },
  { href: "/admin/audit", label: "Audit", icon: ClipboardText },
  { href: "/admin/lgpd", label: "LGPD", icon: Scales },
  { href: "/admin/incidents", label: "Incidents", icon: Warning },
  { href: "/admin/usage", label: "Usage", icon: ChartBar },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/platform-admins", label: "Platform Admins", icon: ShieldCheck },
  // A porta da tela de marca. Ela NÃO entra em `lib/navigation/registry.ts`:
  // aquele registro descreve a navegação do tenant (`app/app/**`) e o teste de
  // completude que o vigia varre só aquela raiz. O admin de plataforma tem
  // navegação própria, e é esta lista.
  { href: "/admin/marca", label: "Marca", icon: Palette },
  // A porta da tela do app OAuth do Google — mesma razão da de cima: é
  // configuração da INSTALAÇÃO, e /admin tem navegação própria.
  { href: "/admin/google", label: "Google Agenda", icon: CalendarBlank },
  // A porta da tela do App da Meta (chave secreta e token de verificação do
  // webhook) — mesma razão da de cima: é da INSTALAÇÃO. O rótulo é o da aba de
  // Conexões, para quem vem de lá reconhecer o mesmo nome.
  { href: "/admin/meta", label: "API Oficial (Meta)", icon: WebhooksLogo },
  // A porta da tela que decide quem pode criar conta nesta instalação — mesma
  // razão das duas de cima: é configuração da INSTALAÇÃO, e /admin tem
  // navegação própria (o registro de `lib/navigation/` cobre só `app/app/**`).
  { href: "/admin/cadastro", label: "Cadastro", icon: Key },
  // A porta da tela do servidor de e-mail (SMTP) — mesma razão das de cima: um
  // servidor de e-mail manda o e-mail de todas as empresas desta VPS, então é
  // configuração da INSTALAÇÃO, e /admin tem navegação própria (o registro de
  // `lib/navigation/` cobre só `app/app/**`). O rótulo é "E-mail" e não "SMTP"
  // porque quem instala não precisa conhecer a sigla para achar a tela.
  { href: "/admin/email", label: "E-mail", icon: EnvelopeSimple },
  // A porta da tela do COMPORTAMENTO da instalação (issue #1034) — mesma razão
  // das três de cima: são chaves da INSTALAÇÃO, e /admin tem navegação própria.
  // O rótulo é o do assunto da tela para quem chega por aqui sabendo o que foi
  // mexer, e não o nome de um arquivo de configuração.
  { href: "/admin/sistema", label: "Comportamento", icon: Gear },
  // A porta da tela que libera endereços da rede interna (decisão 22-d, #1004).
  // Mesma razão das de cima: o objeto é a MÁQUINA, não uma empresa — e a
  // decisão pede explicitamente que o lugar onde o dono controla seja visível.
  // Sem esta linha a tela existiria e só se chegaria nela digitando a URL.
  { href: "/admin/destinos-internos", label: "Destinos internos", icon: Plugs },
  // A porta das CREDENCIAIS da instalação (migration 0341): a chave do serviço
  // de e-mail, o remetente, os contatos — o que antes só se trocava por SSH.
  //
  // ⚠️ RÓTULO E ÍCONE ESCOLHIDOS CONTRA A VIZINHA DE CIMA. A tela
  // "Comportamento" (/admin/sistema, issue #1034) nasceu em paralelo e usa
  // `Gear`. Uma segunda engrenagem chamada "Configuração" ao lado dela deixaria
  // o operador sem saber qual abrir — "comportamento" e "configuração" são quase
  // sinônimos para quem não programa. "Credenciais" diz o que tem lá dentro, e
  // o cadeado diz que é algo guardado.
  { href: "/admin/configuracao", label: "Credenciais", icon: Lock },
  // A PORTA QUE FALTAVA. O catálogo de extensões é da INSTALAÇÃO
  // (`extension_catalogs` não tem `organization_id`), mas a única tela que o
  // mostrava vivia no menu da EMPRESA — o dono do servidor precisava entrar
  // numa organização qualquer para ver de onde vêm as extensões do servidor
  // dele. Mesma divisão errada que o DEC-009 achou no e-mail.
  //
  // `PuzzlePiece` é o mesmo ícone da entrada de Extensões no menu da empresa
  // (`lib/navigation/catalogo.ts`), de propósito: são duas vistas do mesmo
  // assunto, e ícones diferentes fariam parecer dois assuntos.
  { href: "/admin/extensoes", label: "Extensões", icon: PuzzlePiece },
];

interface AdminSidebarProps {
  userEmail: string;
  /** "mobile" = conteúdo desta MESMA navegação dentro do drawer que `AdminShell`
   * abre abaixo de `lg` — mesmo padrão de `components/shell/Sidebar.tsx`. */
  variant?: "desktop" | "mobile";
}

export function AdminSidebar({ userEmail, variant = "desktop" }: AdminSidebarProps) {
  const t = useT();
  const isMobile = variant === "mobile";
  const pathname = usePathname();
  // Por PROP do servidor, e nunca `branding()`: aquela função lê fontes
  // diferentes nos dois lados da fronteira (`window.__PUBLIC_ENV__` no
  // navegador, `process.env` no servidor), e desde que o layout raiz passou a
  // injetar a marca do BANCO as duas divergem — o nome renderizado no SSR não
  // batia com o hidratado, que é hydration mismatch. Ver `lib/branding/contexto.tsx`.
  const marca = useMarcaDaInstalacao();

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-card",
        isMobile ? "h-full w-full" : "hidden w-60 shrink-0 lg:flex",
      )}
    >
      <div className="flex h-14 items-center gap-3 border-b px-4">
        {/* O nome já está escrito ao lado — o símbolo é reforço, não legenda. */}
        {marcaEhADoProduto(marca) && (
          <SimboloDoProduto nome={marca.name} decorativo className="h-8 w-8" />
        )}
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {marca.name}
          </span>
          <span className="text-sm font-semibold tracking-tight">{t("Admin Plataforma")}</span>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label={t("Navegação plataforma")}>
        {NAV_ITEMS.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
              <span className="truncate">{t(item.label)}</span>
            </Link>
          );
        })}
      </nav>
      <div className="space-y-2 border-t p-3">
        <Link
          href="/app"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          <ArrowRight size={14} aria-hidden />
          <span>{t("Voltar pra app")}</span>
        </Link>
        <p className="truncate px-2 text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </p>
      </div>
    </aside>
  );
}
