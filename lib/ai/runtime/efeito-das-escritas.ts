/**
 * O PREDICADO ÚNICO DO EFEITO (issue #3333): **esta ação já produziu efeito neste turno?**
 *
 * ═══ O DEFEITO, MEDIDO ═══
 *
 * Numa imobiliária montada do zero no ambiente de teste, o agente mostrou os imóveis, o
 * cliente disse "tenho interesse nesse" e o agente respondeu **"já registrei seu interesse"**
 * sem chamar `crm_create_lead`. O negócio não nasceu e o cliente saiu achando que estava
 * tudo certo. Com `gpt-5.6-luna`: 4 tentativas, 3 configurações de prompt, e em TODAS ele
 * escreveu que registrou sem chamar a ferramenta.
 *
 * ═══ POR QUE UM PREDICADO, E NÃO UMA CHECAGEM A MAIS ═══
 *
 * A pergunta "deu certo?" já é respondida nesta base — e é respondida DENTRO da ponte
 * (`lib/ai/runtime/tools.ts` → `wrapMcpTool`), que decide o `success` de cada chamada no
 * `api_audit_log` depois de passar por: escopo do contato do turno, negócio do turno,
 * escopo de funil, recusa do próprio handler e escrita sem desfecho. Repetir esse julgamento
 * em cada ferramenta (ou no turno que monta as tools) seria a família de defeito que este
 * repositório já mediu mais de uma vez: a segunda cópia da regra nasce diferente da primeira
 * e discorda dela em silêncio.
 *
 * Então a divisão é esta, e só esta:
 *
 *   - **quem RESPONDE** é a ponte, no único ponto onde o desfecho de uma escrita é conhecido
 *     (uma linha por saída: efeito, falha, incerteza);
 *   - **quem PERGUNTA** é o caminho que produz a fala (`guardrails/before-send.ts`, gate
 *     `registro_sem_efeito`), com `produziuEfeito(ferramenta)` — a MESMA pergunta para toda
 *     a família de escritas que registram o interesse.
 *
 * Nenhum call site novo precisa saber o que é sucesso: ele lê daqui.
 *
 * ═══ AS TRÊS RESPOSTAS, E POR QUE SÃO TRÊS ═══
 *
 * `produziu_efeito` — o handler rodou e devolveu resultado: o registro EXISTE.
 * `falhou` — recusa (escopo/funil/handler) ou exceção: o registro NÃO existe, e a fala tem
 *   como dizer a verdade.
 * `incerto` — a escrita ficou sem desfecho confirmado (`EscritaDoNegocioSemDesfechoError`):
 *   não se sabe. Na dúvida a fala também NÃO afirma sucesso — é o que a própria mensagem
 *   dessa exceção já manda o modelo fazer ("Não confirme sucesso… peça à equipe para
 *   conferir"). Colapsar `incerto` em `falhou` mentiria para o outro lado.
 *
 * `nao_tentada` (leitura, e não um desfecho registrado) existe para o ENSINO do veto: mandar
 * "chame `crm_create_lead`" é diferente de "o registro falhou, avise o cliente".
 *
 * EFEITO é MONOTÔNICO no turno: uma vez produzido, um erro posterior da mesma ferramenta não
 * apaga o registro que já existe no banco. Por isso `registrar` ignora desfechos posteriores
 * a um `produziu_efeito` — a pergunta é "existe efeito?", não "qual foi a última tentativa?".
 * O mapa guarda NOMES, não argumentos/objetos. A sucesso seguido de B falha na
 * mesma ferramenta continua lendo efeito; isso não comprova o registro de B.
 * Essa lacuna permanece na #3333, sem uma expectativa que a legitime como correta.
 *
 * Puro de propósito: sem I/O, sem banco, sem relógio. Quem cria é o turno
 * (`inbound-turn.ts`), quem alimenta é a ponte (`lib/ai/runtime/tools.ts`), quem lê é o gate.
 */

/** O que aconteceu com UMA escrita. Só `produziu_efeito` autoriza a fala a afirmar sucesso. */
export type DesfechoDaEscrita = "produziu_efeito" | "falhou" | "incerto";

/** A leitura para quem pergunta: os três desfechos + "ninguém tentou". */
export type LeituraDoEfeito = DesfechoDaEscrita | "nao_tentada";

/**
 * O coletor do turno. Uma instância por turno/run — nunca compartilhada entre eles: o efeito
 * é do TURNO (a fala que sai agora), e um coletor de processo juntaria turnos diferentes.
 */
export interface EfeitoDasEscrituras {
  /** Chamado UMA vez por saída da ponte, com o desfecho que ela já decidiu para o audit. */
  registrar(ferramenta: string, desfecho: DesfechoDaEscrita): void;
  /** O desfecho registrado — `nao_tentada` quando nenhuma chamada daquela ferramenta saiu. */
  desfechoDe(ferramenta: string): LeituraDoEfeito;
  /** O predicado ÚNICO: `true` só quando a escrita de fato produziu efeito neste turno. */
  produziuEfeito(ferramenta: string): boolean;
}

/** Coletor vazio — o turno cria um; quem não tem nada a registrar pode usar este. */
export function criarEfeitoDasEscrituras(): EfeitoDasEscrituras {
  const desfechos = new Map<string, DesfechoDaEscrita>();
  return {
    registrar(ferramenta: string, desfecho: DesfechoDaEscrita): void {
      // Efeito é MONOTÔNICO (ver cabeçalho): o registro que já existe não é desfeito por
      // uma tentativa seguinte que falhou.
      if (desfechos.get(ferramenta) === "produziu_efeito") return;
      desfechos.set(ferramenta, desfecho);
    },
    desfechoDe(ferramenta: string): LeituraDoEfeito {
      return desfechos.get(ferramenta) ?? "nao_tentada";
    },
    produziuEfeito(ferramenta: string): boolean {
      return desfechos.get(ferramenta) === "produziu_efeito";
    },
  };
}
