/**
 * O contrato da transmissão do provedor — tipos e erro, sem I/O. A explicação
 * inteira está em `./transmissao.ts`; este arquivo existe para a implementação
 * de cada provedor importar o contrato sem importar quem a escolhe.
 */
import type { MetaSendComponent } from "./meta/build-components";

export type EstadoDaTransmissao = "draft" | "scheduled" | "sending" | "completed" | "failed" | "cancelled";

export const ESTADOS_FINAIS_DA_TRANSMISSAO: ReadonlySet<EstadoDaTransmissao> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface DestinatarioDaTransmissao {
  /** Só os dígitos, com o código do país — a chave que casa com o destinatário da campanha. */
  telefone: string;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  /** O id da mensagem na plataforma — o mesmo `external_id` da linha em `messages`. */
  idDaMensagem: string | null;
  codigoDoErro: string | null;
  erro: string | null;
  enviadoEm: string | null;
  entregueEm: string | null;
  lidoEm: string | null;
}

export interface ModeloDaTransmissao {
  name: string;
  language: string;
  /** No formato da plataforma, já com os valores (fixos) escritos. Vazio sem variável. */
  components: MetaSendComponent[];
  /** Os valores das variáveis do CORPO, na ordem de `{{1}}`, `{{2}}`… */
  valoresDoCorpo: string[];
}

export interface EscopoDaTransmissao {
  organizationId: string;
  channelSessionId: string;
}

export interface OpsDeTransmissao {
  criar(entrada: { nome: string; modelo: ModeloDaTransmissao }): Promise<{ id: string }>;
  adicionar(id: string, telefones: string[]): Promise<{ adicionados: number; pulados: number }>;
  enviar(id: string): Promise<{ estado: EstadoDaTransmissao }>;
  ler(id: string): Promise<{ estado: EstadoDaTransmissao }>;
  destinatarios(
    id: string,
    pagina: { pular: number; quantos: number },
  ): Promise<{
    itens: DestinatarioDaTransmissao[];
    temMais: boolean;
    /** Quantos vieram nesta página, legíveis ou não — é o que avança `pular`. */
    lidos: number;
  }>;
  /** Cancela o que ainda não saiu. O que já saiu fica (é o que a plataforma faz). */
  cancelar(id: string): Promise<void>;
}

/**
 * Falha do provedor com o que a campanha precisa para decidir: limite de
 * velocidade (tenta no próximo minuto) ou o resto (pausa com a frase).
 */
export class ErroDaTransmissao extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroDaTransmissao";
  }

  get ehLimiteDeVelocidade(): boolean {
    return this.status === 429;
  }
}

/** Só os dígitos: `+55 11 98765-4321` e `5511987654321` são o mesmo destinatário. */
export function digitosDoTelefone(telefone: string | null | undefined): string {
  return (telefone ?? "").replace(/\D/g, "");
}
