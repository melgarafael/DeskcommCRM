/**
 * A ESCOLHA DA CAMADA "DATAS DOS NEGÓCIOS" — leitura, padrão e régua de escrita
 * (#4436, item 1).
 *
 * ─── Onde ela é guardada, e por que AQUI ───────────────────────────────────
 *
 * No `raw_user_meta_data` da PESSOA, sob `camada_datas_dos_negocios` — o mesmo
 * sítio onde o perfil grava idioma e fuso (`app/actions/settings/updateProfile.ts`)
 * e onde `lembretes_de_tarefa` mora (`lib/tarefas/preferencia-de-lembrete.ts`).
 * Três motivos medidos, e cada um elimina uma alternativa:
 *
 *   1. `localStorage` seria por NAVEGADOR. O pedido é que a camada volte como a
 *      pessoa deixou também no outro aparelho — e a largura da coluna do Inbox
 *      (`lib/inbox/larguras-do-inbox.ts`) é o caso oposto, de propósito: lá a
 *      escolha é do monitor, aqui é da pessoa.
 *   2. `organizations.settings` seria por ORGANIZAÇÃO: o colega da mesma empresa
 *      herdaria o funil e o campo de quem escolheu. A configuração pelo
 *      administrador é outro item da #3221, não este.
 *   3. Tabela nova com migration seria mais peso do que a escolha pede: o
 *      metadata já é escrito pela própria pessoa (`auth.updateUser`), lido no
 *      RSC da Agenda e invalidado pelo cache curto de sessão. Sem migration.
 *
 * ─── O insumo é DADO ALHEIO ───────────────────────────────────────────────
 *
 * O que está gravado foi escrito numa sessão antiga, por uma versão anterior do
 * produto, ou aponta para um funil que foi arquivado ontem. `lerEscolhaDaCamada`
 * NUNCA lança e nunca devolve uma escolha que não existe mais: valor torto volta
 * ao padrão DAQUELE campo, e a pessoa escolhe de novo — em vez de a Agenda
 * abrir com erro na cara, ou com a camada pedindo um funil que não está na
 * lista.
 *
 * `ligada` é a única que sobrevive à queda do resto: quem ligou a camada quis
 * vê-la ligada, e desligá-la porque um campo foi renomeado seria perder a
 * intenção da pessoa junto com o dado que sumiu.
 */
import type { FunilComDatas } from "@/lib/agenda/datas-dos-negocios";

/** Onde a escolha mora no `raw_user_meta_data` da pessoa. */
export const CHAVE_DA_CAMADA = "camada_datas_dos_negocios";

export interface EscolhaDaCamada {
  /** A camada aparece na Agenda. */
  ligada: boolean;
  /** O funil das datas, ou `null` quando a lista que o servidor resolveu decide. */
  funilId: string | null;
  /** A chave do campo de data principal. */
  campo: string | null;
  /** A chave do segundo campo de data (o retorno), quando houver. */
  campoFim: string | null;
}

/**
 * O padrão do produto: desligada, sem funil e sem campo.
 *
 * É a decisão de 29/10 da #3221 e continua valendo para quem nunca escolheu:
 * nenhum campo por heurística de nome, e quem não quer a camada não paga por
 * ela — desligada, o componente não busca nada.
 */
export function escolhaPadraoDaCamada(): EscolhaDaCamada {
  return { ligada: false, funilId: null, campo: null, campoFim: null };
}

/**
 * Uma string utilizável, ou `null`: o metadata é `unknown` até prova em
 * contrário. Aparada porque `p-viagens ` e `p-viagens` são o mesmo id para quem
 * lê, e três espaços não podem derrubar a escolha guardada.
 */
function textoOuNulo(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo ? limpo : null;
}

/**
 * Lê a escolha gravada, com tolerância total, contra os funis que a pessoa
 * PODE escolher hoje.
 *
 * `funis` é a lista que o servidor já resolveu para a camada — não arquivados e
 * visíveis pela RLS. É ela que decide o que ainda existe: um funil arquivado
 * simplesmente não está aqui, e por isso a escolha cai no padrão sem precisar
 * de uma segunda consulta.
 */
export function lerEscolhaDaCamada(metadata: unknown, funis: FunilComDatas[]): EscolhaDaCamada {
  const padrao = escolhaPadraoDaCamada();
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return padrao;

  const cru = (metadata as Record<string, unknown>)[CHAVE_DA_CAMADA];
  if (typeof cru !== "object" || cru === null || Array.isArray(cru)) return padrao;
  const gravada = cru as Record<string, unknown>;

  // `ligada` é a INTENÇÃO, e sobrevive ao resto: ver o cabeçalho.
  const ligada = typeof gravada.ligada === "boolean" ? gravada.ligada : padrao.ligada;

  const funilIdGravado = textoOuNulo(gravada.funilId);
  const funil = funilIdGravado ? (funis.find((f) => f.id === funilIdGravado) ?? null) : null;
  if (!funil) return { ligada, funilId: null, campo: null, campoFim: null };

  const campoGravado = textoOuNulo(gravada.campo);
  const campo =
    campoGravado && funil.campos.some((c) => c.key === campoGravado) ? campoGravado : null;

  const campoFimGravado = textoOuNulo(gravada.campoFim);
  const campoFim =
    campo &&
    campoFimGravado &&
    // O "segundo campo" é o OUTRO campo: igual ao primeiro não é segundo, e a
    // consulta o descartaria em silêncio.
    campoFimGravado !== campo &&
    funil.campos.some((c) => c.key === campoFimGravado)
      ? campoFimGravado
      : null;

  return { ligada, funilId: funil.id, campo, campoFim };
}
