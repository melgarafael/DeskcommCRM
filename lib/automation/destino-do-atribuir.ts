/**
 * O DESTINO DINÂMICO da ação `assign_owner` (#3804) — QUEM recebe, quando a
 * pessoa não está escrita na regra.
 *
 * ─── O problema ────────────────────────────────────────────────────────────
 *
 * Quem faz o pós-venda é o vendedor que fez a venda, e isso muda de negócio
 * para negócio. Com o destino escolhido NA REGRA (pessoa fixa ou rodízio), a
 * agência que tem carteira por vendedor precisa de uma automação por pessoa — ou
 * entrega o pós-venda de todos para uma pessoa só. As duas saídas erram.
 *
 * ─── O CONTRATO (é ele que a #3803 vai reusar) ─────────────────────────────
 *
 *   `resolverDestinoDoAtribuir(negocio, contato, config, recusados?, conversa?)`
 *     → `{ user_id, motivo, descartes }`
 *
 * É uma função PURA: nada de banco, de relógio, de sessão. Tudo que ela sabe do
 * mundo chega pelos argumentos — a linha do negócio (`owner_user_id`,
 * `owner_kind`), a do contato (`carteira_user_id`) e a configuração da ação. A
 * conferência de VÍNCULO (é membro ativo? é `viewer`?) fica com quem chama, que
 * devolve o que recusou em `recusados`; a função então anda a cadeia. Assim a
 * mesma decisão serve ao aviso da #3803, que vai escolher entre o responsável da
 * conversa, o do negócio aberto e o dono da carteira — trocando só a lista de
 * `destinos`.
 *
 *   `user_id`  quem recebe. `null` = o banco escolhe (rodízio) ou ninguém.
 *   `motivo`   QUAL elo decidiu. É o que vai para a Atividade: sem isso a regra
 *              move o negócio e ninguém sabe por quê (a "caixa-preta" que a
 *              issue proíbe).
 *   `descartes` os elos tentados antes, e por que cada um não serviu
 *              (`ausente`, `id_invalido`, `recusado`). `[]` quando o primeiro
 *              elo já resolveu.
 *
 * ─── Os modos ─────────────────────────────────────────────────────────────
 *
 *   `{ user_id }` / `{ modo: "fixo", user_id }`  a pessoa de sempre.
 *   `{ modo: "rodizio", fila }`                  o rodízio de sempre (#2041).
 *   `{ modo: "destino", destinos, fallback }`    o modo desta issue: a cadeia na
 *                                                ordem de `destinos` e, quando
 *                                                nenhum serve, o `fallback`
 *                                                (pessoa fixa OU rodízio).
 *
 * Nada aqui muda o desfecho de quem não usa o modo novo: as regras gravadas
 * antes desta entrega têm `user_id` e/ou `modo` reconhecidos como sempre.
 *
 * ─── O que a #3803 acrescentou, e por que foi só isto ──────────────────────
 *
 * O aviso no WhatsApp para o responsável precisa de um elo que a ação de
 * atribuir não tinha: o **responsável da CONVERSA** (é o vendedor que está com
 * o cliente agora, antes de qualquer negócio existir). A cadeia do aviso é
 * `responsavel_da_conversa → responsavel_do_negocio → dono_da_carteira`, e cada
 * elo devolve um `user_id`; o telefone de quem recebe é outro assunto, de quem
 * chama. Por isso aqui entraram só o candidato novo e a linha da conversa (5º
 * argumento, opcional) — a ordem, o descarte, a validação de id e a recusa por
 * vínculo continuam sendo os MESMOS de todos os chamadores. Duas
 * implementações da mesma regra divergiriam na primeira correção.
 */

/**
 * Os destinos que a regra pode pedir, na ordem em que são tentados.
 *
 * `responsavel_da_conversa` só serve ao aviso de caso/proposta (#3803): a ação
 * de atribuir não o pede, mas ela é quem decide — e um elo que só existe numa
 * das duas cadeias é exatamente a segunda implementação que não deve nascer.
 */
export type CandidatoDoDestino =
  | "responsavel_da_conversa"
  | "responsavel_do_negocio"
  | "dono_da_carteira";

/** Qual elo decidiu (ou por que ninguém recebeu). Vai para a Atividade. */
export type MotivoDoDestino =
  | CandidatoDoDestino
  | "fixo"
  | "fallback_fixo"
  | "rodizio"
  | "fallback_rodizio"
  | "sem_destino";

/** Por que um elo foi descartado. `recusado` = quem chama vetou o vínculo. */
export type MotivoDoDescarte = "ausente" | "id_invalido" | "recusado";

export type EloDoDestino = CandidatoDoDestino | "pessoa_fixa" | "fallback_fixo";

/** Um elo tentado e não usado — a trilha que a Atividade mostra. */
export type Descarte = { elo: EloDoDestino; motivo: MotivoDoDescarte };

export type DestinoResolvido = {
  /** `null` só quando quem escolhe é o banco (rodízio) ou quando ninguém recebe. */
  user_id: string | null;
  motivo: MotivoDoDestino;
  descartes: Descarte[];
};

/** A linha do negócio como `buildContext` a entrega (só o que importa aqui). */
export type NegocioDoDestino = { owner_user_id?: unknown; owner_kind?: unknown } | null | undefined;
/** A linha do contato como `buildContext` a entrega. */
export type ContatoDoDestino = { carteira_user_id?: unknown } | null | undefined;
/**
 * A linha da conversa — o que o aviso do #3803 entrega a mais.
 *
 * `assignee_kind = 'agent'` é a IA atendendo: a conversa está "com o agente",
 * não com uma pessoa, e avisar um robô não existe. Mesma leitura de
 * `responsavelDoNegocio` para `owner_kind`.
 */
export type ConversaDoDestino =
  | { assigned_to_user_id?: unknown; assignee_kind?: unknown }
  | null
  | undefined;
/** A configuração da ação, como veio do banco (pode ser de outra versão). */
export type ConfigDoDestino = Record<string, unknown> | null | undefined;

/**
 * A forma de um id de usuário — o mesmo `gen_random_uuid()` que as tabelas usam.
 *
 * Sem esta conferência, um `owner_user_id` que não é id (o número que uma
 * importação gravou, o `"sem-dono"` que alguém escreveu no card) iria para o
 * UPDATE e o Postgres derrubaria a ação inteira com `22P02`. O defeito não é do
 * dado torto: é atribuir a alguém que não existe, ou explodir em vez de cair no
 * fallback.
 */
const ID_DE_USUARIO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CANDIDATOS: readonly string[] = [
  "responsavel_da_conversa",
  "responsavel_do_negocio",
  "dono_da_carteira",
];

/** Texto não vazio, ou `null` — o banco devolve nulo, "", ausente e número. */
function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/** Um objeto de verdade (não array, não null) ou `null`. */
function registro(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * O dono do card que disparou a regra.
 *
 * `owner_kind = 'agent'` é a IA: o card está com um agente, não com uma pessoa,
 * e "responsável do negócio" não pode virar "atribuir a um robô" — a ação grava
 * `owner_user_id`, então a IA simplesmente não é candidata.
 */
function responsavelDoNegocio(negocio: NegocioDoDestino): unknown {
  const linha = registro(negocio);
  if (!linha) return null;
  return texto(linha.owner_kind) === "agent" ? null : linha.owner_user_id;
}

/** O atendente que está com a conversa agora (#3803). */
function responsavelDaConversa(conversa: ConversaDoDestino): unknown {
  const linha = registro(conversa);
  if (!linha) return null;
  return texto(linha.assignee_kind) === "agent" ? null : linha.assigned_to_user_id;
}

/** O atendente dono da carteira do contato. */
function donoDaCarteira(contato: ContatoDoDestino): unknown {
  return registro(contato)?.carteira_user_id ?? null;
}

/**
 * A resolução do destino — pura, sem banco, sem relógio (contrato no topo).
 *
 * `recusados` são os ids que quem chama já vetou (não é membro ativo, é
 * `viewer`). A função NÃO consulta vínculo: ela só pula o que foi recusado e
 * registra o motivo, para a decisão continuar testável sem dublê.
 */
export function resolverDestinoDoAtribuir(
  negocio: NegocioDoDestino,
  contato: ContatoDoDestino,
  config: ConfigDoDestino,
  recusados: readonly string[] = [],
  /**
   * A conversa que disparou o aviso (#3803). Opcional e no FIM da lista de
   * propósito: os chamadores do #3804 continuam com quatro argumentos e a
   * assinatura que já está no main não muda de forma.
   */
  conversa: ConversaDoDestino = null,
): DestinoResolvido {
  const descartes: Descarte[] = [];
  const recusado = new Set(recusados);
  const daConfig = registro(config);

  /**
   * Lê o id do elo e decide se ele serve. `null` = não serve, e o motivo do
   * descarte já ficou registrado; quem chama segue para o próximo elo.
   */
  const aceitar = (elo: EloDoDestino, valor: unknown): string | null => {
    // Vazio é AUSENTE (o card não tem dono); qualquer outra coisa que não seja
    // id é DADO TORTO (`id_invalido`) — a diferença importa para quem lê a
    // Atividade: uma é o fluxo normal, a outra é o card para arrumar.
    const vazio = valor === null || valor === undefined || (typeof valor === "string" && valor.trim() === "");
    if (vazio) {
      descartes.push({ elo, motivo: "ausente" });
      return null;
    }
    const id = texto(valor);
    if (id === null || !ID_DE_USUARIO.test(id)) {
      descartes.push({ elo, motivo: "id_invalido" });
      return null;
    }
    if (recusado.has(id)) {
      descartes.push({ elo, motivo: "recusado" });
      return null;
    }
    return id;
  };

  const modo = texto(daConfig?.modo) ?? "fixo";

  // A pessoa de sempre. Sem `modo` é o payload de quem instalou antes do #2041.
  if (modo === "fixo") {
    const id = aceitar("pessoa_fixa", daConfig?.user_id);
    return id
      ? { user_id: id, motivo: "fixo", descartes }
      : { user_id: null, motivo: "sem_destino", descartes };
  }

  // O rodízio de sempre: a pessoa é escolhida pela função do banco, na hora.
  if (modo === "rodizio") return { user_id: null, motivo: "rodizio", descartes };

  if (modo === "destino") {
    const pedidos = Array.isArray(daConfig?.destinos) ? daConfig!.destinos : [];
    for (const pedido of pedidos) {
      // Destino que esta versão não conhece é ignorado, não estoura: a cadeia é
      // dado gravado, e uma lista com lixo não pode derrubar a automação.
      if (typeof pedido !== "string" || !CANDIDATOS.includes(pedido)) continue;
      const elo = pedido as CandidatoDoDestino;
      const valor =
        elo === "responsavel_da_conversa"
          ? responsavelDaConversa(conversa)
          : elo === "responsavel_do_negocio"
            ? responsavelDoNegocio(negocio)
            : donoDaCarteira(contato);
      const id = aceitar(elo, valor);
      if (id) return { user_id: id, motivo: elo, descartes };
    }

    const fallback = registro(daConfig?.fallback);
    const modoDoFallback = texto(fallback?.modo);
    if (modoDoFallback === "rodizio") return { user_id: null, motivo: "fallback_rodizio", descartes };
    if (modoDoFallback === "fixo") {
      const id = aceitar("fallback_fixo", fallback?.user_id);
      if (id) return { user_id: id, motivo: "fallback_fixo", descartes };
    }
    return { user_id: null, motivo: "sem_destino", descartes };
  }

  // Configuração de outra versão (ou torta): não explode e não inventa destino.
  return { user_id: null, motivo: "sem_destino", descartes };
}
