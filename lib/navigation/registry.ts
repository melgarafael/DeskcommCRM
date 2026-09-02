import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { ROLE_RANK, type Role } from "@/lib/auth/types";
import {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Palette,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
} from "@/lib/ui/icons";

/**
 * Registro de navegação — a ÚNICA lista de destinos do app do tenant.
 *
 * Antes disto, três listas descreviam o mesmo conjunto e divergiam: `NAV_ITEMS`
 * no Sidebar, `LINKS` no hub de Configurações e `TABS` na área de IA. Sete telas
 * só eram alcançáveis por dentro da própria seção e uma não tinha link nenhum.
 *
 * Sidebar, hubs e a paleta ⌘K são PROJEÇÕES puras deste array — nenhum deles
 * decide o que existe, só desenha o que sai daqui. Tela nova aparece nos três
 * sem editar três arquivos, e `tests/unit/navegacao-completude.test.ts` reprova
 * o CI se uma rota nascer fora daqui.
 *
 * Doutrina: docs/doctrine/sistema-vivo.md — "por qual porta se chega até mim?"
 */

export type NavGroupId = "atendimento" | "crm" | "ia" | "canais" | "analise" | "organizacao";

export interface NavGroup {
  id: NavGroupId;
  label: string;
  /**
   * Hub do grupo, quando ele tem telas demais para caber no sidebar.
   * O rótulo é declarado junto do href porque não é derivável: "Ver tudo em IA"
   * é útil, "Ver tudo em Organização" seria gratuito quando a tela já se chama
   * Configurações e o usuário a conhece por esse nome.
   */
  hub?: { href: string; label: string };
}

export interface NavDestination {
  href: string;
  label: string;
  /** Aparece no card do hub e é texto buscável no ⌘K. Nunca vazio. */
  description: string;
  icon: PhosphorIcon;
  group: NavGroupId;
  /** Obrigatória em grupo com hub — é o agrupamento por jornada dentro dele. */
  section?: string;
  /** Ausente = viewer. Ver a regra de escolha abaixo. */
  minRole?: Role;
  /** Ausente = só no hub. `true` = uso diário, sobe para o sidebar. */
  sidebar?: boolean;
  healthDot?: boolean;
}

/**
 * Grupos por OBJETIVO, na ordem de uso: o que se abre toda hora primeiro, o que
 * se ajusta uma vez por mês por último.
 *
 * "Análise" e não "Observabilidade": quem instala isto numa VPS é dono de PME,
 * não engenheiro. E configurar o sistema (grupo IA) é atividade diferente de
 * observar o sistema funcionando (grupo Análise) — por isso Evolução da IA mora
 * aqui, e não junto dos agentes.
 *
 * Hub só onde o grupo passa de 4 telas. Abaixo disso ele cabe inteiro no
 * sidebar, e um hub de 3 itens seria só um clique a mais para chegar onde já
 * dava para chegar.
 */
export const NAV_GROUPS: NavGroup[] = [
  { id: "atendimento", label: "Atendimento" },
  { id: "crm", label: "CRM" },
  { id: "ia", label: "Agente de IA", hub: { href: "/app/ai", label: "Ver tudo em IA" } },
  { id: "canais", label: "Canais" },
  { id: "analise", label: "Análise" },
  {
    id: "organizacao",
    label: "Organização",
    hub: { href: "/app/settings", label: "Configurações" },
  },
];

/**
 * Grupo cujo hub vive no RODAPÉ fixo do sidebar, fora da área que rola.
 *
 * Medido em tela (1280×768, o notebook comum): com todos os grupos na área
 * rolável, o conteúdo dava 1019px contra 663px visíveis — Configurações ficava
 * fora da dobra em TODAS as alturas testadas, inclusive 1080px. É o item que
 * mais se procura quando não se acha algo; deixá-lo dependendo de scroll
 * recriaria, em outra forma, o problema que esta reorganização veio resolver.
 */
export const GRUPO_NO_RODAPE: NavGroupId = "organizacao";

/**
 * Como `minRole` foi escolhido — medido tela a tela, não estimado:
 *
 *   1. A página redireciona por papel?  → usa esse papel. Assim a navegação
 *      nunca mostra um link que morre em /403.
 *   2. Não redireciona, mas a navegação antiga já filtrava? → mantém o filtro
 *      antigo, para esta mudança reorganizar sem alterar quem vê o quê.
 *   3. Nenhum dos dois → viewer.
 *
 * `ROLE_RANK` só distingue papel dentro do tenant; capacidade interna da tela
 * (`canShare` em Respostas rápidas, `canCompare` em Desempenho) NÃO é porta
 * fechada e por isso não vira `minRole`.
 */
export const NAV_DESTINATIONS: NavDestination[] = [
  // ---- Atendimento — onde o operador passa o dia ----
  {
    href: "/app/inbox",
    label: "Inbox",
    description: "As conversas de WhatsApp, com você e a IA atendendo lado a lado.",
    icon: Inbox,
    group: "atendimento",
    sidebar: true,
  },
  {
    href: "/app/radar",
    label: "Radar",
    description: "Quem esfriou e ainda está aberto — o que corre risco de morrer sem resposta.",
    icon: ClockCountdown,
    group: "atendimento",
    sidebar: true,
  },
  {
    // Entra em "atendimento", e não em "organizacao", porque a Agenda é onde o
    // dia acontece e não onde ele se configura: quem atende abre isto de manhã
    // junto com o Inbox. Os TIPOS de agendamento — que são configuração de
    // verdade — foram para Configurações, como este comentário previa: ver
    // `/app/settings/tenant/agenda` no grupo "organizacao".
    //
    // ⚠️ ESTA FRASE ESTAVA VENCIDA: dizia "a disponibilidade ainda não tem tela",
    // e tem — é a aba "Atendimento" de `/app/team`, com editor de fuso e janelas
    // (`app/app/team/_components/AttendantsClient.tsx`). Ela chegou a custar uma
    // investigação inteira: quem leu isto aqui concluiu que faltava construir a
    // tela, quando o que faltava era o CAMINHO até ela. O aviso da Agenda agora
    // aponta para `/app/team?aba=atendimento`.
    href: "/app/agenda",
    label: "Agenda",
    description: "O que está marcado, com quem, e quem atende — seu e da equipe.",
    icon: CalendarBlank,
    group: "atendimento",
    sidebar: true,
  },
  {
    // Renomeado de "Templates": estes são scripts do atendente, consumidos pelo
    // Composer do inbox. O nome "Templates" fica livre para os da Meta (HSM),
    // onde é o termo técnico correto.
    href: "/app/templates",
    label: "Respostas rápidas",
    description: "Scripts salvos para responder mais rápido, seus ou da equipe.",
    icon: FileText,
    group: "atendimento",
    sidebar: true,
  },

  // ---- CRM — o funil ----
  {
    // ⚠️ ERA "Kanban", e a URL continua sendo. O nome saiu da interface porque o
    // produto tinha CINCO vocabulários para a mesma coisa — "Kanban" no menu,
    // "Pipelines" no título desta tela, "Funis" no menu ao lado, "funil" em todo
    // o corpo dela e "quadro" no onboarding inteiro. Três deles no mesmo
    // viewport: o <h1> dizia "Pipelines", o estado vazio dizia "Sem pipelines
    // configurados" e o botão embaixo dizia "Criar meu primeiro funil".
    //
    // Ficou "Funis" porque é o que esta tela É: a lista dos funis, de onde se
    // abre o quadro de cada um. "Pipeline" é palavra de quem construiu o
    // sistema; "funil de vendas" é palavra de quem vende.
    href: "/app/kanban",
    label: "Funis",
    description: "Seus funis de venda — clique em um para abrir o quadro de clientes.",
    icon: Kanban,
    group: "crm",
    sidebar: true,
  },
  {
    href: "/app/contacts",
    label: "Contatos",
    description: "As pessoas do outro lado da conversa e seu histórico.",
    icon: Users,
    group: "crm",
    sidebar: true,
  },
  {
    // ⚠️ Esta tela nasceu porque a FERRAMENTA já existia sem ela. O agente de IA
    // vinha com "procurar produto na loja" ligada por padrão, lendo uma tabela
    // que ninguém nunca preencheu — e o efeito não era silêncio: era o agente
    // respondendo "não tenho nada com esse nome" para uma loja de estoque cheio.
    //
    // Fica no grupo do CRM, e não em Configurações, porque consultar preço é
    // trabalho de quem ATENDE, todo dia — diferente de "tipos de agendamento",
    // que se configura uma vez.
    href: "/app/products",
    label: "Produtos",
    description: "O catálogo da loja, com o preço que o atendente de IA responde.",
    icon: Storefront,
    group: "crm",
    sidebar: true,
  },
  {
    // A promessa que o comentário da Agenda fazia desde que ela nasceu. Aqui se
    // decide O QUE se pode marcar, quanto dura e quem atende — e é isto que a
    // tela de marcar e o agente de IA oferecem ao cliente.
    //
    // Nasceu porque a `calendar_event_types` tinha dez categorias no CHECK,
    // duração, buffers e antecedência mínima, e NÃO havia como criar ou editar
    // um tipo por lugar nenhum: a organização recebia três semeados e ficava com
    // eles para sempre.
    href: "/app/settings/tenant/agenda",
    label: "Tipos de agendamento",
    description: "O que se pode marcar, quanto dura, onde acontece e quem atende.",
    icon: CalendarBlank,
    group: "organizacao",
    // "Sua empresa", junto de Atendimento e Empresa: é configuração do NEGÓCIO,
    // não da conta de quem está logado. O gate `navegacao-registry` cobra a
    // seção em todo grupo que tem hub, e sem ela o destino não aparece no hub.
    section: "Sua empresa",
    // SEM `sidebar`, como as outras DEZ entradas de "organizacao": este grupo
    // tem hub, e se chega às telas dele por "Configurações". Eu tinha posto
    // `sidebar: true` e a cerca reprovou dizendo "a tela existe e não tem porta
    // na navegação" — a porta existia, era outra.
  },
  {
    // Estava enterrado em Configurações e ninguém sabia que existia — o achado
    // que originou esta reorganização. A URL não muda; só o lugar na navegação.
    //
    // ⚠️ ERA "Funis", nome que ele DISPUTAVA com o destino acima: os dois
    // listavam as mesmas linhas de `crm_pipelines`, lado a lado no mesmo grupo,
    // com nomes que não diziam qual servia para quê. A diferença real é o VERBO,
    // e é ela que o nome carrega agora: lá se ABRE o funil, aqui se CONFIGURA o
    // que ele significa.
    href: "/app/settings/tenant/pipelines",
    label: "Etapas do funil",
    description: "As colunas de cada funil, o vocabulário do negócio e os motivos de perda.",
    icon: Funnel,
    group: "crm",
    minRole: "manager",
    sidebar: true,
  },

  // ---- Agente de IA — montar, ensinar, acompanhar ----
  {
    href: "/app/ai/agents",
    label: "Agentes",
    description: "Quem atende por você: instruções, modelo, ferramentas e publicação.",
    icon: Robot,
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    sidebar: true,
  },
  {
    href: "/app/ai/followups",
    label: "Follow-ups",
    description: "Como o agente retoma uma conversa que esfriou, para nenhuma morrer no silêncio.",
    icon: FlowArrow,
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    sidebar: true,
  },
  {
    href: "/app/ai/routers",
    label: "Roteadores",
    description: "Qual agente pega qual conversa, e quando o humano assume.",
    icon: Signpost,
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    sidebar: true,
  },
  {
    href: "/app/ai/credentials",
    label: "Credenciais",
    description: "A chave do provedor de IA que os agentes usam para pensar.",
    icon: Key,
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
  },
  {
    // O sistema chama modelo em 23 lugares e, até esta tela, a escolha vivia
    // espalhada por três pilhas de código e sete variáveis de ambiente — não
    // havia onde responder "quem usa IA aqui, e com qual chave?".
    href: "/app/ai/providers",
    label: "Provedores",
    description: "Qual inteligência atende cada parte do sistema — e o que acontece se ela falhar.",
    icon: Plugs,
    group: "ia",
    section: "Montar o agente",
    minRole: "manager",
    // SEM `sidebar: true`, como as outras nove telas deste grupo. Adicionar as
    // duas telas novas à sidebar estourou a dobra em 900px — medido pelo e2e
    // `navegacao.spec.ts`, que existe justamente porque agrupar o menu o faz
    // crescer. Configurar provedor é tarefa de poucas vezes; o caminho é o hub
    // "Ver tudo em IA", igual a Credenciais, Conhecimento, Memória e Skills.
  },
  {
    href: "/app/ai/knowledge/sources",
    label: "Conhecimento",
    description: "Os materiais que o agente consulta antes de responder sobre o seu negócio.",
    icon: BookOpen,
    group: "ia",
    section: "Ensinar o agente",
    minRole: "manager",
  },
  {
    href: "/app/ai/memory",
    label: "Memória",
    description: "O que o agente já aprendeu sobre a sua operação e reaproveita.",
    icon: Brain,
    group: "ia",
    section: "Ensinar o agente",
    minRole: "manager",
  },
  {
    href: "/app/ai/skills",
    label: "Skills",
    description: "As ações que o agente pode executar sozinho durante o atendimento.",
    icon: PuzzlePiece,
    group: "ia",
    section: "Ensinar o agente",
    minRole: "manager",
  },
  {
    href: "/app/ai/cases",
    label: "Casos",
    description: "Os atendimentos que o agente conduziu, do início ao desfecho.",
    icon: ClipboardText,
    group: "ia",
    section: "Acompanhar o agente",
    minRole: "agent",
  },
  {
    href: "/app/ai/inbox",
    label: "Alertas",
    description: "O que a IA encontrou e precisa de uma decisão sua.",
    icon: Flag,
    group: "ia",
    section: "Acompanhar o agente",
  },
  {
    // Órfã: nenhum lugar do app linkava para cá. O flywheel gerava propostas de
    // melhoria do agente e a fila só era vista por quem soubesse a URL.
    href: "/app/ai/proposals",
    label: "Propostas",
    description: "Melhorias que a IA sugere para si mesma, esperando sua decisão.",
    icon: Lightbulb,
    group: "ia",
    section: "Acompanhar o agente",
  },
  {
    // A tela de Uso responde "quanto gastei". Esta responde a pergunta que não
    // tinha lugar nenhum: "o agente parou de responder, o que aconteceu?".
    // Antes da migration 0128 ela seria impossível de construir com honestidade
    // — llm_calls só registrava sucesso.
    href: "/app/ai/runs",
    label: "Execuções",
    description: "O que a IA fez — e, quando falhou, o que aconteceu e o que fazer.",
    icon: ListChecks,
    group: "ia",
    section: "Acompanhar o agente",
    minRole: "manager",
    // Idem: fora da sidebar para o menu não passar da dobra. Quem vem para cá
    // está diagnosticando, e chega pelo hub ou pelo link do aviso na Central.
  },
  {
    href: "/app/ai/usage",
    label: "Uso e orçamento",
    description: "Quanto a IA consumiu e qual é o teto de gasto do mês.",
    icon: Gauge,
    group: "ia",
    section: "Acompanhar o agente",
    minRole: "manager",
  },

  // ---- Canais — por onde as mensagens entram e saem ----
  {
    href: "/app/connections",
    label: "Conexões",
    // Cobre os DOIS caminhos desde o PR #105: número por QR e canal oficial da
    // Meta (com os templates dele), cada um numa aba. A descrição cita "oficial"
    // e "Meta" de propósito — é por esses nomes que se procura no ⌘K, e a busca
    // varre a descrição além do rótulo.
    description:
      "Seus números de WhatsApp: por QR ou canal oficial da Meta, com saúde, reconexão e templates.",
    icon: PlugsConnected,
    group: "canais",
    minRole: "admin",
    sidebar: true,
    healthDot: true,
  },
  {
    // Não tinha link nenhum no app inteiro: só se chegava digitando a URL.
    href: "/app/integrations/nuvemshop",
    label: "Nuvemshop",
    description: "Conecte a loja para trazer pedidos e clientes para dentro do CRM.",
    icon: Storefront,
    group: "canais",
    // A página não filtra por papel, mas as Server Actions de conectar e
    // desconectar exigem admin — mostrar a um viewer seria oferecer botão morto.
    minRole: "admin",
    sidebar: true,
  },
  {
    href: "/app/webhooks",
    label: "Webhooks",
    description: "Avise outros sistemas quando algo acontecer aqui dentro.",
    icon: WebhooksLogo,
    group: "canais",
    minRole: "manager",
    sidebar: true,
  },

  // ---- Análise — olhar o sistema funcionando ----
  {
    href: "/app/metrics",
    label: "Desempenho",
    description: "Funil e performance por atendente nos últimos 30 dias.",
    icon: ChartBar,
    group: "analise",
    sidebar: true,
  },
  {
    // Observabilidade, não configuração: por isso não fica junto dos agentes.
    href: "/app/ai/evolution",
    label: "Evolução da IA",
    description: "Se o agente está melhorando, onde ele erra e o que falta ensinar.",
    icon: ChartLineUp,
    group: "analise",
    minRole: "manager",
    sidebar: true,
  },
  {
    href: "/app/audit",
    label: "Audit Log",
    description: "Quem fez o quê, quando — o histórico que não se apaga.",
    icon: ClockCounterClockwise,
    group: "analise",
    minRole: "manager",
    sidebar: true,
  },

  // ---- Organização — conta, empresa, acesso ----
  {
    href: "/app/settings/profile",
    label: "Perfil",
    description: "Seu nome, idioma, fuso horário e avatar.",
    icon: UserCircle,
    group: "organizacao",
    section: "Sua conta",
  },
  {
    href: "/app/settings/security",
    label: "Segurança",
    description: "Verificação em duas etapas, códigos de recuperação e sessões.",
    icon: ShieldCheck,
    group: "organizacao",
    section: "Sua conta",
  },
  {
    href: "/app/settings/notifications",
    label: "Notificações",
    description: "Por onde e sobre o quê você quer ser avisado.",
    icon: Bell,
    group: "organizacao",
    section: "Sua conta",
  },
  {
    href: "/app/team",
    label: "Equipe",
    description: "Quem trabalha aqui, com qual papel e quanta conversa cada um aguenta.",
    icon: UsersThree,
    group: "organizacao",
    section: "Sua empresa",
  },
  {
    // A porta que faltava (issue #144): rodízio de atendimento e restrição de
    // visibilidade existiam inteiros no backend e não tinham NENHUMA tela — só
    // dava para ligar com UPDATE à mão no banco.
    href: "/app/settings/atendimento",
    label: "Distribuição de atendimento",
    description: "Quem recebe cada cliente novo, e o que cada atendente enxerga.",
    icon: UsersThree,
    group: "organizacao",
    section: "Sua empresa",
    minRole: "manager",
  },
  {
    href: "/app/settings/tenant",
    label: "Organização",
    description: "Dados da empresa, retenção de dados e encarregado de LGPD.",
    icon: Buildings,
    group: "organizacao",
    section: "Sua empresa",
    minRole: "admin",
  },
  {
    href: "/app/settings/marca",
    label: "Marca",
    description: "O nome e a cor que sua empresa mostra dentro do sistema.",
    icon: Palette,
    group: "organizacao",
    section: "Sua empresa",
    // `admin` pelo mesmo motivo da linha de cima: o que se edita ali é
    // identidade da empresa, e dá-lo a `manager` o colocaria abaixo de billing e
    // de API tokens na mesma prancheta.
    minRole: "admin",
    // SEM `sidebar`: fica só no hub. Trocar a marca é tarefa de uma vez, e
    // agrupar o menu já o fez crescer — duas telas a mais estouraram a dobra em
    // 900px, medido pelo e2e `navegacao.spec.ts`.
  },
  {
    href: "/app/settings/billing",
    label: "Billing",
    description: "Plano e cobrança.",
    icon: Receipt,
    group: "organizacao",
    section: "Sua empresa",
    minRole: "admin",
  },
  {
    href: "/app/lgpd/requests",
    label: "LGPD",
    description: "Pedidos de exportação e exclusão de dados feitos por clientes.",
    icon: ScalesSimple,
    group: "organizacao",
    section: "Dados e acesso",
    minRole: "admin",
  },
  {
    href: "/app/settings/api-tokens",
    label: "API Tokens",
    description: "Chaves para outro sistema conversar com o seu CRM.",
    icon: Lock,
    group: "organizacao",
    section: "Dados e acesso",
    minRole: "admin",
  },
];

/**
 * Único ponto de decisão de permissão da navegação.
 *
 * É o que dispensa os sete `usePermission()` que o Sidebar chamava em sequência
 * — hooks não rodam em laço condicional, então cada permissão exigia sua linha.
 * Como função pura, um `.filter()` resolve todas.
 */
export function canSee(d: NavDestination, isPlatformAdmin: boolean, role: Role | null): boolean {
  if (isPlatformAdmin) return true;
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[d.minRole ?? "viewer"];
}

/** Projeção do sidebar: só o uso diário, agrupado, sem grupo vazio. */
export function sidebarGroups(
  isPlatformAdmin: boolean,
  role: Role | null,
): Array<{ group: NavGroup; items: NavDestination[] }> {
  return NAV_GROUPS.map((group) => ({
    group,
    items: NAV_DESTINATIONS.filter(
      (d) => d.group === group.id && d.sidebar && canSee(d, isPlatformAdmin, role),
    ),
  })).filter((g) => g.items.length > 0);
}

/**
 * Projeção do hub: TODAS as telas do grupo — inclusive as que já estão no
 * sidebar. O hub é inventário, não sobra; é onde se descobre o que existe.
 *
 * A ordem das seções é a de primeira aparição no registro, então reordenar a
 * jornada é reordenar o array — não há uma segunda lista para manter em sincronia.
 */
export function hubSections(
  group: NavGroupId,
  isPlatformAdmin: boolean,
  role: Role | null,
): Array<{ section: string; items: NavDestination[] }> {
  const porSecao = new Map<string, NavDestination[]>();
  for (const d of NAV_DESTINATIONS) {
    if (d.group !== group || !canSee(d, isPlatformAdmin, role)) continue;
    const secao = d.section ?? "";
    const atual = porSecao.get(secao);
    if (atual) atual.push(d);
    else porSecao.set(secao, [d]);
  }
  return [...porSecao.entries()].map(([section, items]) => ({ section, items }));
}

/** Projeção do ⌘K: todo destino visível, do sidebar ou não. */
export function searchable(isPlatformAdmin: boolean, role: Role | null): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) => canSee(d, isPlatformAdmin, role));
}
