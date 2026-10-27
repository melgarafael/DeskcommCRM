/**
 * A paleta de blocos do mapa (plano de 27/10, item 5): cada ESPÉCIE é o que a
 * pessoa vê e escolhe; o TIPO é o que o motor faz quando chega a vez. Puro —
 * a tela, as ações, os modelos prontos e o CHECK da migration 9014 leem daqui.
 */
import type { AcaoDaIa } from "../ia/catalogo";

/** O efeito no motor (coluna `tipo`). */
export const TIPOS_DE_BLOCO = ["tarefa", "marco", "aviso", "publicacao", "espera", "nota"] as const;
export type TipoDeBloco = (typeof TIPOS_DE_BLOCO)[number];

export const GRUPOS_DE_BLOCO = {
  comercial: "Reuniões e comercial (Etapa 1)",
  producao: "Produção de conteúdo (Etapas 2 e 3)",
  redes: "Redes e anúncios",
  avulsos: "Serviços avulsos",
  controle: "Controle",
} as const;
export type GrupoDeBloco = keyof typeof GRUPOS_DE_BLOCO;

export interface EspecieDeBloco {
  especie: string;
  grupo: GrupoDeBloco;
  rotulo: string;
  /** O que o bloco faz, em uma frase (paleta e painel). */
  faz: string;
  tipo: TipoDeBloco;
  cor: string;
  /** Nome do ícone em `lib/ui/icons` (a tela resolve). */
  icone: string;
  titulo: string;
  checklist?: string[];
  executor?: "humano" | "ia";
  acaoIa?: AcaoDaIa;
  /** Atalho que a tarefa leva (a tela certa para cumprir o passo). */
  atalho?: "calendario" | "contratos" | "envios" | "publicacoes" | "drive" | "configuracoes";
}

const AZUL = "#2563eb";
const VERDE = "#16a34a";
const LARANJA = "#ea580c";
const ROXO = "#7c3aed";
const VERMELHO = "#dc2626";
const TURQUESA = "#0d9488";
const AMARELO = "#ca8a04";
const CINZA = "#64748b";

export const ESPECIES_DE_BLOCO: readonly EspecieDeBloco[] = [
  // ── Etapa 1 ──
  { especie: "apresentacao", grupo: "comercial", rotulo: "Apresentação", faz: "Tarefa de marcar a reunião de Apresentação, com a pauta do apêndice A.", tipo: "tarefa", cor: AZUL, icone: "CalendarBlank", titulo: "Reunião de Apresentação", atalho: "calendario", checklist: ["Marcar a reunião (Meet se online)", "Levar a pauta da Apresentação", "Gravar a reunião"] },
  { especie: "proposta", grupo: "comercial", rotulo: "Preparar proposta", faz: "Tarefa da apresentação e da proposta (a IA pode rascunhar).", tipo: "tarefa", cor: AZUL, icone: "FileText", titulo: "Preparar apresentação e proposta" },
  { especie: "fechamento", grupo: "comercial", rotulo: "Fechamento", faz: "Tarefa de marcar o Fechamento (D+7 da Apresentação).", tipo: "tarefa", cor: AZUL, icone: "Briefcase", titulo: "Reunião de Fechamento", atalho: "calendario", checklist: ["Levar contrato impresso", "Levar link de pagamento"] },
  { especie: "contrato", grupo: "comercial", rotulo: "Gerar contrato", faz: "Tarefa de gerar o contrato e mandar para assinar e pagar.", tipo: "tarefa", cor: AZUL, icone: "FileText", titulo: "Gerar e enviar o contrato", atalho: "contratos" },
  { especie: "assinatura", grupo: "comercial", rotulo: "Assinado e pago", faz: "Marco: segura o caminho até o contrato estar assinado e pago (5 dias de validade).", tipo: "marco", cor: VERDE, icone: "CheckCircle", titulo: "Contrato assinado e pago" },
  { especie: "grupo", grupo: "comercial", rotulo: "Grupo do WhatsApp", faz: "Tarefa de criar o grupo do cliente com a equipe dele.", tipo: "tarefa", cor: TURQUESA, icone: "UsersThree", titulo: "Criar o grupo do WhatsApp", atalho: "configuracoes" },
  { especie: "formulario", grupo: "comercial", rotulo: "Formulário de acesso", faz: "Tarefa de mandar o formulário de acesso (72 h) e conferir as respostas.", tipo: "tarefa", cor: TURQUESA, icone: "ListChecks", titulo: "Enviar o formulário de acesso" },
  { especie: "ativacao", grupo: "comercial", rotulo: "Ativação", faz: "Tarefa da reunião de Ativação (até 7 dias depois de assinar e pagar).", tipo: "tarefa", cor: AZUL, icone: "Lightning", titulo: "Reunião de Ativação", atalho: "calendario", checklist: ["Roteiros prontos para aprovar", "Acessos das redes ao vivo", "Explicar as gravações", "Revisar estratégia e datas"] },
  { especie: "remarketing", grupo: "comercial", rotulo: "Proposta expirada / recusa", faz: "Tarefa de novo contato: nova proposta ou lista de remarketing.", tipo: "tarefa", cor: VERMELHO, icone: "ArrowsClockwise", titulo: "Novo contato (proposta expirada ou recusa)" },

  // ── Etapas 2 e 3 ──
  { especie: "pautas_ia", grupo: "producao", rotulo: "Pautas do mês (IA)", faz: "A IA lista as pautas; uma pessoa confere.", tipo: "tarefa", cor: ROXO, icone: "Sparkle", titulo: "Pautas do mês", executor: "ia", acaoIa: "ideias" },
  { especie: "roteiro", grupo: "producao", rotulo: "Roteiro", faz: "Tarefa do roteirista (ou da IA, se marcar).", tipo: "tarefa", cor: ROXO, icone: "PencilSimple", titulo: "Roteiros", executor: "humano", acaoIa: "roteiro" },
  { especie: "storyboard", grupo: "producao", rotulo: "Storyboard", faz: "Tarefa do storyboard a partir do roteiro.", tipo: "tarefa", cor: ROXO, icone: "Stack", titulo: "Storyboards" },
  { especie: "gravacao", grupo: "producao", rotulo: "Gravação", faz: "Tarefa da captação, com a lista de cenas e o dia no calendário.", tipo: "tarefa", cor: LARANJA, icone: "VideoCamera", titulo: "Gravação (captação)", atalho: "calendario", checklist: ["Marcar o dia com o cliente", "Levar a lista de cenas", "Conferir bateria e cartões"] },
  { especie: "subir_material", grupo: "producao", rotulo: "Subir material", faz: "Tarefa de subir o bruto para a pasta Captações do cliente no Drive.", tipo: "tarefa", cor: LARANJA, icone: "UploadSimple", titulo: "Subir o material para o Drive", atalho: "drive" },
  { especie: "edicao", grupo: "producao", rotulo: "Edição de vídeo", faz: "Tarefa do editor, já com o atalho da pasta Captações.", tipo: "tarefa", cor: LARANJA, icone: "MonitorPlay", titulo: "Edição dos vídeos", atalho: "drive" },
  { especie: "fotos", grupo: "producao", rotulo: "Fotos / tratamento", faz: "Tarefa do designer com as fotos da captação.", tipo: "tarefa", cor: LARANJA, icone: "ImageSquare", titulo: "Tratamento das fotos", atalho: "drive" },
  { especie: "arte", grupo: "producao", rotulo: "Arte", faz: "Tarefa do designer (depende da identidade visual).", tipo: "tarefa", cor: ROXO, icone: "Palette", titulo: "Artes" },
  { especie: "legenda_ia", grupo: "producao", rotulo: "Legenda (IA)", faz: "A IA escreve a legenda; uma pessoa confere.", tipo: "tarefa", cor: ROXO, icone: "Sparkle", titulo: "Legendas", executor: "ia", acaoIa: "legenda" },
  { especie: "aprovacao", grupo: "producao", rotulo: "Enviar para aprovação", faz: "Tarefa com o botão “Enviar para o cliente aprovar”: conclui quando o cliente aprova em Envios.", tipo: "tarefa", cor: VERDE, icone: "PaperPlaneTilt", titulo: "Enviar para o cliente aprovar", atalho: "envios" },
  { especie: "aviso", grupo: "producao", rotulo: "Aviso ao cliente", faz: "Manda o aviso de texto em Envios e espera o cliente marcar “Ciente”.", tipo: "aviso", cor: TURQUESA, icone: "Megaphone", titulo: "Aviso ao cliente" },
  { especie: "publicacao", grupo: "producao", rotulo: "Publicação", faz: "Cria o post em rascunho no calendário de publicações; conclui quando ele é publicado.", tipo: "publicacao", cor: VERDE, icone: "InstagramLogo", titulo: "Publicação" },

  // ── Redes e anúncios ──
  { especie: "identidade", grupo: "redes", rotulo: "Identidade visual", faz: "Tarefa de padronizar a identidade; libera as artes.", tipo: "tarefa", cor: ROXO, icone: "Palette", titulo: "Identidade visual padronizada" },
  { especie: "perfis", grupo: "redes", rotulo: "Atualizar perfis", faz: "Tarefa com o checklist de cada rede.", tipo: "tarefa", cor: TURQUESA, icone: "Globe", titulo: "Atualização geral das redes", checklist: ["Instagram", "Facebook", "Google (perfil da empresa)", "YouTube", "TikTok"] },
  { especie: "arvore", grupo: "redes", rotulo: "Árvore de links", faz: "Tarefa da árvore de links.", tipo: "tarefa", cor: TURQUESA, icone: "TreeStructure", titulo: "Árvore de links" },
  { especie: "acesso_crm", grupo: "redes", rotulo: "Acesso ao CRM", faz: "Tarefa de criar ou conferir a organização do cliente no CRM.", tipo: "tarefa", cor: TURQUESA, icone: "Buildings", titulo: "Acesso ao CRM para o cliente" },
  { especie: "campanha", grupo: "redes", rotulo: "Campanha de anúncio", faz: "Tarefa do gestor de tráfego com rascunho pela IA (criar no Gerenciador fica com a pessoa).", tipo: "tarefa", cor: AMARELO, icone: "ChartLineUp", titulo: "Campanha (Meta Ads / Google Ads)", acaoIa: "plano_de_campanha" },
  { especie: "relatorio", grupo: "redes", rotulo: "Relatório do mês", faz: "Tarefa do relatório de resultados para o cliente.", tipo: "tarefa", cor: AMARELO, icone: "ChartBar", titulo: "Relatório do mês" },

  // ── Avulsos ──
  { especie: "site", grupo: "avulsos", rotulo: "Site / página", faz: "Tarefa de desenvolvimento com as etapas do site.", tipo: "tarefa", cor: CINZA, icone: "Globe", titulo: "Site", checklist: ["Briefing", "Layout", "Aprovação do cliente", "No ar"] },
  { especie: "automacao", grupo: "avulsos", rotulo: "Automação", faz: "Tarefa de montar a automação (fluxo, WhatsApp) do cliente.", tipo: "tarefa", cor: CINZA, icone: "Lightning", titulo: "Automação" },
  { especie: "assessoria", grupo: "avulsos", rotulo: "Assessoria", faz: "Tarefa ou reunião de assessoria.", tipo: "tarefa", cor: CINZA, icone: "ChatCircle", titulo: "Assessoria", atalho: "calendario" },
  { especie: "tarefa", grupo: "avulsos", rotulo: "Tarefa livre", faz: "Uma tarefa qualquer, para o que não está na paleta.", tipo: "tarefa", cor: AZUL, icone: "ListChecks", titulo: "" },

  // ── Controle ──
  { especie: "marco", grupo: "controle", rotulo: "Marco", faz: "Ponto de controle que uma pessoa conclui (ex.: “material em mãos”).", tipo: "marco", cor: VERDE, icone: "Flag", titulo: "Marco" },
  { especie: "espera", grupo: "controle", rotulo: "Esperar data", faz: "Segura o caminho até o prazo do bloco (ex.: dia 1 do mês de postagem).", tipo: "espera", cor: CINZA, icone: "Clock", titulo: "Esperar até a data" },
  { especie: "nota", grupo: "controle", rotulo: "Nota", faz: "Só texto no mapa, sem efeito.", tipo: "nota", cor: CINZA, icone: "Note", titulo: "Nota" },
];

export const ESPECIES = ESPECIES_DE_BLOCO.map((e) => e.especie);
const POR_ESPECIE = new Map(ESPECIES_DE_BLOCO.map((e) => [e.especie, e]));

export function especieDe(especie: string | null | undefined): EspecieDeBloco {
  return POR_ESPECIE.get(especie ?? "") ?? POR_ESPECIE.get("tarefa")!;
}

/** A nota não entra no caminho: não bloqueia, não libera e não conta no progresso. */
export function contaNoCaminho(tipo: TipoDeBloco): boolean {
  return tipo !== "nota";
}

/** Bloco que só uma pessoa conclui à mão (os outros acompanham tarefa, cliente, post ou data). */
export function concluiAMao(tipo: TipoDeBloco): boolean {
  return tipo === "marco";
}
