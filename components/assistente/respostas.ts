/**
 * Base de respostas AUTOMÁTICAS do chat de ajuda — 100% local, sem rede.
 *
 * De propósito não chama IA nem API: o chat precisa funcionar no self-host
 * sem chave configurada e sem custo por mensagem. Cada entrada aponta para
 * rotas REAIS de `/app/*` (conferidas contra `app/app/`); se a rota não
 * existe, o link não entra aqui.
 */

export interface LinkDeAjuda {
  rotulo: string;
  href: string;
}

export interface RespostaDeAjuda {
  texto: string;
  links: LinkDeAjuda[];
}

interface Entrada {
  id: string;
  palavras: string[];
  resposta: RespostaDeAjuda;
}

const ENTRADAS: Entrada[] = [
  {
    id: "atalhos",
    palavras: ["atalho", "teclado", "tecla", "shortcut", "j", "k", "navegar"],
    resposta: {
      texto:
        "Na caixa de entrada: j/k trocam de conversa, a assume, e fecha, r foca a resposta, Enter envia e Shift+Enter quebra linha. O ? abre a lista completa.",
      links: [{ rotulo: "Abrir caixa de entrada", href: "/app/inbox" }],
    },
  },
  {
    id: "inbox",
    palavras: ["inbox", "conversa", "mensagem", "whatsapp", "responder", "assumir", "fila"],
    resposta: {
      texto:
        "A caixa de entrada reúne as conversas do WhatsApp. Você filtra por aba, assume a conversa com o botão Assumir e responde no composer embaixo. Mensagens do agente ficam marcadas como automáticas.",
      links: [
        { rotulo: "Abrir caixa de entrada", href: "/app/inbox" },
        { rotulo: "Ver conexões", href: "/app/connections" },
      ],
    },
  },
  {
    id: "conexao",
    palavras: ["conexão", "conexao", "conectar", "desconect", "caiu", "qrcode", "qr", "canal"],
    resposta: {
      texto:
        "Se as mensagens pararam de chegar, confira a página de conexões: canal desconectado mostra aviso no topo do painel. Reconecte por lá e aguarde o status ficar ativo antes de testar.",
      links: [{ rotulo: "Ver conexões", href: "/app/connections" }],
    },
  },
  {
    id: "kanban",
    palavras: ["kanban", "funil", "pipeline", "etapa", "negócio", "negocio", "arrastar", "ganho", "perdido"],
    resposta: {
      texto:
        "O funil mostra os leads por etapa. Arraste o cartão para mover, clique para ver o detalhe e registre o motivo ao marcar como perdido — isso alimenta os relatórios.",
      links: [
        { rotulo: "Abrir funil", href: "/app/kanban" },
        { rotulo: "Ver leads", href: "/app/leads" },
      ],
    },
  },
  {
    id: "leads",
    palavras: ["lead", "contato", "cliente", "importar", "planilha", "cadastrar"],
    resposta: {
      texto:
        "Leads moram no funil e na lista de contatos. Você pode criar à mão, importar por arquivo no funil e acompanhar cada um na página de contatos.",
      links: [
        { rotulo: "Ver leads", href: "/app/leads" },
        { rotulo: "Ver contatos", href: "/app/contacts" },
        { rotulo: "Abrir funil", href: "/app/kanban" },
      ],
    },
  },
  {
    id: "agenda",
    palavras: ["agenda", "compromisso", "reunião", "reuniao", "agendar", "horário", "horario", "calendário", "calendario"],
    resposta: {
      texto:
        "A agenda mostra os compromissos da semana. Para agendar, abra um lead e crie o compromisso por lá — ele já nasce vinculado ao contato certo.",
      links: [{ rotulo: "Abrir agenda", href: "/app/agenda" }],
    },
  },
  {
    id: "agente-ia",
    palavras: ["agente", "ia", "robô", "robo", "automático", "automatico", "resposta automática", "inteligência"],
    resposta: {
      texto:
        "Os agentes de IA atendem no WhatsApp e passam para o humano o que importa. Você cria e ajusta o comportamento na página de agentes e acompanha os casos que pediram ajuda.",
      links: [
        { rotulo: "Ver agentes", href: "/app/ai/agents" },
        { rotulo: "Casos que pediram ajuda", href: "/app/ai/cases" },
        { rotulo: "Base de conhecimento", href: "/app/ai/knowledge" },
      ],
    },
  },
  {
    id: "followup",
    palavras: ["follow", "followup", "follow-up", "recuperação", "recuperacao", "carrinho", "reengajar"],
    resposta: {
      texto:
        "Os follow-ups reengajam conversas paradas com regras automáticas. Confira a fila para ver o que está agendado e o histórico do que já foi enviado.",
      links: [{ rotulo: "Ver follow-ups", href: "/app/ai/followups" }],
    },
  },
  {
    id: "relatorios",
    palavras: ["relatório", "relatorio", "métrica", "metrica", "dashboard", "resultado", "desempenho", "indicador"],
    resposta: {
      texto:
        "Os números ficam em Relatórios e Indicadores: volume de atendimento, conversão do funil e evolução dos agentes de IA.",
      links: [
        { rotulo: "Ver relatórios", href: "/app/relatorios" },
        { rotulo: "Ver indicadores", href: "/app/indicadores" },
        { rotulo: "Evolução da IA", href: "/app/ai/evolution" },
      ],
    },
  },
  {
    id: "equipe",
    palavras: ["equipe", "usuário", "usuario", "convidar", "membro", "papel", "permissão", "permissao", "atendente"],
    resposta: {
      texto:
        "Convide a equipe em Equipe → Convidar e acompanhe quem está atendendo. Papéis controlam o que cada pessoa pode ver e fazer.",
      links: [{ rotulo: "Ver equipe", href: "/app/team" }],
    },
  },
  {
    id: "config",
    palavras: ["config", "ajuste", "perfil", "notificação", "notificacao", "marca", "logo", "cor", "assinatura"],
    resposta: {
      texto:
        "Ajustes pessoais ficam em Perfil e os da empresa em Configurações (marca, canais, segurança). Notificações do navegador também se ajustam por lá.",
      links: [
        { rotulo: "Meu perfil", href: "/app/settings/profile" },
        { rotulo: "Configurações", href: "/app/settings" },
      ],
    },
  },
  {
    id: "lgpd",
    palavras: ["lgpd", "privacidade", "dados", "titular", "exportar", "eliminar", "consentimento"],
    resposta: {
      texto:
        "Pedidos de titulares (acesso, correção, eliminação) ficam na área de LGPD, com prazo e trilha de auditoria. Registre por lá assim que o pedido chegar.",
      links: [{ rotulo: "Pedidos LGPD", href: "/app/lgpd/requests" }],
    },
  },
  {
    id: "tarefas",
    palavras: ["tarefa", "lembrete", "todo", "pendência", "pendencia", "afazer"],
    resposta: {
      texto:
        "Tarefas são os lembretes do time: crie com responsável e prazo e acompanhe tudo na lista de tarefas.",
      links: [{ rotulo: "Ver tarefas", href: "/app/tarefas" }],
    },
  },
];

const RESPOSTA_PADRAO: RespostaDeAjuda = {
  texto:
    "Posso ajudar com caixa de entrada, funil, agenda, agentes de IA, conexões do WhatsApp, relatórios, equipe e configurações. Tente perguntar, por exemplo: “como assumo uma conversa?” ou “o WhatsApp desconectou, e agora?”.",
  links: [
    { rotulo: "Caixa de entrada", href: "/app/inbox" },
    { rotulo: "Funil", href: "/app/kanban" },
    { rotulo: "Agentes de IA", href: "/app/ai/agents" },
  ],
};

const SAUDACOES = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "hey", "ajuda", "help", "socorro"];

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Escolhe a melhor entrada por contagem de palavras-chave; empate = primeira. */
export function responder(pergunta: string): RespostaDeAjuda {
  const texto = normalizar(pergunta.trim());
  if (!texto) return RESPOSTA_PADRAO;
  if (SAUDACOES.some((s) => texto === s || texto.startsWith(`${s} `) || texto.startsWith(`${s}!`))) {
    return {
      texto: `Olá! ${RESPOSTA_PADRAO.texto}`,
      links: RESPOSTA_PADRAO.links,
    };
  }
  let melhor: Entrada | null = null;
  let melhorPontos = 0;
  for (const entrada of ENTRADAS) {
    let pontos = 0;
    for (const p of entrada.palavras) {
      if (texto.includes(normalizar(p))) pontos += 1;
    }
    if (pontos > melhorPontos) {
      melhorPontos = pontos;
      melhor = entrada;
    }
  }
  return melhor ? melhor.resposta : RESPOSTA_PADRAO;
}

export const SUGESTOES_INICIAIS: string[] = [
  "Como assumo uma conversa?",
  "O WhatsApp desconectou, e agora?",
  "Como funciona o funil?",
  "Como configuro o agente de IA?",
];
