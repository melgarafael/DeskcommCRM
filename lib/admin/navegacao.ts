/**
 * Navegação do ADMINISTRADOR DA INSTALAÇÃO — fonte única.
 *
 * Esta lista morava dentro de `components/admin/AdminSidebar.tsx`. Saiu de lá
 * porque ganhou um segundo consumidor: a busca (⌘K) do painel. Duas listas
 * copiadas divergem no primeiro item novo que alguém esquece de duplicar, e a
 * busca passaria a levar a telas que o menu não mostra (ou o contrário).
 *
 * Ela NÃO entra em `lib/navigation/registry.ts` e isto é deliberado: aquele
 * registro descreve a navegação do TENANT (`app/app/**`) e o teste de
 * completude que o vigia varre só aquela raiz. O administrador de plataforma
 * tem navegação própria — e é esta.
 *
 * Quem vigia a completude daqui é `tests/unit/admin-navegacao-completude.test.ts`:
 * tela de primeiro nível em `app/admin/(protected)/` sem porta nesta lista
 * reprova. Ele lê ESTE arquivo, então mover uma entrada de volta para o
 * componente não é uma opção: o guard apontaria para o vazio.
 */
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import {
  Buildings,
  CalendarBlank,
  ChartBar,
  ChatsCircle,
  ClipboardText,
  EnvelopeSimple,
  Gauge,
  Gear,
  Key,
  Lock,
  Palette,
  Plugs,
  PuzzlePiece,
  Receipt,
  Scales,
  ShieldCheck,
  Stack,
  Users,
  Warning,
  WebhooksLogo,
} from "@/lib/ui/icons";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

export type AdminGrupoId = "operacao" | "clientes" | "canais" | "plataforma";

export interface AdminGrupo {
  id: AdminGrupoId;
  /** Texto em português: é a CHAVE do dicionário (ver `lib/i18n/dicionario.ts`). */
  label: string;
}

/**
 * Os grupos existem para a busca conseguir mostrar o catálogo inteiro sem
 * digitar nada — 20 telas numa lista corrida é a mesma rolagem que a sidebar.
 *
 * A ordem aqui é a ordem na tela, e a paleta ordena por ela.
 */
export const ADMIN_GROUPS: readonly AdminGrupo[] = [
  { id: "operacao", label: "Operação" },
  { id: "clientes", label: "Clientes" },
  { id: "canais", label: "Canais" },
  { id: "plataforma", label: "Plataforma" },
];

export interface AdminDestination {
  href: string;
  label: string;
  /**
   * Uma linha dizendo o que a tela resolve. Não é enfeite: é o que faz a busca
   * achar por INTENÇÃO e não só por nome ("smtp" → E-mail, "chave" →
   * Credenciais, "whatsapp" → API Oficial (Meta)). Sem ela, quem não sabe o
   * nome da tela continua sem achar.
   */
  description: string;
  group: AdminGrupoId;
  icon: PhosphorIcon;
  /** Só aparece com este módulo da instalação ligado (spec da cobrança §9). */
  modulo?: ModuloOpcional;
}

export const ADMIN_DESTINATIONS: readonly AdminDestination[] = [
  // ── Operação ──────────────────────────────────────────────────────────────
  {
    href: "/admin/dashboard",
    label: "Dashboard",
    description: "Visão geral da instalação: números do dia e saúde dos serviços",
    group: "operacao",
    icon: Gauge,
  },
  {
    href: "/admin/inbox",
    label: "Inbox",
    description: "Conversas de todas as empresas da instalação numa caixa só",
    group: "operacao",
    icon: ChatsCircle,
  },
  {
    href: "/admin/incidents",
    label: "Incidents",
    description: "Incidentes da plataforma e o que foi feito em cada um",
    group: "operacao",
    icon: Warning,
  },
  {
    href: "/admin/audit",
    label: "Audit",
    description: "Trilha de auditoria: quem fez o quê e quando",
    group: "operacao",
    icon: ClipboardText,
  },
  {
    href: "/admin/lgpd",
    label: "LGPD",
    description: "Pedidos de titular: exportar, anonimizar e prazos",
    group: "operacao",
    icon: Scales,
  },

  // ── Clientes ──────────────────────────────────────────────────────────────
  {
    href: "/admin/tenants",
    label: "Tenants",
    description: "Empresas da instalação: criar, listar e abrir cada uma",
    group: "clientes",
    icon: Buildings,
  },
  {
    href: "/admin/users",
    label: "Users",
    description: "Usuários da instalação e os papéis de cada um",
    group: "clientes",
    icon: Users,
  },
  {
    href: "/admin/platform-admins",
    label: "Platform Admins",
    description: "Quem tem poder de plataforma nesta instalação",
    group: "clientes",
    icon: ShieldCheck,
  },
  {
    href: "/admin/usage",
    label: "Usage",
    description: "Consumo de IA e de mensagens por empresa",
    group: "clientes",
    icon: ChartBar,
  },

  // ── Canais e integrações da instalação ────────────────────────────────────
  {
    href: "/admin/google",
    label: "Google Agenda",
    description: "App OAuth do Google: cliente e segredo para a agenda",
    group: "canais",
    icon: CalendarBlank,
  },
  {
    href: "/admin/meta",
    label: "API Oficial (Meta)",
    description: "App da Meta: chave secreta e token do webhook do WhatsApp oficial",
    group: "canais",
    icon: WebhooksLogo,
  },
  {
    href: "/admin/email",
    label: "E-mail",
    description: "Servidor SMTP: host, porta, remetente e senha",
    group: "canais",
    icon: EnvelopeSimple,
  },
  {
    href: "/admin/destinos-internos",
    label: "Destinos internos",
    description: "Endereços da rede interna liberados para a instalação",
    group: "canais",
    icon: Plugs,
  },

  // ── Plataforma (configuração da instalação) ───────────────────────────────
  {
    href: "/admin/marca",
    label: "Marca",
    description: "Nome, logo e cores da instalação",
    group: "plataforma",
    icon: Palette,
  },
  {
    href: "/admin/cadastro",
    label: "Cadastro",
    description: "Quem pode criar conta nesta instalação",
    group: "plataforma",
    icon: Key,
  },
  {
    href: "/admin/configuracao",
    label: "Credenciais",
    description: "Chaves e segredos guardados da instalação",
    group: "plataforma",
    icon: Lock,
  },
  {
    href: "/admin/sistema",
    label: "Recursos opcionais",
    description: "Ligar e desligar módulos e comportamentos da instalação",
    group: "plataforma",
    icon: Gear,
  },
  {
    href: "/admin/extensoes",
    label: "Extensões",
    description: "Catálogo de extensões do servidor",
    group: "plataforma",
    icon: PuzzlePiece,
  },
  {
    href: "/admin/modulos",
    label: "Módulos",
    description: "Instalar e ligar módulos opcionais (honorários, cobrança…)",
    group: "plataforma",
    icon: Stack,
  },
  // A tela só existe com a chave `cobranca` ligada — desligada,
  // `/admin/cobranca` responde 404 e o menu do dono segue sem ela.
  {
    href: "/admin/cobranca",
    label: "Cobrança",
    description: "Planos e cobrança do revendedor",
    group: "plataforma",
    icon: Receipt,
    modulo: "cobranca",
  },
];

/**
 * O que o menu e a busca mostram: mesma lista, mesmo filtro de módulo.
 *
 * Padrão `[]` = nenhum módulo ligado, igual ao que a sidebar fazia como
 * `modulosLigados = []` — um chamador que esqueça a prop esconde as entradas
 * condicionais em vez de mostrá-las por engano.
 */
export function destinosDoAdmin(
  modulosLigados: readonly ModuloOpcional[] = [],
): AdminDestination[] {
  return ADMIN_DESTINATIONS.filter(
    (destino) => !destino.modulo || modulosLigados.includes(destino.modulo),
  );
}
