/**
 * ATENDIMENTO MANUAL PELO CANAL — o dono pegou o celular e respondeu o cliente
 * direto no WhatsApp (ou por outra plataforma ligada à mesma conta). A IA para
 * NESSA conversa, para não responder junto — e volta sozinha quando o prazo
 * vence.
 *
 * ## Por que existe
 *
 * `app/api/v1/messages/_handler.ts` (composer) já silencia o bot quando o ATOR é
 * uma pessoa — mas por uma janela deslizante de 5 min. O envio feito do celular
 * do operador NÃO passa por ali: ele entra pela ingestão de saída do canal (o
 * caminho `fromMe` do webhook, mensagem enviada fora do CRM) e era gravado como
 * histórico sem tocar em trava nenhuma. Resultado: a IA continuava respondendo
 * por cima de quem estava atendendo à mão.
 *
 * A lacuna foi medida em produção: um humano negociou preço e
 * pagamento de peça direto no WhatsApp, e a IA, sem saber disso, se meteu de
 * volta na conversa afirmando que "os dados do PIX estão sendo confirmados" —
 * algo que ela não tem nenhuma ferramenta para saber.
 *
 * ## O prazo, e por que o padrão é 60 minutos
 *
 * O silêncio EXPIRA sozinho. Não é `'infinity'`: `'infinity'` é o handoff
 * FORMAL, aquele em que alguém clicou "assumir" na tela e assumiu junto a
 * responsabilidade de devolver. Aqui ninguém clicou em nada — a pessoa só
 * respondeu uma mensagem pelo celular. Silêncio durável nesse gesto significa
 * que um "oi" do próprio dono testando o número desliga o atendimento
 * automático daquela conversa para sempre, e ninguém fica sabendo: a conversa
 * some do robô sem aparecer para nenhum humano.
 *
 * 60 minutos porque é a ordem de grandeza de um atendimento humano de verdade
 * — quem parou para responder pelo celular termina o assunto dentro da hora —,
 * é muito mais que a janela de 5 min do composer (que cobre só o tempo de
 * digitar dentro do CRM) e é curto o bastante para que um engano se pague
 * sozinho no mesmo turno de trabalho, em vez de virar uma conversa morta.
 *
 * ## O prazo é um ajuste POR EMPRESA — e por que ele precisou existir
 *
 * O raciocínio acima vale para o caso que ele mediu, mas ele mediu UM caso: o
 * dono que responde pelo celular de vez em quando e fecha o assunto. Quem
 * atende o dia INTEIRO pelo celular tem outra forma — e é o caso mais comum
 * de consultório e clínica, onde uma pessoa atende, atende e atende.
 *
 * Medido numa instalação real (2026-09-30, diagnóstico de @gaberaldo-svg no
 * #2005): com 60 min, a IA não respondia NENHUMA mensagem de paciente ao longo
 * do expediente. Não era falha do agente, do funil nem do modelo — a atendente
 * renovava o prazo a cada fala, e o dia inteiro de atendimento manual é, na
 * prática, silêncio de 60 min sem fim. O sintoma é o pior possível de
 * diagnosticar: o agente está publicado, o canal está de pé, e os logs dizem
 * "turno pulado (sem gasto)", `motivo: "conversa_silenciada"` — que parece
 * exatamente uma pausa correta.
 *
 * Por isso o prazo é `organizations.settings.routing.manual_reply_silence_minutes`,
 * editável em Configurações › Atendimento, com o 60 de antes como PADRÃO:
 * empresa que nunca abriu a tela continua com o comportamento medido acima.
 * A faixa é a mesma da devolução automática (5 min a 24 h, `PRAZO_MIN_MINUTOS`
 * / `PRAZO_MAX_MINUTOS`). Quem lê é `lerPrazoDoSilencioManualMinutos`; valor
 * ausente, nulo ou fora da faixa é 60, e falha ao ler `settings` também é 60 —
 * a pausa nunca deixa de acontecer por causa do ajuste.
 *
 * É por empresa, e não por instalação, porque numa VPS com várias empresas a
 * clínica que atende pelo celular o dia inteiro e a loja que responde de vez
 * em quando querem prazos diferentes. O ajuste é lido por TODO canal cuja
 * ingestão reconhece saída feita fora do CRM (qualquer provedor), porque
 * todos passam por `pausarIaPorAtendimentoManual`.
 *
 * ## Cada mensagem nova do humano RENOVA o prazo
 *
 * O relógio conta a partir da ÚLTIMA fala humana, não da primeira. Sem isso, um
 * atendimento de uma hora e meia veria a IA voltar a falar no meio — que é o
 * pior desfecho possível, porque é justamente quando há uma pessoa na conversa.
 * Na prática: cada chamada propõe `agora + prazo` e grava se isso for MAIS
 * TARDE que o silêncio em vigor.
 *
 * ## O que NUNCA encurta
 *
 * Um silêncio maior já em vigor fica: handoff formal (`'infinity'`, que
 * `normalizarInstante` devolve como `Infinity`) e qualquer janela mais longa
 * que a nossa. A pausa por resposta manual é o silêncio mais FRACO da casa —
 * ela estende, nunca regride.
 *
 * ## O que grava, e o que NÃO grava
 *
 *   - `bot_silenced_until = agora + prazo da empresa`
 *   - `last_handoff_at` / `last_handoff_reason` — rastro visível de que uma
 *     pessoa assumiu por fora.
 *
 * **NÃO toca `contacts.ai_authorized_at`.** A origem/autorização do lead é
 * estado SEPARADO (elegibilidade), não handoff. Uma resposta manual pausa a
 * conversa; não apaga que o lead veio do Respondi. Quando o prazo vence, a
 * autorização ainda está lá.
 *
 * **NÃO toca `contacts.force_human`** (trava do CONTATO inteiro — pausar uma
 * conversa não é bloquear o cliente) nem `assignee_kind` (exige um
 * `assigned_to_user_id`, e o celular do dono não é necessariamente um usuário do
 * CRM) nem `status` (mandar para `pending` diria "na fila esperando atendente",
 * o oposto de "estou atendendo").
 *
 * ## Zero linhas tem DOIS motivos, e eles pedem tratamentos opostos (#534)
 *
 * O UPDATE devolve `error: null` e nenhuma linha quando não casou com nada. Duas
 * causas possíveis, indistinguíveis pela resposta da escrita:
 *
 *   1. **CORRIDA** — a linha existe, mas a escrita ainda não é visível (réplica
 *      atrasada, DELETE concorrente que ainda não commitou). Repetir UMA vez,
 *      depois de RELER, resolve.
 *   2. **CONVERSA INEXISTENTE / organização errada** — repetir nunca resolve.
 *
 * Repetir às cegas seria um laço; desistir em silêncio é o defeito. A decisão é
 * tomada RELENDO a conversa: se ela está lá, é corrida e cabe uma segunda
 * escrita; se não está, o motivo é nomeado e nenhuma escrita é repetida. O
 * `ResultadoDaPausa` leva o motivo até o chamador — que NÃO pode seguir como se
 * a IA estivesse pausada. A porta pública recebe `avisar`: quando a pausa não é
 * garantida, o chamador é obrigado a gravar o motivo (audit), em vez de receber
 * um `false` anônimo.
 *
 * Fire-and-forget: a ingestão da mensagem do cliente não pode cair porque a
 * pausa falhou. Isso vale para o CHAMADOR não lançar; não vale para esconder a
 * falha: ela sai como `logger.error`, vai para o `audit` do chamador e volta no
 * resultado da ingestão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { normalizarInstante } from "@/lib/ai/elegibilidade/gate";
import { PRAZO_MAX_MINUTOS, PRAZO_MIN_MINUTOS } from "@/lib/escalacao/devolucao-automatica";

/** O prazo documentado acima, e o que vale quando a empresa não ajustou nada. */
export const PRAZO_PADRAO_DO_SILENCIO_MINUTOS = 60;

/**
 * O prazo PADRÃO em milissegundos — o que vale para quem nunca abriu a tela.
 * Ver "O prazo, e por que o padrão é 60 minutos" na docstring do módulo.
 */
export const PRAZO_DO_SILENCIO_MS = PRAZO_PADRAO_DO_SILENCIO_MINUTOS * 60 * 1000;

/**
 * Lê `settings.routing.manual_reply_silence_minutes` sem nunca lançar.
 *
 * Ausente, nulo, não-número, não-finito ou fora da faixa (5 min a 24 h) é o
 * padrão de 60. Defensivo porque `settings` é jsonb livre: um valor estragado
 * gravado à mão não pode virar `NaN` em `bot_silenced_until` — o efeito seria
 * a IA falando por cima do humano, que é o defeito que este módulo existe para
 * não ter.
 */
export function lerPrazoDoSilencioManualMinutos(settings: unknown): number {
  const routing = (settings as { routing?: unknown } | null)?.routing;
  const valor = (routing as { manual_reply_silence_minutes?: unknown } | null)
    ?.manual_reply_silence_minutes;
  if (typeof valor !== "number" || !Number.isFinite(valor)) return PRAZO_PADRAO_DO_SILENCIO_MINUTOS;
  if (valor < PRAZO_MIN_MINUTOS || valor > PRAZO_MAX_MINUTOS) return PRAZO_PADRAO_DO_SILENCIO_MINUTOS;
  return Math.floor(valor);
}

/**
 * O prazo da empresa, em ms. Falha ao ler (rede, RLS, organização sumida) é o
 * padrão: a pausa tem de acontecer de qualquer jeito, e o padrão é o
 * comportamento que valia antes de o ajuste existir.
 */
async function prazoDoSilencioDaEmpresaMs(
  admin: SupabaseClient,
  organizationId: string,
): Promise<number> {
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) {
      logger.warn("[atendimento-manual] ajuste do prazo ilegível — vale o padrão de 60 min", {
        organization_id: organizationId,
        detail: error.message.slice(0, 160),
      });
      return PRAZO_DO_SILENCIO_MS;
    }
    const settings = (data as { settings?: unknown } | null)?.settings;
    return lerPrazoDoSilencioManualMinutos(settings) * 60 * 1000;
  } catch (err) {
    logger.warn("[atendimento-manual] leitura do ajuste do prazo lançou — vale o padrão de 60 min", {
      organization_id: organizationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return PRAZO_DO_SILENCIO_MS;
  }
}

/** Motivo gravado quando uma pessoa responde pelo canal, fora do CRM. */
export const MOTIVO_ATENDIMENTO_MANUAL = "Atendimento manual pelo canal (resposta fora do CRM)";

/**
 * Motivo gravado quando o operador manda `#off` do celular. Separado do motivo
 * acima de propósito: a tela e a trilha precisam distinguir "alguém respondeu à
 * mão" de "alguém desligou o automático com o comando".
 */
export const MOTIVO_COMANDO_OFF = "Comando #off enviado pelo celular";

export interface PausaPorAtendimentoManualInput {
  organizationId: string;
  conversationId: string;
  /** Rótulo da origem do evento, só para log (o adapter que chamou se identifica). */
  canal?: string;
  /** Texto gravado em `last_handoff_reason`. Default = `MOTIVO_ATENDIMENTO_MANUAL`. */
  motivo?: string;
  /**
   * `true` grava `'infinity'` (só `#on` pelo celular ou "devolver ao automático"
   * na tela religam) em vez do prazo. Só vale para o agente que ligou "Comandos
   * pelo celular" (`ai_agents.config.aceita_comandos_celular`): sem o `#on` à
   * mão, silêncio durável por um "oi" no celular seria a conversa morta que a
   * docstring deste módulo descreve.
   */
  duravel?: boolean;
  /**
   * O instante da fala humana. INJETADO para o teste não depender do relógio
   * real: o `now()` do banco e o `Date.now()` do processo são dois relógios, e
   * comparar um com o outro produz falha intermitente. Default = agora.
   */
  agora?: Date;
  /**
   * O aviso de que a pausa NÃO foi garantida (#534) — chamado só nesse caso,
   * com o motivo nomeado. Quem chama da ingestão TEM de passar um (o `audit`,
   * tipicamente): é o que impede a falha de virar um `false` anônimo que o
   * chamador ignora. Silêncio maior já em vigor NÃO é falha e não avisa.
   */
  avisar?: (falha: FalhaDaPausa) => void | Promise<void>;
}

/**
 * POR QUE a pausa não foi garantida. Nomeado porque os dois motivos de zero
 * linhas pedem tratamentos opostos (#534) e porque `false` anônimo é
 * indistinguível de "já havia silêncio maior".
 */
export type MotivoDaPausaNaoGravada =
  /** A conversa não existe nesta organização — repetir nunca resolve. */
  | "conversa_inexistente"
  /** A linha existe, mas a escrita não é visível — nem depois da repetição. */
  | "corrida_persistente"
  /** A LEITURA falhou: não há como dizer se a conversa existe. */
  | "leitura_falhou"
  /** A ESCRITA devolveu erro (rede, RLS, constraint). */
  | "escrita_falhou"
  /** Exceção inesperada no caminho. */
  | "erro_inesperado";

/**
 * O que aconteceu de verdade.
 *
 * `pausada: true` com `gravada: false` é o caso legítimo de um silêncio MAIOR já
 * em vigor (handoff formal, janela mais longa): a IA está calada, só não fomos
 * nós que a calamos agora. `pausada: false` é FALHA, sempre com motivo nomeado.
 */
export type ResultadoDaPausa =
  | { pausada: true; gravada: boolean }
  | { pausada: false; motivo: MotivoDaPausaNaoGravada; detalhe?: string };

type LeituraDaConversa =
  | { estado: "ok"; botSilencedUntil: string | null }
  | { estado: "ausente" }
  | { estado: "erro"; detalhe: string };

/** Uma leitura da conversa, sem lançar. */
async function lerConversa(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<LeituraDaConversa> {
  try {
    const { data, error } = await admin
      .from("conversations")
      .select("bot_silenced_until")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error) return { estado: "erro", detalhe: error.message.slice(0, 160) };
    if (data == null) return { estado: "ausente" };
    return {
      estado: "ok",
      botSilencedUntil: (data as { bot_silenced_until: string | null }).bot_silenced_until,
    };
  } catch (err) {
    return {
      estado: "erro",
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    };
  }
}

type EscritaDaPausa =
  | { estado: "ok"; linhas: number }
  | { estado: "erro"; detalhe: string };

/** UMA escrita da pausa. `linhas` é o que torna a pausa observável. */
async function escreverPausa(
  admin: SupabaseClient,
  input: PausaPorAtendimentoManualInput,
  gravado: string,
  motivo: string,
  agora: Date,
): Promise<EscritaDaPausa> {
  try {
    const { data, error } = await admin
      .from("conversations")
      .update({
        bot_silenced_until: gravado,
        last_handoff_at: agora.toISOString(),
        last_handoff_reason: motivo,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.conversationId)
      .select("id");
    if (error) return { estado: "erro", detalhe: error.message.slice(0, 160) };
    return { estado: "ok", linhas: data?.length ?? 0 };
  } catch (err) {
    return { estado: "erro", detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro" };
  }
}

/** O instante do silêncio em vigor, em ms (`-Infinity` = sem silêncio). */
function instanteDoSilencio(valor: string | null): number {
  // Instante ilegível é tratado como "sem silêncio". A leitura conservadora
  // seria não pausar, e ela deixaria a IA falando por cima do humano — o
  // defeito que este módulo existe para não ter.
  const normalizado = normalizarInstante(valor);
  if (normalizado === null) return Number.NEGATIVE_INFINITY;
  return normalizado instanceof Date ? normalizado.getTime() : normalizado;
}

/**
 * Pausa a IA numa conversa porque uma pessoa respondeu por fora do CRM, pelo
 * prazo da empresa (padrão de 60 min) a contar de `agora` — com MOTIVO quando
 * não dá certo.
 *
 * Zero linhas na escrita não é "tanto faz": é o único desfecho em que a IA pode
 * falar por cima do atendente. Por isso a conversa é RELIDA — corrida (linha
 * existe) ganha UMA repetição; conversa inexistente vira `conversa_inexistente`
 * sem repetir a escrita. Nunca lança.
 */
export async function pausarIaPorAtendimentoManualDetalhado(
  admin: SupabaseClient,
  input: PausaPorAtendimentoManualInput,
): Promise<ResultadoDaPausa> {
  const agora = input.agora ?? new Date();
  const motivo = input.motivo ?? MOTIVO_ATENDIMENTO_MANUAL;

  try {
    // Dentro do `try`: um instante inválido não pode derrubar a ingestão.
    const propostoMs = input.duravel
      ? Number.POSITIVE_INFINITY
      : agora.getTime() + (await prazoDoSilencioDaEmpresaMs(admin, input.organizationId));
    const gravado = input.duravel ? "infinity" : new Date(propostoMs).toISOString();

    let leitura = await lerConversa(admin, input.organizationId, input.conversationId);

    // "Não achei a conversa" ainda não é veredito: a linha pode ter acabado de
    // nascer (ou a leitura pegou uma réplica atrasada). RELER decide, e reler
    // não repete escrita nenhuma.
    if (leitura.estado === "ausente") {
      leitura = await lerConversa(admin, input.organizationId, input.conversationId);
    }

    if (leitura.estado === "erro") {
      logger.warn("[atendimento-manual] leitura da conversa falhou — IA não pausada", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        detail: leitura.detalhe,
      });
      return { pausada: false, motivo: "leitura_falhou", detalhe: leitura.detalhe };
    }
    if (leitura.estado === "ausente") {
      // Segunda leitura, mesma resposta: repetir a escrita não mudaria nada.
      // O caso mais comum é organização errada (conversa de outro tenant) —
      // escrever de novo seria só mais uma ida ao banco sem destino.
      logger.error("[atendimento-manual] pausa impossível — conversa inexistente nesta organização", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        motivo: "conversa_inexistente",
      });
      return { pausada: false, motivo: "conversa_inexistente" };
    }

    // NUNCA encurta um silêncio maior já em vigor. `Infinity` (handoff formal)
    // vence qualquer prazo finito; uma janela mais longa que a nossa também.
    if (instanteDoSilencio(leitura.botSilencedUntil) >= propostoMs) {
      return { pausada: true, gravada: false };
    }

    const primeira = await escreverPausa(admin, input, gravado, motivo, agora);
    if (primeira.estado === "erro") {
      logger.warn("[atendimento-manual] pausa da IA não gravada", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        detail: primeira.detalhe,
      });
      return { pausada: false, motivo: "escrita_falhou", detalhe: primeira.detalhe };
    }
    if (primeira.linhas > 0) {
      logger.info("[atendimento-manual] IA pausada — pessoa respondeu pelo canal", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        canal: input.canal ?? "desconhecido",
        silenciada_ate: gravado,
        motivo,
      });
      return { pausada: true, gravada: true };
    }

    // Zero linhas é o mesmo que erro: o `error` do supabase-js fica `null` e só
    // a contagem denuncia. Agora com DOIS desfechos possíveis — e a releitura é
    // o que os separa.
    logger.warn(
      "[atendimento-manual] pausa da IA não gravada — nenhuma linha afetada; relendo para separar corrida de conversa inexistente",
      {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        rows: 0,
      },
    );

    const relida = await lerConversa(admin, input.organizationId, input.conversationId);
    if (relida.estado === "erro") {
      logger.error("[atendimento-manual] releitura falhou depois de zero linhas — pausa NÃO garantida", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        detail: relida.detalhe,
      });
      return { pausada: false, motivo: "leitura_falhou", detalhe: relida.detalhe };
    }
    if (relida.estado === "ausente") {
      // A linha sumiu entre a leitura e a escrita (DELETE concorrente) — ou
      // nunca existiu. Repetir a escrita não muda esse veredito.
      logger.error("[atendimento-manual] conversa desapareceu entre a leitura e a escrita — pausa impossível", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        motivo: "conversa_inexistente",
      });
      return { pausada: false, motivo: "conversa_inexistente" };
    }

    // Corrida confirmada: a linha ESTÁ lá. UMA repetição — nunca um laço.
    const segunda = await escreverPausa(admin, input, gravado, motivo, agora);
    if (segunda.estado === "erro") {
      logger.error("[atendimento-manual] repetição da pausa falhou — IA não pausada", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        detail: segunda.detalhe,
      });
      return { pausada: false, motivo: "escrita_falhou", detalhe: segunda.detalhe };
    }
    if (segunda.linhas > 0) {
      logger.info("[atendimento-manual] IA pausada na repetição — corrida resolvida", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        canal: input.canal ?? "desconhecido",
        silenciada_ate: gravado,
        motivo,
      });
      return { pausada: true, gravada: true };
    }

    logger.error("[atendimento-manual] pausa NÃO garantida — duas escritas sem linha afetada", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      tentativas: 2,
      motivo: "corrida_persistente",
    });
    return { pausada: false, motivo: "corrida_persistente" };
  } catch (err) {
    const detalhe = err instanceof Error ? err.message.slice(0, 160) : "erro";
    logger.warn("[atendimento-manual] pausa da IA lançou", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      detail: detalhe,
    });
    return { pausada: false, motivo: "erro_inesperado", detalhe };
  }
}

/**
 * Pausa a IA numa conversa porque uma pessoa respondeu por fora do CRM, pelo
 * prazo da empresa (`lerPrazoDoSilencioManualMinutos`; padrão de 60 min) a
 * contar de `agora`. Devolve `true` se gravou (pausa nova ou prazo renovado),
 * `false` se havia silêncio mais longo em vigor ou se falhou.
 *
 * Atalho booleano do detalhado: `true` só quando a pausa foi GRAVADA. Quem
 * precisa saber POR QUE falhou usa `pausarIaPorAtendimentoManualDetalhado` — e
 * quem está na ingestão passa `avisar`, que não deixa a falha passar em silêncio.
 */
export async function pausarIaPorAtendimentoManual(
  admin: SupabaseClient,
  input: PausaPorAtendimentoManualInput,
): Promise<boolean> {
  const resultado = await pausarIaPorAtendimentoManualDetalhado(admin, input);
  if (resultado.pausada) return resultado.gravada;

  logger.error(
    "[atendimento-manual] PAUSA NÃO GARANTIDA — o chamador não pode seguir como se a IA estivesse pausada",
    {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      canal: input.canal ?? "desconhecido",
      motivo: resultado.motivo,
      detalhe: resultado.detalhe,
    },
  );

  const avisar = input.avisar;
  if (avisar) {
    try {
      await avisar({
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        canal: input.canal,
        motivo: resultado.motivo,
        detalhe: resultado.detalhe,
      });
    } catch (err) {
      // O aviso é a SEGUNDA rede. Se ele falhar, a falha original continua
      // visível no erro acima e no retorno — não vira sucesso.
      logger.warn("[atendimento-manual] aviso da pausa não gravada lançou", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        motivo: resultado.motivo,
        detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
      });
    }
  }
  return false;
}

/** O que o chamador precisa saber para avisar alguém da falha. */
export interface FalhaDaPausa {
  organizationId: string;
  conversationId: string;
  canal?: string;
  motivo: MotivoDaPausaNaoGravada;
  detalhe?: string;
}

/** O motivo a carregar no resultado do chamador — `null` quando a IA está pausada. */
export function motivoDaPausaNaoGravada(
  resultado: ResultadoDaPausa,
): MotivoDaPausaNaoGravada | null {
  return resultado.pausada ? null : resultado.motivo;
}

/**
 * Pausa DURÁVEL (`'infinity'`) — o `#off` do celular, e a resposta manual de quem
 * ligou "Comandos pelo celular". A regra é a mesma de cima; só o prazo muda.
 */
export async function pausarIaDuravelmenteDetalhado(
  admin: SupabaseClient,
  input: Omit<PausaPorAtendimentoManualInput, "duravel">,
): Promise<ResultadoDaPausa> {
  return pausarIaPorAtendimentoManualDetalhado(admin, { ...input, duravel: true });
}

/** Atalho booleano da pausa durável — `true` só quando GRAVOU; avisa na falha. */
export async function pausarIaDuravelmente(
  admin: SupabaseClient,
  input: Omit<PausaPorAtendimentoManualInput, "duravel">,
): Promise<boolean> {
  return pausarIaPorAtendimentoManual(admin, { ...input, duravel: true });
}
