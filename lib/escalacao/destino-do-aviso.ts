/**
 * O DESTINO DO AVISO DE CASO E DE PROPOSTA — para QUEM vai a mensagem (#3803).
 *
 * ─── O problema ────────────────────────────────────────────────────────────
 *
 * `config_aviso_de_caso` guardava UM número por organização, e é para ele que
 * vão o aviso de caso e o de proposta. Numa agência com carteira por vendedor,
 * quem precisa agir é o responsável pela conversa — o vendedor que fez a venda
 * e dá o pós-venda —, e o dono da empresa vira um repassador manual justamente
 * no caso em que o cliente pediu uma pessoa.
 *
 * ─── O desenho: um modo, uma cadeia, uma função ────────────────────────────
 *
 * A configuração passa a distinguir duas formas de destino:
 *
 *   `destino_modo = 'fixo'`        o número da empresa, como sempre. É o
 *                                 `default` da coluna: nenhuma instalação é
 *                                 migrada para o modo novo sem alguém escolher.
 *   `destino_modo = 'responsavel'` a cadeia resolvida NO MOMENTO DO ENVIO:
 *                                 responsável da conversa → do negócio aberto
 *                                 → dono da carteira do contato → e, quando
 *                                 nenhum serve, o número da empresa.
 *
 * A regra "quem é o responsável" NÃO mora aqui: é `resolverDestinoDoAtribuir`
 * (`lib/automation/destino-do-atribuir`, #3804), a mesma da ação de atribuir.
 * Este módulo faz duas coisas que ela não faz — monta a cadeia do aviso e
 * traduz o `user_id` escolhido no TELEFONE do perfil do membro — e uma que ela
 * não pode fazer: decidir o que acontece quando o elo é uma pessoa sem número
 * (a regra de atribuir não tem telefone nenhum; ali o elo vale sempre).
 *
 * ─── O telefone faltando é um DESCARTE, e é nomeado ────────────────────────
 *
 * Quem não preencheu o próprio WhatsApp no perfil cai para o próximo elo — e a
 * decisão fica registrada como `sem_telefone`, não como "não tinha
 * responsável". A diferença é a única coisa que permite responder depois "por
 * que este aviso foi para o número da empresa com o vendedor certo na conversa?".
 *
 * A mecânica é a do próprio `resolverDestinoDoAtribuir`: ele recebe `recusados`,
 * os ids que quem chama já vetou, e pula esses elos registrando `recusado`.
 * Aqui os ids sem telefone entram nessa lista ANTES da chamada — a cadeia é
 * percorrida uma vez, pela função única, e o motivo é reescrito no fim para o
 * vocabulário do aviso.
 *
 * ─── O número nunca fica vazio ─────────────────────────────────────────────
 *
 * `telefone_destino` é `not null` com CHECK E.164 (migration 0292) e continua
 * sendo o ÚLTIMO elo da cadeia. Há dois jeitos de a resolução devolver `null`:
 * a configuração existir sem número — o que o banco não permite — e a cadeia
 * parar em alguém marcado com "Não enviar aviso de caso" (#4989, abaixo),
 * que é de propósito e tem origem própria (`nao_avisar`). Ainda assim o
 * tipo diz `string | null`, porque o chamador precisa tratar esse caso em vez
 * de mandar uma mensagem para `""` e receber um erro do transporte.
 *
 * ─── "Não enviar aviso de caso": a cadeia PARA (#4989) ─────────────────────
 *
 * "Sem número" pula para o próximo elo; "não enviar aviso de caso" é outra
 * coisa: a pessoa existe, é a vez dela, e ela (ou a fila que ela representa)
 * não deve gerar aviso. Quem está marcado NÃO entra nos vetados por telefone —
 * então a cadeia escolhe essa pessoa como escolheria qualquer outra, e é aqui,
 * depois, que a escolha vira `origem: "nao_avisar"`, `telefone: null` e um
 * descarte `nao_avisar` com o elo. Sem número da empresa: o caso continua no
 * painel, só não sai WhatsApp. A marca vale mesmo para quem não tem número
 * (não vira `sem_telefone`), e alcança também o elo seguinte a quem foi pulado
 * por falta de número: a cadeia anda até a primeira pessoa que serve, e se
 * essa pessoa está marcada, para ali.
 *
 * `naoAvisar` é opcional e só o aviso de CASO o passa (a issue não fala do
 * aviso de proposta, que usa a mesma cadeia). Ausente = o comportamento de
 * antes, byte a byte.
 *
 * ─── Fora de escopo (declarado na issue) ───────────────────────────────────
 *
 * Mandar para o responsável E para o número da empresa ao mesmo tempo (o
 * opcional 3 da issue): o desenho é UM destino por configuração. E os outros
 * canais de aviso, que não passam por aqui.
 */
import {
  resolverDestinoDoAtribuir,
  type CandidatoDoDestino,
  type ContatoDoDestino,
  type ConversaDoDestino,
  type Descarte as DescarteDaCadeia,
  type EloDoDestino,
  type NegocioDoDestino,
} from "@/lib/automation/destino-do-atribuir";

/** As duas formas de destino que a configuração aceita. */
export const MODOS_DO_DESTINO = ["fixo", "responsavel"] as const;
export type ModoDoDestinoDoAviso = (typeof MODOS_DO_DESTINO)[number];

/**
 * A ordem da cadeia do aviso. É constante e não campo de configuração: a issue
 * define esta ordem, e deixá-la editável produziria instalações em que o dono
 * da carteira recebe antes de quem está com a conversa — o inverso do pedido.
 */
export const CADEIA_DO_AVISO: readonly CandidatoDoDestino[] = [
  "responsavel_da_conversa",
  "responsavel_do_negocio",
  "dono_da_carteira",
];

/** Os elos possíveis, na voz do aviso (inclui o desfecho). */
export type EloDoAviso = CandidatoDoDestino | "numero_da_empresa";

/**
 * Por que um elo foi tentado e não serviu. `nao_avisar` é o elo em que a
 * cadeia PAROU por causa da marca (#4989) — não um "pulou para o próximo".
 */
export type MotivoDoDescarteDoAviso = "ausente" | "id_invalido" | "sem_telefone" | "recusado" | "nao_avisar";

export type DescarteDoAviso = { elo: EloDoAviso; motivo: MotivoDoDescarteDoAviso };

export type DestinoDoAviso = {
  /** O número que recebe. `null` só quando a configuração não tem número. */
  telefone: string | null;
  /**
   * Qual elo decidiu. `sem_destino` = nem o número da empresa pôde ser lido.
   * `nao_avisar` = a cadeia chegou em alguém marcado com "Não enviar aviso de
   * caso" (#4989): `telefone` é `null` e nada deve sair.
   */
  origem: EloDoAviso | "sem_destino" | "nao_avisar";
  /** Quem recebe, quando o destino é uma pessoa da equipe. */
  user_id: string | null;
  /** Os elos tentados antes, com o motivo de cada um. */
  descartes: DescarteDoAviso[];
};

/** A configuração, reduzida ao que a decisão precisa (a linha pode ser antiga). */
export type ConfigDoDestinoDoAviso = Record<string, unknown> | null | undefined;

/**
 * O modo gravado, com `fixo` como resposta para tudo que não é `responsavel`.
 *
 * Linha antiga (sem a coluna), `null`, string torta e valor de uma versão
 * futura caem em `fixo` — o comportamento que a instalação já tinha. Escolher
 * `responsavel` é sempre um ato explícito de alguém na tela.
 */
export function modoDoDestinoDoAviso(config: ConfigDoDestinoDoAviso): ModoDoDestinoDoAviso {
  if (!config || typeof config !== "object") return "fixo";
  return config.destino_modo === "responsavel" ? "responsavel" : "fixo";
}

/** Texto não vazio, ou `null` — o banco devolve nulo, `""` e ausente. */
function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/**
 * Os ids que a cadeia pode tentar, na ordem, a partir das três linhas.
 *
 * Serve a um propósito só: pedir o telefone de todos eles numa consulta só, e
 * saber quais vetar. Não decide nada — quem escolhe continua sendo a função
 * única.
 */
export function idsDaCadeiaDoAviso(entrada: {
  conversa?: ConversaDoDestino;
  negocio?: NegocioDoDestino;
  contato?: ContatoDoDestino;
}): string[] {
  const ids: string[] = [];
  const daConversa = entrada.conversa as { assigned_to_user_id?: unknown; assignee_kind?: unknown } | null | undefined;
  const doNegocio = entrada.negocio as { owner_user_id?: unknown; owner_kind?: unknown } | null | undefined;
  const doContato = entrada.contato as { carteira_user_id?: unknown } | null | undefined;
  if (daConversa?.assignee_kind !== "agent") {
    const id = texto(daConversa?.assigned_to_user_id);
    if (id) ids.push(id);
  }
  if (doNegocio?.owner_kind !== "agent") {
    const id = texto(doNegocio?.owner_user_id);
    if (id) ids.push(id);
  }
  const daCarteira = texto(doContato?.carteira_user_id);
  if (daCarteira) ids.push(daCarteira);
  return [...new Set(ids)];
}

/**
 * Os elos cujo id veio da cadeia e não tem telefone utilizável no perfil —
 * exceto quem está marcado com "Não enviar aviso de caso": esse não é pulado,
 * é onde a cadeia para (#4989).
 */
function semTelefone(
  ids: readonly string[],
  whatsapps: WhatsappsDosMembros,
  naoAvisar: ReadonlySet<string>,
): Set<string> {
  return new Set(ids.filter((id) => !naoAvisar.has(id) && texto(whatsapps.get(id)) === null));
}

/** `user_id` → WhatsApp do perfil do membro (`user_organizations.whatsapp_e164`). */
export type WhatsappsDosMembros = ReadonlyMap<string, string | null | undefined>;

/** O `elo` do descarte da cadeia, na voz do aviso. `null` = elo que não é do aviso. */
function eloDoAviso(elo: EloDoDestino): EloDoAviso | null {
  return elo === "responsavel_da_conversa" || elo === "responsavel_do_negocio" || elo === "dono_da_carteira"
    ? elo
    : null;
}

/**
 * Reescreve `recusado` como `sem_telefone` quando a recusa foi NOSSA, por falta
 * de número no perfil.
 *
 * A cadeia tem um vocabulário só (`ausente`/`id_invalido`/`recusado`) porque é a
 * mesma para a atribuição de negócio, onde "recusado" é vínculo. Aqui a recusa
 * tem uma causa concreta e útil na tela e no log, e é ela que precisa aparecer.
 */
function descartesDoAviso(
  descartes: readonly DescarteDaCadeia[],
  vetadosPorTelefone: Set<string>,
  idsPorElo: Map<EloDoAviso, string>,
): DescarteDoAviso[] {
  const saida: DescarteDoAviso[] = [];
  for (const d of descartes) {
    const elo = eloDoAviso(d.elo);
    if (!elo) continue;
    const motivo: MotivoDoDescarteDoAviso =
      d.motivo === "recusado" && vetadosPorTelefone.has(idsPorElo.get(elo) ?? "")
        ? "sem_telefone"
        : d.motivo;
    saida.push({ elo, motivo });
  }
  return saida;
}

/**
 * A RESOLUÇÃO — pura: nada de banco, de relógio, de sessão.
 *
 * `whatsapps` é a resposta COMPLETA para os ids que `idsDaCadeiaDoAviso`
 * devolveu, numa consulta só; quem chama é dono de pedi-la (o adapter do aviso
 * faz isso em `lib/escalacao/membros-do-aviso`).
 */
export function resolverDestinoDoAviso(entrada: {
  config: ConfigDoDestinoDoAviso;
  conversa?: ConversaDoDestino;
  negocio?: NegocioDoDestino;
  contato?: ContatoDoDestino;
  whatsapps: WhatsappsDosMembros;
  /** Quem NÃO recebe aviso de caso (#4989). Só o aviso de caso passa. */
  naoAvisar?: ReadonlySet<string>;
}): DestinoDoAviso {
  const daConfig = (entrada.config ?? null) as Record<string, unknown> | null;
  const numeroDaEmpresa = texto(daConfig?.telefone_destino);

  // O caminho de sempre. Não olha conversa, negócio nem carteira: quem escolheu
  // número fixo escolheu não depender de quem está com o card.
  if (modoDoDestinoDoAviso(daConfig) === "fixo") {
    return numeroDaEmpresa
      ? { telefone: numeroDaEmpresa, origem: "numero_da_empresa", user_id: null, descartes: [] }
      : { telefone: null, origem: "sem_destino", user_id: null, descartes: [] };
  }

  const ids = idsDaCadeiaDoAviso(entrada);
  const naoAvisar = entrada.naoAvisar ?? new Set<string>();
  const vetados = semTelefone(ids, entrada.whatsapps, naoAvisar);
  const idsPorElo = new Map<EloDoAviso, string>();
  const daConversa = entrada.conversa as { assigned_to_user_id?: unknown; assignee_kind?: unknown } | null | undefined;
  const doNegocio = entrada.negocio as { owner_user_id?: unknown; owner_kind?: unknown } | null | undefined;
  const doContato = entrada.contato as { carteira_user_id?: unknown } | null | undefined;
  if (daConversa?.assignee_kind !== "agent" && texto(daConversa?.assigned_to_user_id)) {
    idsPorElo.set("responsavel_da_conversa", texto(daConversa?.assigned_to_user_id)!);
  }
  if (doNegocio?.owner_kind !== "agent" && texto(doNegocio?.owner_user_id)) {
    idsPorElo.set("responsavel_do_negocio", texto(doNegocio?.owner_user_id)!);
  }
  if (texto(doContato?.carteira_user_id)) {
    idsPorElo.set("dono_da_carteira", texto(doContato?.carteira_user_id)!);
  }

  // ⚠️ SEM `fallback` de propósito: o último elo do aviso é um TELEFONE, e o
  // fallback da função de atribuir é uma PESSOA (fixa ou rodízio). Quem decide
  // o número da empresa é esta função, abaixo — uma vez, com o mesmo teste.
  const cadeia = resolverDestinoDoAtribuir(
    entrada.negocio,
    entrada.contato,
    { modo: "destino", destinos: CADEIA_DO_AVISO },
    [...vetados],
    entrada.conversa,
  );

  const descartes = descartesDoAviso(cadeia.descartes, vetados, idsPorElo);

  // A vez é de quem está marcado: a cadeia para aqui, sem número da empresa.
  if (cadeia.user_id && naoAvisar.has(cadeia.user_id)) {
    const elo = cadeia.motivo as EloDoAviso;
    return {
      telefone: null,
      origem: "nao_avisar",
      user_id: cadeia.user_id,
      descartes: [...descartes, { elo, motivo: "nao_avisar" }],
    };
  }

  if (cadeia.user_id) {
    return {
      telefone: texto(entrada.whatsapps.get(cadeia.user_id)) ?? null,
      origem: cadeia.motivo as EloDoAviso,
      user_id: cadeia.user_id,
      descartes,
    };
  }

  // Ninguém da cadeia serviu: o número da empresa, que é o desfecho de sempre.
  return numeroDaEmpresa
    ? { telefone: numeroDaEmpresa, origem: "numero_da_empresa", user_id: null, descartes }
    : { telefone: null, origem: "sem_destino", user_id: null, descartes };
}
