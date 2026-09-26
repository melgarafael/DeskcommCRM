/**
 * Cadência de e-mail por segmento — o formato que o construtor edita.
 *
 * É o contrato entre a tela e o backend: a tela grava exatamente isto (validado
 * por `schemas.ts`), e o worker da cadência lê exatamente isto. Por isso mora em
 * `lib/` e não dentro do componente.
 *
 * Os passos formam uma ÁRVORE, não um grafo: um ramo se abre em "sim" e "não"
 * e cada lado segue sozinho até o fim, como no construtor da HubSpot. Sem setas
 * soltas para desenhar, não há como montar um fluxo com laço ou nó órfão.
 */

import type { STATUS_DA_CADENCIA } from "./vocabulario";

export type StatusDaCadencia = (typeof STATUS_DA_CADENCIA)[number];

export interface PassoEmail {
  id: string;
  tipo: "email";
  assunto: string;
  corpo: string;
  /** Envia como resposta na mesma conversa do e-mail anterior ("Re: ..."). */
  mesmaConversa: boolean;
}

export interface PassoEspera {
  id: string;
  tipo: "espera";
  /** Contados em dias úteis — sábado, domingo e feriado não andam o relógio. */
  diasUteis: number;
}

export type CondicaoDoRamo =
  | { tipo: "abriu"; vezes: number; dentroDeDias: number }
  | { tipo: "clicou"; dentroDeDias: number }
  | { tipo: "respondeu"; dentroDeDias: number };

export interface PassoRamo {
  id: string;
  tipo: "ramo";
  condicao: CondicaoDoRamo;
  sim: Passo[];
  nao: Passo[];
}

export interface PassoWhatsapp {
  id: string;
  tipo: "whatsapp";
  mensagem: string;
}

export interface PassoTarefa {
  id: string;
  tipo: "tarefa";
  titulo: string;
  /** Prazo da tarefa, em dias úteis a partir do momento em que o passo roda. */
  prazoDias: number;
}

export type Passo = PassoEmail | PassoEspera | PassoRamo | PassoWhatsapp | PassoTarefa;
export type TipoDePasso = Passo["tipo"];

export type DiaDaSemana = "seg" | "ter" | "qua" | "qui" | "sex" | "sab" | "dom";

export interface ConfiguracaoDaCadencia {
  /** Tag de segmento que inscreve o lead (ex.: "papel-e-celulose"). */
  tagDoSegmento: string;
  /** Só lead com o e-mail marcado como validado pelo Treg entra. */
  somenteEmailValidado: boolean;
  /** Caixa usada quando o lead não tem dono (ou o dono não conectou caixa). */
  caixaPadraoId: string | null;
  janela: { inicio: string; fim: string; dias: DiaDaSemana[] };
  fuso: string;
  /** Teto de envios desta cadência por caixa, por dia. */
  limiteDiarioPorCaixa: number;
  paradas: {
    respondeu: boolean;
    bounce: boolean;
    descadastro: boolean;
    ganhoOuPerdido: boolean;
  };
}

export interface Cadencia {
  id: string;
  nome: string;
  status: StatusDaCadencia;
  configuracao: ConfiguracaoDaCadencia;
  passos: Passo[];
  criadaEm: string;
  atualizadaEm: string;
}

/** Caixa de envio conectada por SMTP+IMAP (a conexão real vem com o backend). */
export interface CaixaDeEnvio {
  id: string;
  endereco: string;
  nomeDoRemetente: string;
  dono: string | null;
  limiteDiario: number;
}
