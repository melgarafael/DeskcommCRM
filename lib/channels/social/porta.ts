/**
 * O MODELO NEUTRO DE FORNECEDOR PARA REDES SOCIAIS — issue #1320.
 *
 * ─── O que este arquivo é ───────────────────────────────────────────────────
 *
 * O substantivo que faltava. O catálogo (`./catalog.ts`) declara QUAIS redes
 * existem; aqui se declara por QUAIS PORTAS cada uma é alcançável, o que cada
 * porta EXIGE para ficar de pé, e — a parte que destrava o #965 — se esta porta
 * tem transporte NESTE código.
 *
 * A fronteira que o resto do produto usa são três perguntas, e nenhuma delas
 * pede um nome de fornecedor:
 *
 *   `portasDaRede(rede)`     — por onde esta rede é alcançável?
 *   `portaDisponivel(rede)`  — alguma dessas portas existe hoje? (`null` = não)
 *   `exigenciasEmFalta(porta, credencial)` — o que falta para esta porta subir?
 *
 * É a mesma doutrina que `scripts/lint-channels.ts` aplica a `lib/channels/`
 * (invariante 1 de `docs/doctrine/restricao-de-canal.md`): pergunte uma
 * CAPACIDADE, peça o adapter, ou o identificador da sessão — nunca o provider.
 * Aqui o nome do fornecedor aparece UMA vez, na tabela de portas, que é
 * justamente o lugar onde ele é um DADO (qual valor a coluna recebe) e não uma
 * pergunta.
 *
 * ─── Por que `direta` é declarada sem transporte ────────────────────────────
 *
 * Porque é a VERDADE, e porque a verdade é o que faltava para o #965 andar.
 * Medido: `channel_sessions_provider_check` (`supabase/baseline.sql`) aceita
 * `waha, meta_cloud, zernio, wacalls, zernio_social, datafy` — não existe valor
 * para uma conexão direta com o Instagram. `ChannelAdapter.provider` é
 * `ChannelProvider` e é OBRIGATÓRIO (ver `../types.ts`), então sem valor na
 * coluna não há adapter a montar: não é preguiça, é o contrato.
 *
 * Escrever `implementada: false` e `providerNoBanco: null` faz a lacuna aparecer
 * numa expressão (`portaDisponivel("instagram")`) em vez de num comentário que
 * envelhece. Quem for ligar a conexão direta sabe, pela leitura do modelo, que o
 * primeiro passo é um valor no CHECK — migration, e portanto PR próprio.
 */
import type { ProviderDeMensagem } from "../types";
import { redeSocial, SOCIAL_PROVIDER, type PortaSocialId } from "./catalog";

/**
 * O que uma porta precisa para ficar de pé — em vocabulário NEUTRO.
 *
 * São duas, e são as duas que existem de verdade: a conta autorizada na
 * plataforma (o identificador que o CRM usa para falar em nome dela) e a
 * credencial que autentica essa fala. Não há terceira: janela de 24h, custo por
 * mensagem e risco de banimento são CAPABILITIES (`../capabilities.ts`), não
 * exigências de porta — capability descreve o que a plataforma permite, isto
 * descreve o que a conexão tem.
 */
export type ExigenciaDaPorta = "conta_autorizada" | "credencial_da_conta";

export interface PortaSocial {
  id: PortaSocialId;
  /**
   * Rótulo de TELA. Nunca nomeia fornecedor — é o que uma tela nova mostra no
   * lugar da cópia antiga ("Zernio"), que esta fatia preserva mas não estende.
   */
  rotulo: string;
  /**
   * O valor que esta porta grava em `channel_sessions.provider`, ou `null`
   * quando o CHECK do banco não tem valor para ela. `null` significa "esta porta
   * não pode ser persistida hoje" — e, pelo contrato de `ChannelAdapter`, "não
   * existe adapter a montar".
   */
  providerNoBanco: ProviderDeMensagem | null;
  /** O que a porta exige, na ordem em que a falta deve ser lida. */
  exige: readonly ExigenciaDaPorta[];
  /** Existe transporte para esta porta NESTE código? */
  implementada: boolean;
}

/**
 * A tabela das portas. `Record<PortaSocialId, …>` é de propósito: porta nova no
 * tipo sem linha aqui reprova em compilação, e é o compilador — não a revisão —
 * que cobra a decisão.
 */
export const PORTAS_SOCIAIS: Record<PortaSocialId, PortaSocial> = {
  /**
   * A conexão com a plataforma da própria rede. É a porta que o dono decidiu
   * preferir (o parceiro vira opcional), e a que ainda NÃO existe: ver o
   * cabeçalho. Exige as duas coisas porque a autorização direta é o que dá ao
   * CRM o identificador da conta, e o token é o que ele apresenta depois.
   */
  direta: {
    id: "direta",
    rotulo: "conexão direta",
    providerNoBanco: null,
    exige: ["conta_autorizada", "credencial_da_conta"],
    implementada: false,
  },
  /**
   * A conexão por parceiro homologado. É a que existe hoje, para todas as redes:
   * o CRM apresenta a chave do parceiro, e é ele quem guarda o vínculo com a
   * plataforma. Uma exigência só — quem autoriza a conta na rede é o parceiro,
   * do lado dele.
   */
  intermediada: {
    id: "intermediada",
    rotulo: "conexão por parceiro",
    providerNoBanco: SOCIAL_PROVIDER,
    exige: ["credencial_da_conta"],
    implementada: true,
  },
};

/**
 * O que uma conexão TEM, em vocabulário neutro.
 *
 * É um RETRATO, não um leitor: quem monta leu do banco (assíncrono) e passa o
 * que achou. O adapter não consulta banco — `docs/doctrine/restricao-de-canal.md`
 * só permite que ele traduza formato, e um adapter que lê credencial deixa de
 * ser tradutor e vira decisor.
 */
export interface CredencialDaPorta {
  /** Identificador da CONTA nesta porta — o `sessionRef` da sessão. */
  conta: string | null;
  /** Token/chave que autentica o CRM perante a porta. */
  token: string | null;
}

/**
 * As portas por onde esta rede é alcançável, na ordem de PREFERÊNCIA declarada
 * no catálogo.
 *
 * Lança para rede desconhecida em vez de devolver `[]`: lista vazia é
 * indistinguível de "esta rede não tem porta nenhuma", e as duas levariam o
 * chamador a um caminho mudo. O padrão do repo é falhar fechado e alto
 * (`capabilitiesOf`, `getAdapter`).
 */
export function portasDaRede(plataforma: string): readonly PortaSocial[] {
  const rede = redeSocial(plataforma);
  if (!rede) throw new Error(`rede_social_desconhecida: ${plataforma}`);
  const ids: readonly PortaSocialId[] = rede.portas;
  return ids.map((id) => PORTAS_SOCIAIS[id]);
}

/**
 * A porta pedida — ou a preferida, quando ninguém pede uma.
 *
 * "Preferida" é a PRIMEIRA declarada no catálogo, e pode não estar implementada
 * (é o caso do Instagram). Quem precisa de uma porta que funcione hoje pergunta
 * `portaDisponivel`, não esta.
 */
export function portaDaRede(plataforma: string, porta?: PortaSocialId): PortaSocial {
  const portas = portasDaRede(plataforma);
  if (!porta) return portas[0]!;
  const achada = portas.find((p) => p.id === porta);
  if (!achada) throw new Error(`porta_nao_declarada: ${plataforma}/${porta}`);
  return achada;
}

/**
 * A primeira porta desta rede que EXISTE neste código — `null` quando nenhuma
 * existe.
 *
 * O `null` é a resposta útil, e é a que faltava: é ele que diz, sem comentário
 * nenhum, que a conexão direta de uma rede ainda não pode ser montada. Quem
 * chama decide o que fazer com isso (cair na intermediada, avisar, recusar) —
 * o modelo não decide por ele.
 */
export function portaDisponivel(plataforma: string): PortaSocial | null {
  return portasDaRede(plataforma).find((p) => p.implementada) ?? null;
}

/**
 * O que FALTA nesta porta, com a credencial que se tem. Vazio = a porta tem tudo
 * o que exige.
 *
 * A ordem da resposta é a de `PortaSocial.exige`, não a do objeto de entrada:
 * duas instalações no mesmo estado produzem a mesma frase, na mesma ordem, e a
 * mensagem de erro não vira um teste que passa ou falha conforme a ordem de
 * escrita de um literal.
 *
 * `credencial` `null` é o estado normal de quem nunca conectou: então falta tudo
 * o que a porta exige — nunca "nada falta".
 */
export function exigenciasEmFalta(
  porta: PortaSocial,
  credencial: CredencialDaPorta | null,
): readonly ExigenciaDaPorta[] {
  const tem: Record<ExigenciaDaPorta, boolean> = {
    conta_autorizada: Boolean(credencial?.conta?.trim()),
    credencial_da_conta: Boolean(credencial?.token?.trim()),
  };
  return porta.exige.filter((exigencia) => !tem[exigencia]);
}
