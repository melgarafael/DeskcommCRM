/**
 * O CARTÃO "POR QUE A IA PASSOU PARA VOCÊ" — a decisão, fora do JSX.
 *
 * ═══ O que este módulo é ═══
 *
 * Uma função pura que recebe as linhas de `passagens_de_atendimento` daquela
 * conversa mais QUEM está olhando, e devolve o que a tela desenha: o estado do
 * episódio, as seções que existem, a frase do motivo em português e — o mais
 * importante — QUAL gesto oferecer. Nenhum I/O, nenhum React.
 *
 * ═══ Por que a decisão não mora no componente ═══
 *
 *   1. **Vocabulário de banco é proibido em tela.**
 *      `tests/unit/passagem-motivo-em-portugues.test.ts` varre `app/`,
 *      `components/` e `hooks/` procurando os códigos de `MOTIVOS_DA_PASSAGEM` e
 *      `MOTIVOS_DO_AVISO`. Um `motivo_codigo === "suspected_optout"` dentro do
 *      JSX reprova aquele gate, e ele está certo em reprovar: o código existe
 *      para a constraint recusar lixo, não para alguém ler. Aqui, em `lib/`, a
 *      comparação é legítima — e fica num lugar só.
 *   2. **A matriz é grande.** Sete estados × três posições de quem olha. Medir
 *      isso por render é caro e dá falso vermelho de layout; medir por `expect`
 *      numa função pura é uma linha por caso.
 *
 * ═══ O gesto: a decisão que mais custa se sair errada ═══
 *
 * Três armadilhas, todas com custo real:
 *
 *   · **Opt-out.** Um cartão que convida a "assumir e responder" empurra alguém
 *     a escrever para quem acabou de pedir para parar de receber mensagens. Por
 *     isso `suspected_optout` NUNCA oferece o convite de responder, em nenhuma
 *     combinação de dono — o gesto vira conferir o bloqueio na ficha.
 *   · **Conversa que já tem dono.** "Assumir e responder" ali oferece um gesto
 *     que a rota recusa. O cartão passa a dizer quem atende; o gesto que existe
 *     (transferir) mora no cabeçalho, e apontar para ele é mais honesto que
 *     duplicá-lo.
 *   · **Episódio fechado.** Passagem reconhecida (ou devolvida ao automático) é
 *     história: ela informa e não pede nada.
 *
 * ═══ O que este módulo NÃO decide ═══
 *
 * Como aquilo vira pixels. Isso é de `components/inbox/PassagemCard.tsx`, e a
 * prova de que a tela mostra o que a função decidiu é a prova em tela (DoD 12).
 */
import {
  FRASE_DO_MOTIVO,
  FRASE_DO_MOTIVO_DO_AVISO,
  MOTIVO_PERCEBIDO_PELO_JEV,
  PISO_DO_BRIEFING,
  tentativaDaPassagemSchema,
  type MotivoDaPassagem,
  type MotivoDoAviso,
  type OrigemDaPassagem,
  type TentativaDaPassagem,
} from "./passagem";
import { ROTULO_DE_ANONIMIZADO } from "./texto-do-aviso";

/** A linha como a rota da conversa a devolve. As chaves são as colunas. */
export interface PassagemDaConversa {
  id: string;
  origem: OrigemDaPassagem;
  motivo_codigo: MotivoDaPassagem;
  title: string | null;
  body: string;
  notes: string | null;
  content: string | null;
  tentativas: unknown;
  cliente_avisado: boolean | null;
  aviso_motivo_codigo: MotivoDoAviso | null;
  caso_id: string | null;
  criado_em: string;
  reconhecido_em: string | null;
  reconhecido_por: string | null;
  /** Resolvido pelo servidor. `null` é estado DECLARADO (self-host sem service role). */
  reconhecido_por_nome?: string | null;
}

/** Quem abriu a conversa, e com quem ela está. */
export interface QuemOlha {
  usuarioId: string;
  /** `conversations.assigned_to_user_id` — a VERDADE sobre haver dono. */
  donoId: string | null;
  /** `conversations.assigned_to_user_name` — cortesia, pode ser `null`. */
  donoNome: string | null;
}

/**
 * O gesto que o cartão oferece. União discriminada de propósito: cada braço
 * carrega o que a tela precisa para desenhá-lo, e acrescentar um novo obriga o
 * componente a tratá-lo.
 */
export type AcaoDoCartao =
  | { tipo: "assumir_e_responder" }
  | { tipo: "abrir_contato" }
  | { tipo: "avisa_quem_atende"; donoNome: string | null }
  | { tipo: "nenhuma" };

export interface CartaoDaPassagem {
  id: string;
  /** ISO-8601. A tela formata; o módulo não sabe de fuso nem de idioma. */
  criadoEm: string;
  estado: "aberta" | "reconhecida" | "devolvida";
  /** `true` quando a cascata de LGPD já passou por aqui. */
  anonimizada: boolean;
  /** `true` quando a passagem nasceu de suspeita de pedido de descadastro. */
  optOut: boolean;
  /** Recolhido no fio: as passagens anteriores à mais recente. */
  recolhido: boolean;
  /** Em português. A tela passa por `t()`; o código do banco não chega lá. */
  titulo: string;
  motivo: string;
  /**
   * Quem percebeu a irritação foi o Jev (D11): a tela acrescenta "(percebido
   * pelo Jev)" ao motivo. Só na tela da equipe — nunca na mensagem ao cliente.
   */
  percebidoPeloJev: boolean;
  /** `title` — o que a IA entendeu que o cliente quer. */
  clienteQuer: string | null;
  /** `body` — a narrativa. `null` quando é o piso (a seção some). */
  resumo: string | null;
  /** `true` quando a montagem não recebeu contexto nenhum. */
  semContexto: boolean;
  /** `notes` — as palavras LITERAIS do cliente. Citação, nunca conclusão. */
  falaDoCliente: string | null;
  /** `content` — o texto livre de quem passou (modelo, MCP, pessoa do caso). */
  textoDeQuemPassou: string | null;
  tentativas: TentativaDaPassagem[];
  /** `null` = ninguém TENTOU avisar, que é diferente de tentou e não conseguiu. */
  aviso: { avisado: boolean; frase: string | null } | null;
  /** Quem assumiu, quando o servidor resolveu o nome. */
  assumidaPor: string | null;
  acao: AcaoDoCartao;
}

/** Texto em branco vira ausência: uma seção com corpo vazio afirma que o dado é nada. */
function texto(valor: string | null | undefined): string | null {
  const limpo = (valor ?? "").trim();
  return limpo === "" ? null : limpo;
}

/**
 * As tentativas, item a item, DESCARTANDO o que não casa com o schema.
 *
 * `tentativas` é `jsonb` gravado a partir do que o modelo (ou um agente MCP
 * externo) escreveu, e o CHECK do banco garante só que é um array. Um
 * `parse` do array inteiro derrubaria o cartão por causa de um item torto — e o
 * motivo e a fala do cliente, que é o que a pessoa precisa ler, iriam junto.
 * Falhar fechado na AÇÃO, aberto na INFORMAÇÃO.
 */
function tentativasLegiveis(cru: unknown): TentativaDaPassagem[] {
  if (!Array.isArray(cru)) return [];
  const boas: TentativaDaPassagem[] = [];
  for (const item of cru) {
    const r = tentativaDaPassagemSchema.safeParse(item);
    if (r.success) boas.push(r.data);
  }
  return boas;
}

function estadoDe(p: PassagemDaConversa): CartaoDaPassagem["estado"] {
  if (p.reconhecido_em === null) return "aberta";
  return p.reconhecido_por === null ? "devolvida" : "reconhecida";
}

/**
 * A cascata de LGPD grava o rótulo em `body`, que é a coluna `not null` e a
 * única que ela garante ter reescrito. Um clone antigo pode ter sobra nas
 * outras — e sobra não pode ressuscitar na tela de quem atende.
 */
function foiAnonimizada(p: PassagemDaConversa): boolean {
  return p.body.trimStart().startsWith(ROTULO_DE_ANONIMIZADO);
}

function acaoDe(input: {
  estado: CartaoDaPassagem["estado"];
  anonimizada: boolean;
  optOut: boolean;
  ultima: boolean;
  quem: QuemOlha;
}): AcaoDoCartao {
  const { estado, anonimizada, optOut, ultima, quem } = input;
  // Episódio fechado, contato esquecido ou cartão recolhido: o cartão informa e
  // não pede nada. Três convites na mesma conversa são um convite só.
  if (anonimizada || estado !== "aberta" || !ultima) return { tipo: "nenhuma" };
  if (optOut) return { tipo: "abrir_contato" };
  if (quem.donoId === null) return { tipo: "assumir_e_responder" };
  if (quem.donoId === quem.usuarioId) return { tipo: "nenhuma" };
  return { tipo: "avisa_quem_atende", donoNome: quem.donoNome };
}

const TITULO_PADRAO = "Por que a IA passou para você";
const TITULO_OPT_OUT = "O cliente pode ter pedido para parar de receber mensagens";

/**
 * Monta os cartões de UMA conversa, em ordem cronológica.
 *
 * A ordenação é feita aqui e não confiada à rota: o cartão entra no fio da
 * conversa, que é cronológico, e um cartão fora de ordem diria que a IA passou a
 * conversa depois de já ter passado.
 */
export function montarCartoesDaPassagem(
  passagens: readonly PassagemDaConversa[],
  quem: QuemOlha,
): CartaoDaPassagem[] {
  const ordenadas = [...passagens].sort(
    (a, b) => new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime(),
  );

  return ordenadas.map((p, i) => {
    const ultima = i === ordenadas.length - 1;
    const anonimizada = foiAnonimizada(p);
    const optOut = p.motivo_codigo === "suspected_optout";
    const estado = estadoDe(p);
    const corpo = texto(p.body);
    const semContexto = anonimizada || corpo === null || corpo === PISO_DO_BRIEFING.trim();

    return {
      id: p.id,
      criadoEm: p.criado_em,
      estado,
      anonimizada,
      optOut,
      recolhido: !ultima,
      titulo: optOut ? TITULO_OPT_OUT : TITULO_PADRAO,
      motivo: FRASE_DO_MOTIVO[p.motivo_codigo],
      // O motivo aparece em destaque, e o resumo embaixo é que dizia quem
      // percebeu: a atribuição ficava longe da frase que ela qualifica.
      percebidoPeloJev:
        !anonimizada && p.motivo_codigo === "low_sentiment" && p.body.includes(MOTIVO_PERCEBIDO_PELO_JEV),
      clienteQuer: anonimizada ? null : texto(p.title),
      resumo: semContexto ? null : corpo,
      semContexto,
      falaDoCliente: anonimizada ? null : texto(p.notes),
      textoDeQuemPassou: anonimizada ? null : texto(p.content),
      tentativas: anonimizada ? [] : tentativasLegiveis(p.tentativas),
      aviso:
        anonimizada || p.cliente_avisado === null
          ? null
          : {
              avisado: p.cliente_avisado,
              frase: p.cliente_avisado
                ? null
                : p.aviso_motivo_codigo === null
                  ? null
                  : FRASE_DO_MOTIVO_DO_AVISO[p.aviso_motivo_codigo],
            },
      assumidaPor: estado === "reconhecida" ? (p.reconhecido_por_nome ?? null) : null,
      acao: acaoDe({ estado, anonimizada, optOut, ultima, quem }),
    };
  });
}
