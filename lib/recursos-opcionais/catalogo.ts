/**
 * OS RECURSOS OPCIONAIS — a lista única de tudo que se liga e desliga.
 *
 * ─── O defeito que ela fecha ────────────────────────────────────────────────
 *
 * Pedido do mantenedor (doc 73, desenho no doc 80): "estamos acumulando muitas
 * coisas opcionais e até agora não entendi onde ficam os lugares para
 * ativar/desativar". Não existia um lugar que as juntasse: os módulos do
 * servidor moravam numa tela chamada "Comportamento", as chaves de cada empresa
 * em pelo menos nove telas, e as que dependem do servidor em tela nenhuma.
 *
 * ─── O que esta lista É, e o que ela NÃO é ──────────────────────────────────
 *
 * É o MAPA: o que cada recurso faz, quem decide, o padrão, onde se liga e, onde
 * dá para ler, se está ligado. As duas telas que a projetam
 * (`/admin/sistema` e `/app/settings/recursos`) só mostram e levam até lá.
 *
 * NÃO é um segundo caminho de escrita. Quem liga continua sendo a tela do
 * assunto (`href`); duas telas gravando a mesma chave acabariam discordando.
 *
 * ─── Por que ninguém esquece de pôr um recurso aqui ─────────────────────────
 *
 * Os módulos da instalação saem DIRETO de `MODULOS_OPCIONAIS`: o texto de cada
 * um é um `Record<ModuloOpcional, …>`, então módulo novo sem texto não compila.
 * E `tests/unit/recursos-opcionais-catalogo.test.ts` reprova porta com
 * `modulo:`/`capacidade:` no menu que não esteja aqui — o mesmo mecanismo que
 * impede tela sem porta.
 *
 * Os textos são a CHAVE em português do dicionário (`lib/i18n/dicionario.ts`);
 * quem desenha passa por `t()`/`traduzir()`.
 */
import type { Role } from "@/lib/auth/types";
import { MODULOS_OPCIONAIS, MODULOS_OPCIONAIS_POR_FLAG, type ModuloOpcional } from "@/lib/instalacao/modulos";
import { NAV_CATALOG, type NavMetadata } from "@/lib/navigation/catalogo";
import { vendaPeloCanalLigada } from "@/lib/conversoes/venda-pelo-canal";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { capacidadesLigadas, type CapacidadeDaOrganizacao } from "@/lib/organizacao/capacidades";
import { conversaFicaComQuemAtendeu } from "@/lib/schemas/routing";

/** Quem decide: o servidor inteiro, a empresa, cada agente, ou o arquivo do servidor. */
export type NivelDoRecurso = "instalacao" | "organizacao" | "agente" | "servidor";

/**
 * `varia`: vale por número, etapa ou agente — não há um "ligado" da empresa.
 * `nao_verificado`: o estado mora na tela do recurso e esta lista não o lê.
 * `nao_lido`: a leitura falhou agora. Nunca vira "desligado" — "não sei"
 * disfarçado de "desligado" faz procurar um interruptor quando o problema é o banco.
 */
export type EstadoDoRecurso = "ligado" | "desligado" | "varia" | "nao_verificado" | "nao_lido";

export type QuemDecide = "dono_do_servidor" | "admin" | "manager";

/** O que as leituras precisam. `null` = aquela fonte não respondeu. */
export interface FontesDeEstado {
  modulos: readonly ModuloOpcional[] | null;
  /** `organizations.settings` da empresa ativa. */
  settings: Record<string, unknown> | null;
  /** Detecção dos recursos do servidor, por `id`. Ausente/`null` = não detectado. */
  servidor: Readonly<Record<string, boolean | null>>;
}

export interface RecursoOpcional {
  id: string;
  nome: string;
  oQueFaz: string;
  nivel: NivelDoRecurso;
  padrao: "ligado" | "desligado" | "varia";
  quemDecide: QuemDecide;
  /** Onde se liga. `null` = não há tela (só o arquivo do servidor). */
  href: string | null;
  /** O módulo da instalação — o próprio (nível instalação) ou o que o recurso exige. */
  modulo?: ModuloOpcional;
  capacidade?: CapacidadeDaOrganizacao;
  /** Só `servidor`: o que fazer, em uma linha. */
  comoLigar?: string;
  ler?: (f: FontesDeEstado) => EstadoDoRecurso;
}

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const varia = (): EstadoDoRecurso => "varia";

/** Leitura de uma chave de `organizations.settings`. Nunca lança (quem chama embrulha). */
function peloSettings(ligado: (s: Record<string, unknown>) => boolean) {
  return (f: FontesDeEstado): EstadoDoRecurso =>
    f.settings === null ? "nao_lido" : ligado(f.settings) ? "ligado" : "desligado";
}

function peloServidor(id: string) {
  return (f: FontesDeEstado): EstadoDoRecurso => {
    const v = f.servidor[id];
    return v === true ? "ligado" : v === false ? "desligado" : "nao_lido";
  };
}

/** Nome e linha de cada módulo. `Record` exaustivo: módulo novo sem texto não compila. */
const TEXTO_DO_MODULO: Record<ModuloOpcional, { nome: string; oQueFaz: string }> = {
  banco_externo: {
    nome: "Banco de dados externo",
    oQueFaz: "O agente consulta o banco de outro sistema da empresa, como um ERP ou outro CRM.",
  },
  fluxos_atendimento: {
    nome: "Fluxos de atendimento",
    oQueFaz: "A IA conduz um roteiro de perguntas na conversa e grava as respostas na ficha do cliente.",
  },
  propostas: {
    nome: "Propostas comerciais",
    oQueFaz: "A IA monta a proposta pelos modelos da empresa e o PDF sai pelo WhatsApp.",
  },
  crm_b2b: {
    nome: "Empresas e pessoas (venda para empresas)",
    oQueFaz: "Cadastro de empresas por CNPJ, das pessoas que decidem nelas e importação de planilha.",
  },
  honorarios: {
    nome: "Honorários",
    oQueFaz: "Contratos de honorários com parcelas e o controle do que já foi pago.",
  },
};

/**
 * Onde a EMPRESA usa o módulo: a primeira porta do menu que o declara. Lido do
 * menu, e não escrito aqui, para não haver segunda lista de endereços.
 */
export function portaDoModuloNaEmpresa(modulo: ModuloOpcional): { href: string; minRole?: Role } | null {
  const porta = (NAV_CATALOG as readonly NavMetadata[]).find((d) => d.modulo === modulo);
  return porta ? { href: porta.href, minRole: porta.minRole } : null;
}

const MODULOS: RecursoOpcional[] = MODULOS_OPCIONAIS.map((modulo) => ({
  id: `modulo:${modulo}`,
  ...TEXTO_DO_MODULO[modulo],
  nivel: "instalacao" as const,
  padrao: "desligado" as const,
  quemDecide: "dono_do_servidor" as const,
  // Módulo por chave liga em /admin/sistema; módulo de tabela (ADR-0002) se instala em /admin/modulos.
  href: (MODULOS_OPCIONAIS_POR_FLAG as readonly ModuloOpcional[]).includes(modulo)
    ? "/admin/sistema"
    : "/admin/modulos",
  modulo,
  ler: (f: FontesDeEstado): EstadoDoRecurso =>
    f.modulos === null ? "nao_lido" : f.modulos.includes(modulo) ? "ligado" : "desligado",
}));

const DA_INSTALACAO: RecursoOpcional[] = [
  {
    id: "orcamento_de_ia",
    nome: "Proteção de gasto de IA",
    oQueFaz: "Decide o que acontece quando uma empresa passa do teto de gasto de IA.",
    nivel: "instalacao",
    padrao: "ligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/sistema",
  },
  {
    id: "assinatura_no_webhook",
    nome: "Exigir assinatura nas entregas do canal",
    oQueFaz: "Recusa a entrega de mensagem do WhatsApp que não vier assinada.",
    nivel: "instalacao",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/sistema",
  },
  {
    id: "divulgacao_de_pagamento",
    nome: "Divulgação de pagamento no atendimento",
    oQueFaz: "Acrescenta o texto de divulgação à primeira mensagem, ou bloqueia o envio sem ele.",
    nivel: "instalacao",
    padrao: "ligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/sistema",
  },
  {
    id: "promessa_semantica",
    nome: "Conferência de promessa antes de enviar",
    oQueFaz: "Cada envio da IA é conferido para não prometer o que a empresa não cumpre.",
    nivel: "instalacao",
    padrao: "ligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/sistema",
  },
  {
    id: "cadastro",
    nome: "Quem pode criar conta",
    oQueFaz: "Cadastro aberto, só por convite ou com aprovação.",
    nivel: "instalacao",
    padrao: "ligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/cadastro",
  },
  {
    id: "destinos_internos",
    nome: "Destinos internos",
    oQueFaz: "Libera endereços da rede interna, como um modelo de IA rodando na própria máquina.",
    nivel: "instalacao",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/destinos-internos",
  },
];

const DO_SERVIDOR: RecursoOpcional[] = [
  {
    id: "email",
    nome: "E-mail",
    oQueFaz: "Sem ele não sai convite de equipe, recuperação de senha nem entrega de dados da LGPD.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/email",
    comoLigar: "Cadastre o servidor de e-mail ou o serviço externo na tela de E-mail.",
    ler: peloServidor("email"),
  },
  {
    id: "google_agenda",
    nome: "Google Agenda",
    oQueFaz: "Cada pessoa conecta a própria agenda do Google na Agenda.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/google",
    comoLigar: "Cadastre o app do Google na tela Google Agenda.",
    ler: peloServidor("google_agenda"),
  },
  {
    id: "meta",
    nome: "API Oficial da Meta",
    oQueFaz: "Permite conectar números pela API oficial do WhatsApp.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: "/admin/meta",
    comoLigar: "Cadastre o app da Meta na tela API Oficial (Meta).",
    ler: peloServidor("meta"),
  },
  {
    id: "graph_parceiro",
    nome: "WhatsApp oficial por parceiro",
    oQueFaz: "Um segundo fornecedor de WhatsApp oficial, numa aba própria em Conexões.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: null,
    comoLigar: "No arquivo de ambiente do servidor, ligue o canal do parceiro (bloco do parceiro no .env.example) e reinicie o app.",
    ler: peloServidor("graph_parceiro"),
  },
  {
    id: "voz_whatsapp",
    nome: "Chamada de voz pelo WhatsApp",
    oQueFaz: "Fazer e receber chamada de voz pelo número. Depois, cada empresa aceita o risco e liga.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: null,
    comoLigar: "No arquivo de ambiente, WACALLS_API_BASE_URL e WACALLS_API_TOKEN, e voz em COMPOSE_PROFILES.",
    ler: peloServidor("voz_whatsapp"),
  },
  {
    id: "telefonia_sip",
    nome: "Telefonia por SIP",
    oQueFaz: "Atender e ligar por telefone de verdade, com agente de voz.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: null,
    comoLigar: "No servidor, telefonia em COMPOSE_PROFILES e os arquivos do Asterisk. Este app não enxerga isso.",
    ler: () => "nao_verificado",
  },
  {
    id: "nuvemshop",
    nome: "Nuvemshop",
    oQueFaz: "Conecta a loja Nuvemshop da empresa: pedidos e clientes.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: null,
    comoLigar: "No arquivo de ambiente, NUVEMSHOP_APP_ID, NUVEMSHOP_CLIENT_ID e NUVEMSHOP_CLIENT_SECRET.",
    ler: peloServidor("nuvemshop"),
  },
  {
    id: "google_ads",
    nome: "Google Ads",
    oQueFaz: "Permite às empresas devolver a venda ao anúncio do Google.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: null,
    comoLigar: "No arquivo de ambiente, as três variáveis GOOGLE_ADS_*.",
    ler: peloServidor("google_ads"),
  },
  {
    id: "web_push",
    nome: "Notificação com a aba fechada",
    oQueFaz: "Os alertas chegam na bandeja do computador mesmo com o sistema fechado.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: null,
    comoLigar: "No arquivo de ambiente, o par VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY.",
    ler: peloServidor("web_push"),
  },
  {
    id: "transcricao",
    nome: "Transcrição de áudio por outro serviço",
    oQueFaz: "Manda a transcrição dos áudios para um serviço compatível que você escolher.",
    nivel: "servidor",
    padrao: "desligado",
    quemDecide: "dono_do_servidor",
    href: null,
    comoLigar: "No arquivo de ambiente, TRANSCRIPTION_BASE_URL.",
    ler: peloServidor("transcricao"),
  },
];

const DA_EMPRESA: RecursoOpcional[] = [
  {
    id: "conversa_fica_com_quem_atendeu",
    nome: "A conversa fica com quem atendeu",
    oQueFaz: "Quem responde vira dono da conversa, e a IA se cala até alguém devolver.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/settings/atendimento",
    ler: peloSettings((s) => conversaFicaComQuemAtendeu(s)),
  },
  {
    id: "ia_volta_sozinha",
    nome: "A IA volta sozinha sem resposta da equipe",
    oQueFaz: "Devolve a conversa ao agente depois de um tempo sem resposta de uma pessoa.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/settings/atendimento",
    ler: peloSettings((s) => typeof objeto(s.routing)?.handoff_return_after_minutes === "number"),
  },
  {
    id: "atendente_so_ve_os_seus",
    nome: "Atendente só vê os seus",
    oQueFaz: "Restringe o que cada atendente enxerga nas conversas e no funil.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/settings/atendimento",
    ler: peloSettings((s) => s.visibility_mode === "own" || s.visibility_mode === "own_and_unassigned"),
  },
  {
    id: "etapa_move_o_card",
    nome: "Para onde o card vai em cada passo",
    oQueFaz: "Diz ao agente para qual etapa do funil levar o negócio quando qualifica ou agenda.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/settings/tenant/pipelines",
    ler: varia,
  },
  {
    id: "etapa_avisa_na_central",
    nome: "Avisar a equipe quando o negócio entra na etapa",
    oQueFaz: "Abre um aviso na Central quando um card entra naquela etapa.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/settings/tenant/pipelines",
    ler: varia,
  },
  {
    id: "conversoes_meta",
    nome: "Reportar vendas à Meta",
    oQueFaz: "Devolve ao anúncio da Meta as vendas que ele trouxe.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/conversoes",
  },
  {
    id: "venda_pelo_canal",
    nome: "Enviar vendas pelo canal da conversa",
    oQueFaz: "Sem conexão direta com a Meta, a venda sai pelo provedor do canal da conversa.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/conversoes",
    ler: peloSettings((s) => vendaPeloCanalLigada(s)),
  },
  {
    id: "conversoes_google",
    nome: "Reportar vendas ao Google Ads",
    oQueFaz: "Devolve a venda ao Google Ads, com o telefone protegido e só nas etapas escolhidas.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/conversoes",
  },
  {
    id: "captura_de_origem",
    nome: "Endereço de captura de origem",
    oQueFaz: "Um link que registra de qual campanha veio quem chama no WhatsApp.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/conversoes",
  },
  {
    id: "cliente_pela_agenda",
    nome: "Quem tem horário marcado vira cliente",
    oQueFaz: "O contato com agendamento ganha a marca de cliente sozinho.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/tenant/agenda",
    ler: peloSettings((s) => objeto(s.crm)?.cliente_pela_agenda === true),
  },
  {
    id: "colegas_mexem_na_agenda",
    nome: "Atendentes podem mexer na agenda dos colegas",
    oQueFaz: "Qualquer atendente marca e remarca na agenda de outro.",
    nivel: "organizacao",
    padrao: "ligado",
    quemDecide: "manager",
    href: "/app/settings/tenant/agenda",
    // Mesma régua do banco (`fn_colegas_podem_mexer_na_agenda`): só o `false` explícito desliga.
    ler: peloSettings((s) => s.colegas_podem_mexer_na_agenda !== false),
  },
  {
    id: "aviso_no_whatsapp",
    nome: "Receber avisos no WhatsApp",
    oQueFaz: "Os avisos da Central chegam num número de WhatsApp da equipe.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/ai/cases/avisos",
  },
  {
    id: "acesso_da_ia_por_numero",
    nome: "Acesso da IA por número",
    oQueFaz: "Em cada número, a IA atende todo mundo, só números de teste, ninguém, ou só quem veio de uma origem.",
    nivel: "organizacao",
    padrao: "varia",
    quemDecide: "admin",
    href: "/app/connections",
    ler: varia,
  },
  {
    id: "protecao_de_envio",
    nome: "Proteção de envio por número",
    oQueFaz: "Janelas de resposta e de disparo, ritmo, teto diário, envio aos domingos e aquecimento de cada número.",
    nivel: "organizacao",
    padrao: "varia",
    quemDecide: "admin",
    href: "/app/connections",
    ler: varia,
  },
  {
    id: "grupos_na_inbox",
    nome: "Grupos na caixa de entrada",
    oQueFaz: "Em cada número, escolhe quais grupos do WhatsApp aparecem nas conversas.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/connections",
    ler: varia,
  },
  {
    id: "mfa_obrigatorio",
    nome: "Verificação em duas etapas obrigatória",
    oQueFaz: "Exige a verificação em duas etapas de quem administra a empresa.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/security",
    ler: peloSettings((s) => objeto(s.security)?.mfa_required === true),
  },
  {
    id: "voz_da_empresa",
    nome: "Chamada de voz da empresa",
    oQueFaz: "A empresa aceita o risco e liga a chamada de voz pelo WhatsApp, se o servidor oferecer.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/security",
  },
  {
    id: "tronco_sip",
    nome: "Tronco SIP",
    oQueFaz: "As credenciais do provedor de telefonia da empresa, se o servidor tiver telefonia.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/settings/voip-trunk",
  },
  {
    id: "jev",
    nome: "Decisões rápidas por outro provedor",
    oQueFaz: "Uma segunda inteligência decide as partes rápidas do atendimento.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/ai/providers",
    ler: peloSettings((s) => lerConfigDoJev(s).ligado),
  },
  {
    id: "base_com_google",
    nome: "Base de conhecimento com o Google",
    oQueFaz: "Prepara a base de conhecimento com a chave do Google em vez da OpenAI. Trocar refaz a base.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/ai/knowledge/sources",
    // Sem escolha gravada, a família vem da chave cadastrada — e esta lista não lê chave.
    ler: (f) => {
      if (f.settings === null) return "nao_lido";
      const familia = objeto(f.settings.base_de_conhecimento)?.familia;
      return familia === "google" ? "ligado" : familia === "openai" ? "desligado" : "nao_verificado";
    },
  },
  {
    id: "teto_de_gasto",
    nome: "Teto de gasto de IA",
    oQueFaz: "Teto mensal, aviso, e se a IA para ao chegar nele.",
    nivel: "organizacao",
    padrao: "varia",
    quemDecide: "manager",
    href: "/app/ai/usage",
  },
  {
    id: "interface",
    nome: "Quais menus aparecem",
    oQueFaz: "Interface completa, simplificada ou só as portas escolhidas.",
    nivel: "organizacao",
    padrao: "varia",
    quemDecide: "admin",
    href: "/app/settings/tenant",
  },
  {
    id: "extensoes",
    nome: "Extensões",
    oQueFaz: "Pacotes de fora do núcleo, instalados e ativados por empresa.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "admin",
    href: "/app/extensions",
  },
  {
    id: "propostas_da_empresa",
    nome: "Proposta comercial da empresa",
    oQueFaz: "Com o módulo do servidor ligado, a empresa liga as propostas para si.",
    nivel: "organizacao",
    padrao: "desligado",
    quemDecide: "manager",
    href: "/app/settings/tenant/proposals",
    modulo: "propostas",
    capacidade: "propostas",
    ler: (f) =>
      f.settings === null || f.modulos === null
        ? "nao_lido"
        : capacidadesLigadas(f.settings, f.modulos).includes("propostas")
          ? "ligado"
          : "desligado",
  },
];

const DE_CADA_AGENTE: RecursoOpcional[] = [
  {
    id: "ajustes_do_agente",
    nome: "Ajustes de cada agente",
    oQueFaz:
      "Ligar e desligar, #on/#off pelo celular, mensagens curtas, chamar uma pessoa, filtros de gatilho, ferramentas e voz.",
    nivel: "agente",
    padrao: "varia",
    quemDecide: "manager",
    href: "/app/ai/agents",
    ler: varia,
  },
  {
    id: "roteiro_nao_recomeca",
    nome: "Roteiro que não recomeça",
    oQueFaz: "Em cada roteiro, quem já respondeu não é perguntado de novo.",
    nivel: "agente",
    padrao: "varia",
    quemDecide: "manager",
    href: "/app/ai/atendimento",
    modulo: "fluxos_atendimento",
    ler: varia,
  },
];

export const RECURSOS_OPCIONAIS: readonly RecursoOpcional[] = [
  ...MODULOS,
  ...DA_INSTALACAO,
  ...DO_SERVIDOR,
  ...DA_EMPRESA,
  ...DE_CADA_AGENTE,
];

/**
 * O estado de um recurso. NUNCA lança: leitura que explode vira `nao_lido`,
 * nunca "desligado" (falha aberta na informação). Recurso que exige um módulo
 * desligado no servidor fica desligado, seja qual for a chave da empresa.
 */
export function estadoDoRecurso(recurso: RecursoOpcional, fontes: FontesDeEstado): EstadoDoRecurso {
  try {
    if (recurso.modulo && recurso.nivel !== "instalacao") {
      if (fontes.modulos === null) return "nao_lido";
      if (!fontes.modulos.includes(recurso.modulo)) return "desligado";
    }
    return recurso.ler ? recurso.ler(fontes) : "nao_verificado";
  } catch {
    return "nao_lido";
  }
}

/** O rótulo de cada estado, na voz da tela. Chave do dicionário. */
export const ROTULO_DO_ESTADO: Record<EstadoDoRecurso, string> = {
  ligado: "Ligado",
  desligado: "Desligado",
  varia: "Varia em cada item",
  nao_verificado: "Veja na tela dele",
  nao_lido: "Não consegui ler agora",
};

export const ROTULO_DE_QUEM_DECIDE: Record<QuemDecide, string> = {
  dono_do_servidor: "Quem administra o servidor",
  admin: "Administrador da empresa",
  manager: "Gerente ou administrador",
};

export const ROTULO_DO_PADRAO: Record<RecursoOpcional["padrao"], string> = {
  ligado: "Padrão: ligado",
  desligado: "Padrão: desligado",
  varia: "Padrão: varia",
};
