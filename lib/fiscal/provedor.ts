/**
 * O PROVEDOR FISCAL — a fronteira entre o pedido e a SEFAZ.
 *
 * Hoje existe UM provedor: o stub. Ele registra a intenção de emitir e
 * devolve `pendente` — e NUNCA `autorizada`, `chave_acesso` ou `xml`.
 * Autorização exige certificado digital + SEFAZ ou API emissora
 * (Focus/Webmania), que esta instalação não tem. Fingir autorização sem
 * emissor seria o defeito mais caro deste módulo: nota que "existe" no
 * sistema e não existe no fisco.
 *
 * Quando o emissor real chegar, ele implementa `ProvedorFiscal` e o
 * `resolverProvedor` o escolhe pelo `fiscal_settings.provedor`. O stub
 * continua existindo como o estado honesto de "sem emissor".
 */

export type StatusDeNota = "pendente" | "autorizada" | "denegada" | "cancelada" | "erro";

export interface PedidoParaNota {
  order_id: string;
  numero: number;
  cliente_nome: string;
  cliente_documento: string | null;
  total_cents: number;
}

export interface ResultadoDeEmissao {
  status: StatusDeNota;
  /** Motivo legível quando `erro`/`denegada` — a tela mostra sem traduzir código. */
  erro: string | null;
  numero: number | null;
  chave_acesso: string | null;
  xml: string | null;
  protocolo?: string | null;
  sefaz_cstat?: string | null;
  sefaz_xmotivo?: string | null;
}

export interface ProvedorFiscal {
  readonly nome: string;
  emitir(pedido: PedidoParaNota): Promise<ResultadoDeEmissao>;
}

/**
 * O stub: sem certificado, sem SEFAZ, sem API emissora, sem autorização.
 * O que ele FAZ é registrar a intenção (a rota grava `pendente`) e dizer
 * exatamente o que falta — para o dono saber o próximo passo em vez de
 * achar que a nota "foi".
 */
export const provedorStub: ProvedorFiscal = {
  nome: "stub",
  async emitir(_pedido: PedidoParaNota): Promise<ResultadoDeEmissao> {
    return {
      status: "pendente",
      erro: null,
      numero: null,
      chave_acesso: null,
      xml: null,
    };
  },
};

/** Mensagem que a tela mostra junto de toda nota pendente do stub. */
export const FALTA_EMISSOR =
  "Sem emissor fiscal configurado — suba o sidecar sped-nfe (fiscal/sidecar/) e escolha o provedor na configuração. A nota está registrada como pendente.";

export type ProvedorEscolhido = "stub" | "spednfe";

/**
 * Stub é o default honesto: só sai dele com provedor `spednfe` NA CONFIG e
 * sidecar alcançável (URL + secret no env). Config sem sidecar, ou sidecar
 * sem config, cai no stub — nunca em tentativa de emissão pela metade.
 */
export function resolverProvedor(config: { provedor?: string | null }): ProvedorEscolhido {
  if (config.provedor !== "spednfe") return "stub";
  const base = process.env.FISCAL_SIDECAR_URL?.trim();
  const segredo = process.env.FISCAL_SIDECAR_SECRET?.trim();
  if (!base || !segredo) return "stub";
  return "spednfe";
}
