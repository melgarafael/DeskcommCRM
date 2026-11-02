/**
 * O ADAPTER DE UMA PORTA SOCIAL — issue #1320.
 *
 * ─── O que ele é, e o que ele NÃO é ─────────────────────────────────────────
 *
 * É a PORTA, no sentido do contrato de `../types.ts`: um `ChannelAdapter` que se
 * monta a partir de (rede, porta, credencial) e que **se recusa a fingir**. Não
 * é um segundo adapter de transporte — quando a porta tem transporte, ele
 * delega; quando não tem, ele diz o que falta.
 *
 * O que ele NÃO faz, nesta fatia: implementar a conexão direta com nenhuma
 * plataforma (não há valor de provider no CHECK do banco — ver `./porta.ts`),
 * nem substituir `socialAdapter`, que continua sendo quem atende a porta
 * intermediada em produção. Nenhum ponto de produção instancia este adapter
 * ainda; ele é a peça que o #965 vai ligar.
 *
 * ─── Por que a recusa é o produto ──────────────────────────────────────────
 *
 * Medido (#3358): quando a conexão social não consegue enviar, o operador lê
 * "O canal recusou o envio. Confira a conexão em Conexões." — frase que não diz
 * QUAL conta está sem o quê, e que já custou um diagnóstico inteiro num envio
 * fora da janela de 24h. A causa mora no adapter, que é quem sabe qual porta e
 * qual exigência; a tela é só o lugar onde ela aparece.
 *
 * Então: `send` sem credencial LANÇA, com a rede e a exigência nomeadas. Nunca
 * devolve `{ externalId: null }` — esse valor colapsa "não tentei" com "tentei e
 * a resposta não trouxe id", e o chamador grava os dois de formas diferentes.
 */
import type { ChannelAdapter, ChannelProvider, OutboundEnvelope, RecipientInput } from "../types";
import { redeSocial, type PortaSocialId } from "./catalog";
import {
  exigenciasEmFalta,
  portaDaRede,
  type CredencialDaPorta,
  type ExigenciaDaPorta,
  type PortaSocial,
} from "./porta";

/**
 * Como cada exigência é DITA para quem lê.
 *
 * A frase descreve o que falta em termos do que a pessoa pode fazer, e não do
 * que o código esperava: "a credencial da conta" é algo que se reconecta; um
 * nome de campo (`token`) não é.
 */
const FRASES_DA_EXIGENCIA: Record<ExigenciaDaPorta, string> = {
  conta_autorizada: "a conta autorizada na plataforma",
  credencial_da_conta: "a credencial da conta (token de acesso)",
};

/** `a` · `a e b` · `a, b e c` — a lista sempre fecha com "e", nunca com vírgula solta. */
function emLista(itens: readonly string[]): string {
  if (itens.length === 1) return itens[0]!;
  return `${itens.slice(0, -1).join(", ")} e ${itens.at(-1)!}`;
}

/** O nome da rede como a tela o escreve — o catálogo é a única fonte. */
function rotuloDaRede(plataforma: string): string {
  return redeSocial(plataforma)?.label ?? plataforma;
}

/**
 * A porta existe no modelo, mas não tem como ser persistida: falta um valor em
 * `channel_sessions.provider` para ela.
 *
 * Isso NÃO é erro de operação — é a lacuna de engenharia que trava a conexão
 * direta, e ela é lançada na MONTAGEM, não no envio: quem tenta montar um
 * adapter de uma porta que não pode existir precisa saber disso antes de ter uma
 * mensagem na mão.
 */
export class PortaSemTransporteError extends Error {
  readonly plataforma: string;
  readonly porta: PortaSocialId;
  readonly motivo: "sem_provider_no_banco" | "sem_transporte_ligado";

  constructor(
    plataforma: string,
    porta: PortaSocial,
    motivo: "sem_provider_no_banco" | "sem_transporte_ligado",
  ) {
    super(
      motivo === "sem_provider_no_banco"
        ? `${rotuloDaRede(plataforma)}: a ${porta.rotulo} ainda não tem valor em ` +
            `channel_sessions.provider, então não há adapter a montar nesta porta.`
        : `${rotuloDaRede(plataforma)}: a ${porta.rotulo} não tem transporte ligado neste ponto do código.`,
    );
    this.name = "PortaSemTransporteError";
    this.plataforma = plataforma;
    this.porta = porta.id;
    this.motivo = motivo;
  }
}

/**
 * A porta está de pé, mas a conexão não tem o que ela exige.
 *
 * A mensagem nomeia a REDE e o que FALTA — nunca o fornecedor, nunca um código
 * de erro cru. É a frase que o operador lê, e é a diferença entre "confira a
 * conexão" e "reconecte a conta: falta o token".
 */
export class PortaSemCredencialError extends Error {
  readonly plataforma: string;
  readonly porta: PortaSocialId;
  readonly falta: readonly ExigenciaDaPorta[];

  constructor(plataforma: string, porta: PortaSocial, falta: readonly ExigenciaDaPorta[]) {
    const oQue = emLista(falta.map((exigencia) => FRASES_DA_EXIGENCIA[exigencia]));
    super(
      `${rotuloDaRede(plataforma)}: falta ${oQue} para enviar pela ${porta.rotulo}. ` +
        `Reconecte a conta em Redes sociais.`,
    );
    this.name = "PortaSemCredencialError";
    this.plataforma = plataforma;
    this.porta = porta.id;
    this.falta = [...falta];
  }
}

export interface OpcoesDoAdaptadorDaPorta {
  /** A rede, na identidade do catálogo (`./catalog.ts`). */
  plataforma: string;
  /** A porta. Ausente = a preferida declarada no catálogo. */
  porta?: PortaSocialId;
  /**
   * O retrato da credencial, lido por QUEM MONTA. `null` = nada conectado.
   *
   * É um valor, e não um leitor, porque `isConfigured` é síncrono e não pode
   * consultar o banco (ver `../adapters/zernio.ts`, que documenta o defeito que
   * essa consulta otimista produziu) — e porque um adapter que busca credencial
   * deixa de ser tradutor de formato.
   */
  credencial: CredencialDaPorta | null;
  /**
   * O transporte que atende esta porta, quando existe. `null` = nenhum ligado
   * neste ponto do código, e o envio recusa dizendo isso.
   */
  transporte?: ChannelAdapter | null;
}

/**
 * Monta o `ChannelAdapter` de UMA rede em UMA porta.
 *
 * Lança na montagem quando a porta não tem valor de provider (ver
 * `PortaSemTransporteError`): sem ele não há `ChannelAdapter`, porque
 * `provider` é obrigatório no contrato — inventar um valor aqui seria o mesmo
 * defeito que esta issue fecha, uma camada abaixo.
 */
export function adaptadorDaPorta({
  plataforma,
  porta,
  credencial,
  transporte = null,
}: OpcoesDoAdaptadorDaPorta): ChannelAdapter {
  const escolhida = portaDaRede(plataforma, porta);
  const provider: ChannelProvider | null = escolhida.providerNoBanco;
  if (!provider) {
    throw new PortaSemTransporteError(plataforma, escolhida, "sem_provider_no_banco");
  }

  return {
    provider,

    /**
     * Códigos NEUTROS, de propósito: `codes` vive no adapter justamente porque
     * carrega nome de fornecedor nos canais existentes (`zernio_error`,
     * `waha_error`). Aqui o código de uma PORTA não pode nomear quem a opera —
     * senão a feature que o grava em `metadata` volta a depender de quem está
     * atrás dela, que é o que a doutrina proíbe.
     */
    codes: {
      notConfigured: "porta_sem_credencial",
      sendFailed: "porta_falhou",
      unknownError: "porta_desconhecida",
    },

    /**
     * Sem transporte não há endereço a resolver: `null` é a resposta do contrato
     * ("não há endereço possível"). Com transporte, quem sabe é ele — o
     * destinatário de uma rede social é a thread que o transporte inventou, e
     * isso não é conhecimento da porta.
     */
    resolveRecipient(input: RecipientInput): string | null {
      if (input.isGroup) return null;
      return transporte ? transporte.resolveRecipient(input) : null;
    },

    /**
     * SEMPRE `true`, e não é descuido: é a mesma decisão — e o mesmo defeito
     * medido — que `../adapters/zernio.ts` documenta.
     *
     * `app/api/v1/messages/_handler.ts` trata `isConfigured() === false` como
     * "deixe em `queued` com `queued_reason`", e **nunca chama `send`**. Para um
     * canal que já foi conectado e perdeu a credencial, isso é a mensagem parada
     * na inbox, sem erro e sem rastro: parece que vai sair e não vai. Quem
     * desiste é `send`, que lança com o motivo — e o handler grava `failed` com
     * a frase.
     *
     * Responder `false` aqui pareceria mais honesto e seria pior: trocaria uma
     * falha visível por uma fila eterna.
     */
    isConfigured(): boolean {
      return true;
    },

    async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
      // A credencial é conferida NO ENVIO porque é o único ponto que pode
      // recusar com a informação completa (rede + porta + o que falta). E ela
      // vem antes do transporte de propósito: uma conexão sem token não deve
      // nem chegar a tocar a rede.
      const falta = exigenciasEmFalta(escolhida, credencial);
      if (falta.length > 0) throw new PortaSemCredencialError(plataforma, escolhida, falta);
      if (!transporte) {
        throw new PortaSemTransporteError(plataforma, escolhida, "sem_transporte_ligado");
      }
      return transporte.send(envelope);
    },
  };
}
