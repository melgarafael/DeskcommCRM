/**
 * Dados de exemplo enquanto a cadência só existe no front.
 *
 * TEMPORÁRIO: quando as tabelas e a API da cadência existirem, a tela passa a
 * ler de lá e este arquivo vira fixture de teste.
 */
import type { CaixaDeEnvio, Cadencia, ConfiguracaoDaCadencia } from "./tipos";

export const CAIXAS_DE_EXEMPLO: CaixaDeEnvio[] = [
  {
    id: "caixa-comercial",
    endereco: "comercial@prospeccao-exemplo.com.br",
    nomeDoRemetente: "Equipe Comercial",
    dono: null,
    limiteDiario: 80,
  },
  {
    id: "caixa-luiz",
    endereco: "luiz@prospeccao-exemplo.com.br",
    nomeDoRemetente: "Luiz",
    dono: "Luiz",
    limiteDiario: 50,
  },
];

export function configuracaoPadrao(): ConfiguracaoDaCadencia {
  return {
    tagDoSegmento: "",
    somenteEmailValidado: true,
    caixaPadraoId: CAIXAS_DE_EXEMPLO[0]?.id ?? null,
    janela: { inicio: "08:00", fim: "18:00", dias: ["seg", "ter", "qua", "qui", "sex"] },
    fuso: "America/Sao_Paulo",
    limiteDiarioPorCaixa: 40,
    paradas: { respondeu: true, bounce: true, descadastro: true, ganhoOuPerdido: true },
  };
}

export function cadenciaDeExemplo(): Cadencia {
  const agora = new Date().toISOString();
  return {
    id: "exemplo-papel-e-celulose",
    nome: "Papel e celulose — primeira abordagem",
    status: "rascunho",
    criadaEm: agora,
    atualizadaEm: agora,
    configuracao: { ...configuracaoPadrao(), tagDoSegmento: "papel-e-celulose" },
    passos: [
      {
        id: "ex-1",
        tipo: "email",
        assunto: "{{primeiro_nome}}, uma ideia para a {{empresa}}",
        corpo:
          "Oi {{primeiro_nome}},\n\nVi que a {{empresa}} atua em papel e celulose e queria entender como vocês organizam hoje o atendimento aos distribuidores.\n\nFaz sentido conversarmos 15 minutos nesta semana?\n\n{{vendedor}}",
        mesmaConversa: false,
      },
      { id: "ex-2", tipo: "espera", diasUteis: 3 },
      {
        id: "ex-3",
        tipo: "ramo",
        condicao: { tipo: "abriu", vezes: 2, dentroDeDias: 3 },
        sim: [
          {
            id: "ex-4",
            tipo: "whatsapp",
            mensagem:
              "Oi {{primeiro_nome}}, aqui é {{vendedor}}. Te mandei um e-mail sobre a {{empresa}} — posso te explicar por aqui em 2 minutos?",
          },
          { id: "ex-5", tipo: "tarefa", titulo: "Ligar para {{primeiro_nome}} ({{empresa}})", prazoDias: 1 },
        ],
        nao: [
          {
            id: "ex-6",
            tipo: "email",
            assunto: "",
            corpo:
              "{{primeiro_nome}}, retomando o e-mail acima — consegue me dizer quem cuida disso na {{empresa}}?\n\n{{vendedor}}",
            mesmaConversa: true,
          },
          { id: "ex-7", tipo: "espera", diasUteis: 4 },
          {
            id: "ex-8",
            tipo: "email",
            assunto: "Encerrando por aqui",
            corpo:
              "{{primeiro_nome}}, não quero lotar sua caixa. Se fizer sentido no futuro, é só responder este e-mail.\n\n{{vendedor}}",
            mesmaConversa: false,
          },
        ],
      },
    ],
  };
}
