/**
 * A política de retenção — regra PURA, sem banco e sem env, para a poda da fila
 * e o expurgo da auditoria (issue #261).
 *
 * ─── Por que um módulo, e não `z.coerce.number()` em `lib/env.ts` ───────────
 *
 * `lib/env.ts` LANÇA quando o schema recusa, e no Next isso acontece na primeira
 * requisição — com healthcheck TCP puro, o contêiner fica `healthy` com 100% das
 * respostas em 500. É a mesma armadilha documentada em `AI_BUDGET_ENFORCEMENT`:
 * um `z.coerce.number().int().positive()` aqui transformaria
 * `JOB_QUEUE_RETENTION_DAYS=noventa` — digitado às 2h por quem está tentando
 * liberar espaço — no derrubador do produto inteiro. As duas chaves entram como
 * `z.string()` e são interpretadas AQUI, onde lixo resolve para o lado seguro.
 *
 * ─── O piso não é sugestão ──────────────────────────────────────────────────
 *
 * Este módulo devolve o número que o CHAMADOR pede ao banco; para a FILA e a
 * AUDITORIA o piso de verdade mora dentro de `fn_podar_fila_de_jobs` e
 * `fn_expurgar_auditoria_vencida` (`greatest(..., piso)`), porque só lá ele vale
 * para QUALQUER chamador — inclusive um `psql` na mão. Repeti-lo aqui serve para
 * outra coisa: para o operador ver no log que o valor dele foi elevado, em vez
 * de descobrir pela ausência de efeito. Os dois lados usam as mesmas constantes
 * deste arquivo, e `tests/invariants/retencao-poda-e-expurgo.test.ts` compara os
 * dois.
 *
 * ⚠️ A CAPTAÇÃO É A EXCEÇÃO, e por isso o aviso NÃO diz mais "o piso também é
 * aplicado dentro da função do banco": para `webhook_lead_captures` isso seria
 * FALSO. A poda dela é um DELETE do admin client (`lib/webhooks/retencao-da-
 * captacao.ts`), não uma `security definer` — não há função onde enfiar o piso,
 * e o alcance dele termina no TypeScript. Uma frase que promete uma proteção
 * inexistente é pior que a ausência da frase: ela faz quem lê parar de checar.
 */

/** 90 dias. Longe o bastante do horizonte em que "1º outbound" ainda diz algo. */
export const RETENCAO_FILA_DIAS_PADRAO = 90;
/** Piso da fila: abaixo disso a cascata em `send_ledger` alcança lead vivo. */
export const RETENCAO_FILA_DIAS_PISO = 7;
/** 1825 dias = os 5 anos da regra L-10 (`docs/business-rules`, L-10). */
export const RETENCAO_AUDITORIA_DIAS_PADRAO = 1825;
/** Piso da auditoria: o knob nunca vira apagador de rastro recente. */
export const RETENCAO_AUDITORIA_DIAS_PISO = 90;
/**
 * 365 dias para o HISTÓRICO de leads captados (`webhook_lead_captures`).
 *
 * Muito mais longo que a fila e mais curto que a auditoria, e as duas pontas
 * têm razão: a linha não é despejo de depuração (é o que a aba "Leads
 * recebidos" mostra, e a pergunta útil — "de qual campanha veio quem fechou?" —
 * é de meses atrás), mas também não é rastro legal de 5 anos. Um ano fiscal
 * inteiro, a ~1 kB por formulário: 300 leads/dia dão ~110 MB.
 */
/**
 * Quantos dias de PASSADO o espelho da agenda conectada guarda.
 *
 * `calendar_external_events` é cache do que o Google já tem: reconstruível pelo
 * sync, apagado em cascata quando a conexão sai. Sem prazo, "espelho" vira só um
 * nome mais simpático para um arquivo permanente de compromissos de terceiros —
 * guardado por um produto que declarou não ser o controlador daquele dado.
 *
 * O corte é por `ends_at`, nunca por `created_at`: compromisso futuro não
 * envelhece, e apagá-lo faria a agenda marcar em cima de hora ocupada.
 */
export const RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO = 90;

/**
 * Piso BAIXO de propósito, ao contrário do da auditoria.
 *
 * 90 dias de piso existem lá para o knob não virar apagador de rastro depois de
 * um incidente. Aqui é cache: quem quiser mais passado pede ao sync, que repõe.
 * Piso alto não protegeria ninguém — só guardaria mais tempo dado de terceiro.
 */
export const RETENCAO_ESPELHO_AGENDA_DIAS_PISO = 7;

export const RETENCAO_CAPTACAO_DIAS_PADRAO = 365;
/**
 * Piso da captação: o knob nunca vira apagador de ORIGEM.
 *
 * A tabela guarda de onde o contato veio — a página, o IP, a campanha, o
 * consentimento implícito de ter preenchido. Trinta dias é o mínimo em que essa
 * pergunta ainda tem chance de ser feita.
 *
 * ⚠️ DIFERENÇA DECLARADA em relação aos dois pisos acima: aqueles moram DENTRO
 * de uma função do banco (`greatest(..., piso)`), o que os faz valer até para
 * um `psql` na mão. Este mora no TypeScript que apaga
 * (`lib/webhooks/retencao-da-captacao.ts`), porque a poda da captação é um
 * DELETE do admin client, não uma `security definer` — não há função onde
 * enfiá-lo. O alcance é menor e está escrito aqui em vez de presumido.
 */
export const RETENCAO_CAPTACAO_DIAS_PISO = 30;

/**
 * 365 dias para a CONVERSA DO CASO (`agent_case_chat_messages`, migration 0281).
 *
 * Um ano fiscal de deliberação. Depois disso, "por que decidimos assim" é
 * respondido pelos EVENTOS do caso — que são o registro da decisão —, não pela
 * conversa que a precedeu. Guardar a deliberação para sempre seria manter
 * indefinidamente texto sobre uma pessoa identificável cuja utilidade acabou.
 */
export const RETENCAO_CONVERSA_DO_CASO_DIAS_PADRAO = 365;
/**
 * Piso da conversa do caso: 90 dias, o MESMO da auditoria e pela mesma razão.
 *
 * O knob nunca vira apagador de deliberação recente — a pergunta "quem decidiu
 * o quê, e com base em quê" ainda se faz três meses depois. O piso mora DENTRO
 * de `fn_expurgar_conversa_do_caso_vencida` (`greatest(...)` no corpo), o que o
 * faz valer para qualquer chamador, inclusive um `psql` na mão; a cópia aqui
 * serve para o operador ver no log que o valor dele foi elevado, em vez de
 * descobrir pela ausência de efeito.
 */
export const RETENCAO_CONVERSA_DO_CASO_DIAS_PISO = 90;

/**
 * 1825 dias (5 anos) para a PASSAGEM para uma pessoa
 * (`passagens_de_atendimento`, migration 0291).
 *
 * O mesmo horizonte da auditoria, e pela mesma razão: a passagem é rastro de
 * ATENDIMENTO — quem assumiu a conversa de quem, quando, por quê e quanto tempo
 * a pessoa esperou. É a linha que responde a uma reclamação de dois anos atrás,
 * e é de onde sai a medida de repetição que diz se o briefing serviu para
 * alguma coisa.
 */
export const RETENCAO_PASSAGEM_DIAS_PADRAO = 1825;
/**
 * Piso da passagem: 90 dias, o mesmo da auditoria.
 *
 * O knob nunca vira apagador de rastro recente. O piso mora DENTRO de
 * `fn_expurgar_passagens_vencidas` (`greatest(...)` no corpo), o que o faz valer
 * para qualquer chamador, inclusive um `psql` na mão; a cópia aqui serve para o
 * operador ver no log que o valor dele foi elevado, em vez de descobrir pela
 * ausência de efeito.
 *
 * ⚠️ O piso NÃO é a única proteção desta tabela, e a outra é mais forte: a
 * função só apaga linha com `reconhecido_em is not null`. Passagem aberta é
 * demanda viva — alguém do outro lado está esperando e ninguém assumiu — e
 * apagá-la por idade seria o expurgo virando esquecedor de pendência.
 */
export const RETENCAO_PASSAGEM_DIAS_PISO = 90;

/**
 * 180 dias para o REGISTRO DE ENTREGA do aviso de caso
 * (`entregas_de_aviso_de_caso`, migration 0292).
 *
 * Bem mais curto que a passagem e que a auditoria, e o motivo é a pergunta: a
 * única que esta tabela responde — "o aviso daquele caso saiu?" — é de semanas,
 * não de anos. Depois de seis meses o caso já foi resolvido ou abandonado, e o
 * que sobrou dele está nos EVENTOS do caso, que são o registro da decisão.
 *
 * A linha não guarda texto nenhum (só `corpo_hash`), então o que se poda aqui é
 * volume de operação, não relato de pessoa.
 */
export const RETENCAO_AVISO_DE_CASO_DIAS_PADRAO = 180;
/**
 * Piso do aviso: 30 dias — o mais baixo dos pisos com dono no SQL, e de
 * propósito.
 *
 * Os 90 dias da auditoria existem para o knob não virar apagador de RASTRO
 * LEGAL. Aqui o rastro é operacional, e o que o piso protege é outra coisa: o
 * incidente que ainda está sendo apurado. "Por que a equipe não foi avisada na
 * semana passada?" é uma pergunta de dias, não de trimestres — e um mês é o
 * mínimo em que ela ainda tem chance de ser feita.
 *
 * O piso mora DENTRO de `fn_expurgar_avisos_de_caso_vencidos`
 * (`greatest(...)` no corpo), o que o faz valer para qualquer chamador,
 * inclusive um `psql` na mão; a cópia aqui serve para o operador ver no log que
 * o valor dele foi elevado, em vez de descobrir pela ausência de efeito.
 */
export const RETENCAO_AVISO_DE_CASO_DIAS_PISO = 30;

/**
 * 365 dias para os CANDIDATOS da prospecção nativa (`prospecting_candidates`,
 * migration 0369; expurgo na 0408, issue #1313).
 *
 * Guarda nome, telefone, endereço e identificador de lugar — a pessoa que mais
 * cedo ou mais tarde vai ser abordada, e que em muitos casos nunca falou com a
 * empresa. Um ano é a decisão do dono do projeto (24/09/2026, PR #1577),
 * alinhado ao horizonte da conversa do caso e da captação: depois disso o
 * funil responde por EVENTOS, não por raspagem parada.
 *
 * Quem APLICA é `fn_expurgar_prospeccao_vencida` (migration 0408), chamada em
 * lotes pelo cron `data-retention` — e o piso mora DENTRO do corpo da função,
 * `greatest(...)`, como as sete irmãs: só assim ele vale para qualquer
 * chamador, inclusive um `psql` na mão.
 *
 * Duas guardas que a função impõe e esta declaração não pode expressar:
 * - `status not in ('queued','sending')` — trabalho vivo nunca entra no
 *   expurgo, em nenhuma idade;
 * - `suppression_salt is null` — os tokens de supressão (`suppression_salt`,
 *   `suppression_place`, `suppression_phone`) de quem exerceu opt-out/exclusão
 *   NUNCA são expurgados: é o tombstone que faz o trigger
 *   `prospecting_refuse_erased` barrar a reimportação futura da mesma pessoa.
 *   Expurgá-lo reabriria a porta que a anonimização (0370) fechou.
 */
export const RETENCAO_PROSPECCAO_DIAS_PADRAO = 365;
export const RETENCAO_PROSPECCAO_DIAS_PISO = 90;

/**
 * 90 dias para as OBSERVAÇÕES DO JEV (`jev_observacoes`, migration 0421).
 *
 * A linha não guarda texto de cliente — só os rótulos do Jev e do mecanismo de
 * hoje e se concordaram. Ela existe para uma pergunta só: "posso deixar o Jev
 * decidir esta tarefa?", respondida pela concordância recente. Três meses é
 * folga sobre a janela que o cartão mostra.
 *
 * Quem aplica é `fn_expurgar_observacoes_do_jev` (0421), em lotes pelo cron
 * `data-retention`, com o piso no CORPO da função, como as irmãs.
 */
export const RETENCAO_OBSERVACOES_DO_JEV_DIAS_PADRAO = 90;
/**
 * Piso de 30 dias: a janela da concordância no cartão
 * (`app/api/v1/ai/jev/route.ts`). Abaixo dela o cartão continuaria dizendo
 * "nos últimos 30 dias" contando menos do que isso.
 */
export const RETENCAO_OBSERVACOES_DO_JEV_DIAS_PISO = 30;


export interface RetencaoInterpretada {
  /** Dias a pedir ao banco. Nunca abaixo do piso, nunca `NaN`. */
  readonly dias: number;
  /**
   * Frase pronta em pt-BR quando o valor do operador NÃO foi usado como escrito.
   * `null` quando a chave está ausente (o caso normal) ou foi aceita inteira.
   * Nunca a frase tranquilizadora: se o número dele não valeu, o log diz.
   */
  readonly aviso: string | null;
}

/**
 * Interpreta o valor cru de uma variável de ambiente de retenção.
 *
 * Ausente ou vazio → o padrão, sem aviso (é o caminho de toda instalação que
 * nunca editou `.env`, e a doutrina de packaging exige que ele funcione).
 * Não-numérico, zero ou negativo → o padrão, COM aviso.
 * Abaixo do piso → o piso, COM aviso.
 */
export function interpretarRetencao(
  bruto: string | undefined,
  opcoes: { readonly chave: string; readonly padrao: number; readonly piso: number },
): RetencaoInterpretada {
  const texto = (bruto ?? "").trim();
  if (texto === "") return { dias: opcoes.padrao, aviso: null };

  // `Number()` e não `parseInt`: `parseInt("90dias")` devolve 90 em silêncio, e
  // aceitar sufixo faria `JOB_QUEUE_RETENTION_DAYS=90d` virar 90 sem o operador
  // saber que o `d` foi ignorado. Aqui ele é lixo, e lixo tem aviso.
  const numero = Number(texto);
  if (!Number.isFinite(numero) || !Number.isInteger(numero) || numero <= 0) {
    return {
      dias: opcoes.padrao,
      aviso:
        `${opcoes.chave}="${texto}" não é um número inteiro de dias — ` +
        `usando o padrão de ${opcoes.padrao} dias.`,
    };
  }

  if (numero < opcoes.piso) {
    return {
      dias: opcoes.piso,
      aviso:
        `${opcoes.chave}=${numero} está abaixo do piso de ${opcoes.piso} dias — ` +
        `usando ${opcoes.piso}.`,
    };
  }

  return { dias: numero, aviso: null };
}
