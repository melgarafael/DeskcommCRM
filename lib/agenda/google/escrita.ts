/**
 * A IDA — escrever no Google o que foi marcado aqui.
 *
 * ═══ O buraco que este arquivo fecha ═══
 *
 * O item pedido é "sync IDA E VOLTA". A VOLTA existe inteira (`eventos-remotos`,
 * `evento.doEventoDoGoogle`, o cron de sync). A IDA não tinha uma linha:
 *
 *     grep -rn "paraEventoDoGoogle" app lib workers components hooks
 *     # 2 linhas, AMBAS dentro de lib/agenda/google/evento.ts = ZERO call sites
 *     grep -rn 'method: "' lib/agenda/google/*.ts
 *     # 1 linha: token.ts (a troca OAuth) — nenhuma escrita de evento
 *
 * O tradutor estava escrito, testado e na prateleira. O schema também: a
 * `calendar_appointments` já tem `google_event_id`, `google_ical_uid`,
 * `google_sequence`, `google_synced_at` e `google_sync_error`. E o filtro
 * anti-eco do worker de leitura (`ehIcalUidNosso`) já pressupunha exatamente o
 * que não estava implementado — ele existia para ignorar eventos que nós
 * criaríamos, e nós nunca criávamos nenhum.
 *
 * ═══ POST para criar, PUT para atualizar — e a premissa que estava errada ═══
 *
 * ⚠️ ESTE PARÁGRAFO AFIRMAVA QUE `events.update` CRIA NUM ID QUE NÃO EXISTE.
 * **É FALSO, e custou a sincronização inteira.** Medido na VPS do dono (v1.9.1):
 * o cron devolveu `{"candidatos":3,"publicados":0,"falhas":3}` e as três linhas
 * gravaram `evento_sumiu: HTTP 404`. Nenhum compromisso jamais chegou ao Google,
 * e a tentativa se repetia a cada 5 minutos porque `google_event_id` continuava
 * nulo.
 *
 * O que a documentação oficial sustenta (conferido, não lembrado):
 *
 *   `events.insert` (POST) ACEITA o `id` no corpo — base32hex (a-v, 0-9), de 5 a
 *   1024 caracteres, único por calendário. É o que preserva a idempotência do id
 *   derivado.
 *     https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
 *
 *   Id que já existe devolve **409 `duplicate`**, e a ação que a própria doc
 *   sugere é: *"use the `events.update` method"*.
 *     https://developers.google.com/workspace/calendar/api/guides/errors
 *
 *   Sobre `events.update` exigir evento existente, a doc **não afirma nada** — o
 *   que a sustenta é o 404 do guia de erros ("has never existed") mais a medição
 *   da VPS. E upsert nativo numa chamada só: NÃO EXISTE na doc.
 *
 * Então o caminho é: POST primeiro; se 409, PUT. Que é o que está abaixo.
 *
 * ⚠️ E A DOC NÃO GARANTE O 409: *"we cannot guarantee that ID collisions will be
 * detected at event creation time"*. Por isso o POST só é tentado quando NÃO
 * temos `google_event_id` guardado — quem já foi publicado vai direto de PUT, e
 * não depende de uma colisão ser detectada para não duplicar.
 *
 * O id do Google aceita apenas [a-v0-9] e no mínimo 5 caracteres, então o uuid
 * do agendamento é normalizado: hífens fora e dígitos w–z remapeados. É função
 * pura e testável, e o teste mede a INVERSA (dois ids diferentes nunca colidem).
 */
import { classificarErroDoGoogle, type ClassificacaoDoErro } from "./erros";
import { paraEventoDoGoogle, SUFIXO_ICAL_UID, type AgendamentoParaGoogle } from "./evento";

const ENDERECO_DE_EVENTOS = "https://www.googleapis.com/calendar/v3/calendars";
const PRAZO_MS = 15_000;

export type EscritaNoGoogle =
  | { ok: true; eventoId: string; sequence: number | null }
  | { ok: false; classificacao: ClassificacaoDoErro; detalhe: string };

/**
 * O id do evento no Google, derivado do id do agendamento.
 *
 * O Google exige [a-v0-9]{5,1024}. Um uuid tem hífens e pode ter w–z? Não: hex
 * vai só até `f`. Então basta remover os hífens — mas o prefixo existe para que
 * o id seja RECONHECÍVEL como nosso ao olhar a agenda do cliente, e para não
 * colidir com id de outro sistema que também derive de uuid.
 */
export function idDeEventoDoGoogle(idDoAgendamento: string): string {
  const limpo = idDoAgendamento.toLowerCase().replace(/[^a-v0-9]/g, "");
  return `${PREFIXO}${limpo}`;
}

/**
 * O prefixo sai do MESMO lugar que a identidade iCal, e não de um literal aqui.
 *
 * ⚠️ Eu tinha escrito `deskcomm` cravado, e `tests/unit/branding.test.ts`
 * reprovou — corretamente: numa instalação de marca própria, um literal de marca
 * no código é vazamento. Mas a saída NÃO é resolver por `branding()`: o cabeçalho
 * de `SUFIXO_ICAL_UID` já mediu por quê — se a identidade saísse da marca
 * resolvida, todo evento criado ANTES de uma troca de marca deixaria de ser
 * reconhecido, e o sintoma seria compromisso fantasma ocupando horário, sem erro
 * nenhum.
 *
 * Então a identidade é fixa do PRODUTO, e existe uma fonte só para ela.
 */
const PREFIXO = SUFIXO_ICAL_UID.toLowerCase().replace(/[^a-v0-9]/g, "");

/**
 * `sendUpdates` — o parâmetro sem o qual convidar não convida ninguém.
 *
 * ⚠️ O DEFAULT DO GOOGLE É NÃO AVISAR. Mandar `attendees` no corpo e omitir este
 * parâmetro adiciona a pessoa ao evento EM SILÊNCIO: ela aparece na lista de
 * convidados do calendário do organizador e nunca recebe e-mail nenhum. O
 * sintoma seria o pior tipo — a tela diz "convidado adicionado", o evento mostra
 * o convidado, e a caixa de entrada do cliente segue vazia.
 *
 * `all` só é mandado quando há convidado de verdade. Num evento sem `attendees`
 * ele não teria a quem notificar, e a diferença não é cosmética: é o que mantém
 * "campo vazio ⇒ exatamente o comportamento de antes", byte a byte na URL.
 */
function comAviso(url: string, avisar: boolean): string {
  return avisar ? `${url}?sendUpdates=all` : url;
}

async function chamar(
  metodo: "POST" | "PUT" | "DELETE",
  accessToken: string,
  calendarId: string,
  eventoId: string | null,
  corpo?: unknown,
  avisarConvidados = false,
): Promise<Response> {
  // POST vai para a COLEÇÃO (`/events`) e leva o id no CORPO; PUT e DELETE vão
  // para o RECURSO (`/events/{id}`). Misturar os dois é o que produziria um
  // `PUT /events` sem id, que o Google recusa por outro motivo — e o erro
  // apontaria para o lugar errado.
  const base = `${ENDERECO_DE_EVENTOS}/${encodeURIComponent(calendarId)}/events`;
  const recurso = eventoId === null ? base : `${base}/${encodeURIComponent(eventoId)}`;
  const url = comAviso(recurso, avisarConvidados);
  return fetch(url, {
    method: metodo,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(corpo === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    signal: AbortSignal.timeout(PRAZO_MS),
    cache: "no-store",
  });
}

/**
 * Cria OU atualiza o evento — agora com o verbo certo para cada caso.
 *
 * `googleEventId` é o que o chamador JÁ tem guardado na linha
 * (`calendar_appointments.google_event_id`). Ele é a única resposta confiável
 * para "isto já existe lá?", e é por isso que ele entra na assinatura em vez de
 * ser adivinhado: a doc do Google não garante que uma colisão de id seja
 * detectada na criação, então depender do 409 para não duplicar seria apostar
 * num comportamento que a própria doc recusa prometer.
 *
 *   sem `googleEventId`  → POST (cria, com o id derivado no corpo)
 *   com `googleEventId`  → PUT  (atualiza o que já está lá)
 *   POST devolvendo 409  → o id já existe: cai para PUT (é a ação que a doc
 *                          sugere para `duplicate`)
 */
export async function publicarNoGoogle(
  accessToken: string,
  calendarId: string,
  agendamento: AgendamentoParaGoogle,
  googleEventId?: string | null,
): Promise<EscritaNoGoogle> {
  const eventoId = idDeEventoDoGoogle(agendamento.id);
  const corpoDoEvento = paraEventoDoGoogle(agendamento);
  // Derivado do CORPO, e não do input: é `paraEventoDoGoogle` quem decide se a
  // lista sobreviveu à tradução (participante sem e-mail lança lá, e lista vazia
  // não vira `attendees`). Perguntar ao corpo é perguntar ao que vai no fio.
  const temConvidados = (corpoDoEvento.attendees?.length ?? 0) > 0;

  /**
   * ⚠️ `iCalUID` NÃO VAI NO CORPO — e aqui não há mais o que remover.
   *
   * O `events.insert` recusa `id` e `iCalUID` juntos (400 "Invalid resource id
   * value."), e era o que fazia 100% dos compromissos falharem na ida ao
   * Google. O #518 consertou isso AQUI, tirando o campo do corpo do POST; a
   * `main` já tinha consertado na FONTE (#474): `paraEventoDoGoogle` deixou de
   * emitir `iCalUID`, e `CorpoDeEventoDoGoogle` deixou de declará-lo.
   *
   * Convergência independente, dois consertos do mesmo defeito. Fica o da
   * `main`, que é o mais forte: o campo não existe para ser esquecido em outro
   * call site. O destructuring do #518 virou código morto na resolução do merge
   * — `tsc` o reprovou (TS2339), porque a propriedade já não existe no tipo.
   *
   * O `id` é quem fica, e não é escolha de gosto: derivado do id do
   * agendamento, é o que torna a criação IDEMPOTENTE e o que sustenta o "POST,
   * e se 409 então PUT" descrito no cabeçalho deste arquivo. Sem ele, cada
   * batida do cron criaria um evento novo do mesmo compromisso.
   */

  /** Uma tentativa, já com a classificação do erro que ela produziu. */
  async function tentar(
    metodo: "POST" | "PUT",
  ): Promise<{ resposta: Response } | EscritaNoGoogle> {
    try {
      const resposta = await chamar(
        metodo,
        accessToken,
        calendarId,
        // POST manda o id NO CORPO, não na URL — é assim que `events.insert`
        // aceita id de quem cria.
        metodo === "POST" ? null : eventoId,
        // O corpo já não carrega `iCalUID` (ver o bloco acima). O POST só
        // acrescenta o `id`, que ele aceita de quem cria; o PUT vai sem ele
        // porque ali o id viaja na URL.
        metodo === "POST" ? { ...corpoDoEvento, id: eventoId } : corpoDoEvento,
        temConvidados,
      );
      return { resposta };
    } catch (erro) {
      return {
        ok: false,
        classificacao: classificarErroDoGoogle(erro, "sincronizar"),
        detalhe: erro instanceof Error ? erro.message : String(erro),
      };
    }
  }

  // Já publicado uma vez? Atualiza. Nunca publicado? Cria.
  const jaExisteLa = typeof googleEventId === "string" && googleEventId.length > 0;
  let primeira = await tentar(jaExisteLa ? "PUT" : "POST");
  if (!("resposta" in primeira)) return primeira;

  // 409 na criação significa que o id derivado já está no calendário — o evento
  // existe e o que falta é atualizá-lo. A doc do `duplicate` manda exatamente
  // isto: "use the events.update method".
  if (primeira.resposta.status === 409 && !jaExisteLa) {
    const segunda = await tentar("PUT");
    if (!("resposta" in segunda)) return segunda;
    primeira = segunda;
  }

  const resposta = primeira.resposta;
  if (!resposta.ok) {
    const cru = await resposta.json().catch(() => ({ status: resposta.status }));
    return {
      ok: false,
      // A OPERAÇÃO diz ao classificador como ler o 404, e as duas leituras são
      // opostas: num PUT de evento que tínhamos, 404 é "existia e sumiu" e pede
      // reconciliação; num POST, o evento nunca existiu e 404 só pode ser o
      // CALENDÁRIO que não existe. Classificar os dois como `evento_sumiu` foi o
      // que fez a VPS registrar três vezes um diagnóstico que não descrevia nada.
      classificacao: classificarErroDoGoogle(cru, jaExisteLa ? "sincronizar" : "criar"),
      // ─── O CORPO DO GOOGLE ENTRA NO DETALHE ───────────────────────────────
      //
      // Era só `HTTP ${status}`, e o corpo — já parseado em `cru`, uma linha
      // acima — era descartado. Medido em produção em 2026-09-01: o cron tentou
      // publicar dois agendamentos a cada 5 minutos durante horas, e todo o
      // registro que sobrou foi `HTTP 400`, repetido. Nada dizia QUAL campo o
      // Google recusou, então não havia como consertar sem adivinhar.
      //
      // `detalhe` já flui para o `logger.warn` do cron E para a coluna
      // `google_sync_error` — nenhum fio novo é preciso, só parar de jogar fora
      // o que já está na mão.
      //
      // Recortado em 300 caracteres: a mensagem do Google é curta e o que
      // interessa vem no começo; o resto encheria a coluna e o log sem
      // acrescentar. E `JSON.stringify` não vaza credencial — `cru` é a
      // resposta de erro, não a requisição.
      detalhe: `HTTP ${resposta.status} — ${JSON.stringify(cru).slice(0, 300)}`,
    };
  }
  const corpo = (await resposta.json().catch(() => ({}))) as { id?: string; sequence?: number };
  return {
    ok: true,
    eventoId: typeof corpo.id === "string" && corpo.id ? corpo.id : eventoId,
    sequence: typeof corpo.sequence === "number" ? corpo.sequence : null,
  };
}

/**
 * Apaga o evento lá. Cancelar aqui tem de sumir de lá — senão o horário segue
 * bloqueado na agenda pessoal de quem atende, e o efeito é o oposto do pedido.
 *
 * ⚠️ 404 e 410 são SUCESSO. O evento não existe mais: é exatamente o estado que
 * se queria. Tratá-los como erro faria o worker reencher a Central de avisos com
 * uma falha que não é falha — e o `classificarErroDoGoogle` já nomeia isso como
 * `ja_esta_feito`.
 *
 * ⚠️ AVISA SEMPRE, e este é o par obrigatório do convite. Desde que existe
 * convidado, cancelar em silêncio deixa uma reunião FANTASMA na agenda de quem
 * foi convidado: ele recebeu o convite, aceitou, e o compromisso segue lá para
 * sempre porque o cancelamento não o alcançou. É o defeito que o próprio convite
 * cria — não existia enquanto ninguém era convidado.
 *
 * Mandar `sendUpdates=all` num evento SEM convidado não notifica ninguém (não há
 * a quem), então a condicional que `publicarNoGoogle` faz não se paga aqui: ela
 * exigiria descobrir se havia convidado num evento que estamos apagando, e a
 * linha do nosso lado já pode ter perdido o e-mail.
 */
export async function apagarNoGoogle(
  accessToken: string,
  calendarId: string,
  idDoAgendamento: string,
): Promise<EscritaNoGoogle> {
  const eventoId = idDeEventoDoGoogle(idDoAgendamento);
  let resposta: Response;
  try {
    resposta = await chamar("DELETE", accessToken, calendarId, eventoId, undefined, true);
  } catch (erro) {
    return {
      ok: false,
      classificacao: classificarErroDoGoogle(erro, "apagar"),
      detalhe: erro instanceof Error ? erro.message : String(erro),
    };
  }
  if (resposta.ok || resposta.status === 404 || resposta.status === 410) {
    return { ok: true, eventoId, sequence: null };
  }
  const cru = await resposta.json().catch(() => ({ status: resposta.status }));
  return {
    ok: false,
    classificacao: classificarErroDoGoogle(cru, "apagar"),
    detalhe: `HTTP ${resposta.status}`,
  };
}

/**
 * Este evento do Google foi criado por NÓS? — o anti-eco, agora pelo id.
 *
 * ⚠️ SUBSTITUI `ehIcalUidNosso`, e a troca não é cosmética.
 *
 * O reconhecimento morava no sufixo `@deskcomm.app` do `iCalUID` que mandávamos
 * junto do evento. Só que mandar `iCalUID` e `id` juntos é o que o Google
 * recusava com `400 Invalid resource id value` — medido em produção em
 * 2026-09-01, a cada 5 minutos, por horas. Tirar o uid conserta a publicação e
 * deixaria o anti-eco cego: o Google gera `<id>@google.com`, que não termina no
 * nosso sufixo, e todo compromisso criado aqui voltaria pela sincronização como
 * ocupação de terceiro — bloqueando o próprio horário que ele já ocupa.
 *
 * O id serve melhor, e sempre serviu: ele é NOSSO por construção
 * (`idDeEventoDoGoogle`), o Google o preserva, e a rota de sincronização já tem
 * `external_event_id` na mão no mesmo ponto onde consultava o uid. A camada que
 * faltava já estava debaixo do nariz.
 *
 * ⚠️ Migrar não custou dados: NENHUM evento nosso jamais chegou ao Google, em
 * instalação nenhuma. Três eras de falha — filtro PostgREST inválido até a
 * v1.7.0, `evento_sumiu` na v1.9.1, e este 400 — estão documentadas no MANIFEST
 * e no cabeçalho deste arquivo. Não há legado com o uid antigo para reconhecer.
 */
export function ehEventoNosso(externalEventId: string | null | undefined): boolean {
  if (!externalEventId) return false;
  return externalEventId.toLowerCase().startsWith(PREFIXO);
}
