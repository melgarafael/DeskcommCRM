/**
 * #1926 — aviso de fora do horário de atendimento: uma vez por contato por
 * período fechado.
 *
 * Os quatro cenários da issue, exercitados pela ORQUESTRAÇÃO (portas falsas
 * que gravam o que foi enviado), não só pela regra pura — assim o teste prova
 * que a chave de dedupe é a mesma que o envio grava, e não que duas funções
 * concordam entre si:
 *
 *   1. fora da janela ⇒ avia UMA vez;
 *   2. dentro da janela ⇒ NÃO avisa (a IA responde);
 *   3. segundo contato no MESMO período fechado ⇒ não repete;
 *   4. opt-out (`contacts.is_blocked`) ⇒ não recebe.
 *
 * As réguas que a issue proíbe de furar (LGPD, número interno, teto de envio)
 * entram como casos próprios, e `inicioDoPeriodoFechado` é testada porque é
 * ela que define quando um período novo começa.
 */
import { describe, expect, it } from 'vitest';

import {
  chaveDoAviso,
  decideAvisoForaDoHorario,
  enviaAvisoForaDoHorario,
  lerTextoDoAvisoForaDoHorario,
  type ContatoDoAviso,
  type EntradaDoAviso,
  type PortasDoAviso,
} from '@/lib/agent-engine/agent/aviso-fora-do-horario';
import {
  inicioDoPeriodoFechado,
  type JanelaDeAtendimento,
} from '@/lib/agent-engine/agent/janela-de-atendimento';
import { versionPatchSchema } from '@/lib/ai/agents/validation';
import { FERIADOS_DESLIGADOS, feriadoDoDia } from '@/lib/tempo/feriados';

/** Segunda a sexta, 8h–18h em São Paulo (BRT = UTC-3). */
const JANELA: JanelaDeAtendimento = {
  timezone: 'America/Sao_Paulo',
  start: '08:00',
  end: '18:00',
  weekdays: [1, 2, 3, 4, 5],
};

const TEXTO = 'Recebemos sua mensagem e respondemos no próximo horário de atendimento.';

/** Quarta 07/10/2026 22:00 BRT — fora da janela. */
const QUARTA_NOITE = new Date('2026-10-08T01:00:00Z');
/** Quarta 07/10/2026 10:00 BRT — dentro da janela. */
const QUARTA_DE_MANHA = new Date('2026-10-07T13:00:00Z');
/** Quinta 08/10/2026 22:00 BRT — fora da janela, PERÍODO NOVO. */
const QUINTA_NOITE = new Date('2026-10-09T01:00:00Z');

/**
 * #3877 — feriado nacional com a janela semanal ABERTA o dia inteiro.
 *
 * 02/11/2026 (Finados) é segunda-feira: a janela seg–sex 08–18 diria "aberto",
 * e é exatamente aí que o aviso prometia atendimento num dia em que a loja não
 * abre. 19:00 BRT é fora da janela ⇒ é quando o aviso existe.
 */
const FINADOS_19H = new Date('2026-11-02T22:00:00Z');
/** 02/11/2026 10:00 BRT — feriado, mas DENTRO da janela semanal (controle). */
const FINADOS_10H = new Date('2026-11-02T13:00:00Z');
/** Terça 03/11/2026 19:00 BRT — dia útil, fora da janela. */
const TERCA_19H = new Date('2026-11-03T22:00:00Z');

/** O texto próprio de feriado (#3877) — o que a organização configura. */
const TEXTO_FERIADO =
  'Hoje é feriado nacional e a loja está fechada. Respondemos no próximo dia útil.';

function contato(parcial: Partial<ContatoDoAviso> = {}): ContatoDoAviso {
  return {
    isBlocked: false,
    forceHuman: false,
    isAnonymized: false,
    phoneNumber: '+5511999990000',
    ...parcial,
  };
}

function entrada(agora: Date, parcial: Partial<EntradaDoAviso> = {}): EntradaDoAviso {
  return {
    organizationId: 'org-1',
    conversationId: 'conv-1',
    contactId: 'lead-1',
    channelSessionId: 'cs-1',
    texto: TEXTO,
    janela: JANELA,
    agora,
    ...parcial,
  };
}

/**
 * Portas falsas com MEMÓRIA: `envia` grava a chave no MESMO conjunto que
 * `jaAvisado` lê — é o contrato do dedupe (quem envia é quem passa a dizer
 * "já avisado"), então o teste de repetição pega divergência entre as duas.
 */
function portasFalsas(
  parcial: {
    contato?: ContatoDoAviso | null;
    ehNumeroInterno?: boolean;
    pacingLiberado?: boolean;
    /** #3877 — o que o calendário responde para a data pedida. */
    feriado?: string | null;
  } = {},
) {
  const avisados = new Set<string>();
  const enviadas: Array<{ chave: string; body: string }> = [];
  const registrosDePacing: number[] = [];
  /** Quantas vezes o calendário foi consultado — o custo que a retrocompat promete não ter. */
  let consultas = 0;

  const deps: PortasDoAviso = {
    leContato: async () =>
      parcial.contato === undefined ? contato() : parcial.contato,
    ehNumeroInterno: async () => parcial.ehNumeroInterno ?? false,
    jaAvisado: async (_org, _contactId, chave) => avisados.has(chave),
    feriadoNoDia: async () => {
      consultas += 1;
      return parcial.feriado ?? null;
    },
    pacing: {
      decide: async () =>
        parcial.pacingLiberado === false
          ? { liberado: false, motivo: 'daily_cap' }
          : { liberado: true },
      registraEnvio: async () => {
        registrosDePacing.push(registrosDePacing.length + 1);
      },
    },
    envia: async (e) => {
      avisados.add(e.chave);
      enviadas.push({ chave: e.chave, body: e.body });
    },
  };

  return {
    deps,
    enviadas,
    registrosDePacing,
    /** Função, não valor: quem lê quer o número DEPOIS dos awaits. */
    leiturasDeCalendario: () => consultas,
  };
}

describe('fora do horário de atendimento: o aviso (#1926)', () => {
  it('fora da janela, primeiro contato ⇒ avia NA HORA e conta no pacing', async () => {
    const { deps, enviadas, registrosDePacing } = portasFalsas();

    const decisao = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));

    expect(decisao).toEqual({ enviar: true, texto: TEXTO });
    expect(enviadas).toHaveLength(1);
    expect(enviadas[0]?.body).toBe(TEXTO);
    // A chave carrega o início do período fechado (quarta 18:00 BRT).
    expect(enviadas[0]?.chave).toBe(
      chaveDoAviso('lead-1', new Date('2026-10-07T21:00:00Z')),
    );
    // Gastou uma mensagem do número: entra no ledger como qualquer resposta.
    expect(registrosDePacing).toHaveLength(1);
  });

  it('dentro da janela ⇒ NÃO avisa (a IA responde no turno)', async () => {
    const { deps, enviadas } = portasFalsas();

    const decisao = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_DE_MANHA));

    expect(decisao).toEqual({ enviar: false, motivo: 'dentro_da_janela' });
    expect(enviadas).toHaveLength(0);
  });

  it('segundo contato no MESMO período fechado ⇒ não repete', async () => {
    const { deps, enviadas } = portasFalsas();

    const primeiro = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));
    const segundo = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));
    // Três minutos depois, ainda no mesmo período, outro contato tenta de novo.
    const terceiro = await enviaAvisoForaDoHorario(
      deps,
      entrada(new Date('2026-10-08T01:03:00Z')),
    );

    expect(primeiro.enviar).toBe(true);
    expect(segundo).toEqual({ enviar: false, motivo: 'ja_avisado_no_periodo' });
    expect(terceiro).toEqual({ enviar: false, motivo: 'ja_avisado_no_periodo' });
    expect(enviadas).toHaveLength(1);
  });

  it('período NOVO (a janela abriu e fechou de novo) ⇒ avia outra vez', async () => {
    const { deps, enviadas } = portasFalsas();

    await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));
    const noDiaSeguinte = await enviaAvisoForaDoHorario(deps, entrada(QUINTA_NOITE));

    expect(noDiaSeguinte.enviar).toBe(true);
    expect(enviadas).toHaveLength(2);
    expect(enviadas[0]?.chave).not.toBe(enviadas[1]?.chave);
  });

  it('opt-out (contacts.is_blocked) ⇒ NÃO recebe, nem no período novo', async () => {
    const { deps, enviadas } = portasFalsas({ contato: contato({ isBlocked: true }) });

    const noPeriodoUm = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));
    const noPeriodoDois = await enviaAvisoForaDoHorario(deps, entrada(QUINTA_NOITE));

    expect(noPeriodoUm).toEqual({ enviar: false, motivo: 'opt_out' });
    expect(noPeriodoDois).toEqual({ enviar: false, motivo: 'opt_out' });
    expect(enviadas).toHaveLength(0);
  });

  it('força-humano também é opt-out (mesma régua da cadeia de envio)', async () => {
    const { deps, enviadas } = portasFalsas({ contato: contato({ forceHuman: true }) });

    const decisao = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));

    expect(decisao).toEqual({ enviar: false, motivo: 'opt_out' });
    expect(enviadas).toHaveLength(0);
  });

  it('titular anonimizado (LGPD) ⇒ NÃO recebe', async () => {
    const { deps, enviadas } = portasFalsas({ contato: contato({ isAnonymized: true }) });

    const decisao = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));

    expect(decisao).toEqual({ enviar: false, motivo: 'titular_anonimizado' });
    expect(enviadas).toHaveLength(0);
  });

  it('número interno (conexão da própria organização) ⇒ NÃO recebe', async () => {
    const { deps, enviadas } = portasFalsas({ ehNumeroInterno: true });

    const decisao = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));

    expect(decisao).toEqual({ enviar: false, motivo: 'numero_interno' });
    expect(enviadas).toHaveLength(0);
  });

  it('teto de envio batido (pacing vetou) ⇒ não envia e não conta como enviado', async () => {
    const { deps, enviadas, registrosDePacing } = portasFalsas({ pacingLiberado: false });

    const decisao = await enviaAvisoForaDoHorario(deps, entrada(QUARTA_NOITE));

    expect(decisao).toEqual({ enviar: false, motivo: 'pacing:daily_cap' });
    expect(enviadas).toHaveLength(0);
    expect(registrosDePacing).toHaveLength(0);
  });

  it('texto não configurado ⇒ não envia frase inventada', async () => {
    const { deps, enviadas } = portasFalsas();

    const semTexto = await enviaAvisoForaDoHorario(
      deps,
      entrada(QUARTA_NOITE, { texto: null }),
    );
    const vazio = await enviaAvisoForaDoHorario(
      deps,
      entrada(QUARTA_NOITE, { texto: '   ' }),
    );

    expect(semTexto).toEqual({ enviar: false, motivo: 'sem_configuracao' });
    expect(vazio).toEqual({ enviar: false, motivo: 'sem_configuracao' });
    expect(enviadas).toHaveLength(0);
  });

  it('sem janela de atendimento ⇒ não existe "fora dela"', async () => {
    const { deps, enviadas } = portasFalsas();

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(QUARTA_NOITE, { janela: null }),
    );

    expect(decisao).toEqual({ enviar: false, motivo: 'sem_janela' });
    expect(enviadas).toHaveLength(0);
  });

  it('sem contato lido ⇒ não envia para endereço desconhecido', () => {
    const decisao = decideAvisoForaDoHorario({
      janela: JANELA,
      agora: QUARTA_NOITE,
      texto: TEXTO,
      contato: null,
      ehNumeroInterno: false,
      jaAvisado: false,
    });

    expect(decisao).toEqual({ enviar: false, motivo: 'contato_inexistente' });
  });
});

describe('período fechado — a régua de "uma vez por período"', () => {
  it('começa no ÚLTIMO fechamento da janela (quarta 18:00 BRT)', () => {
    expect(inicioDoPeriodoFechado(JANELA, QUARTA_NOITE)).toEqual(
      new Date('2026-10-07T21:00:00Z'),
    );
  });

  it('antes da abertura de hoje, o período é o de ONTEM', () => {
    // Quarta 07:00 BRT — a janela de hoje ainda não abriu.
    expect(inicioDoPeriodoFechado(JANELA, new Date('2026-10-07T10:00:00Z'))).toEqual(
      new Date('2026-10-06T21:00:00Z'),
    );
  });

  it('no fim de semana o período começa na sexta, quando a janela fechou', () => {
    // Domingo 11/10 10:00 BRT: sábado não tem janela.
    expect(inicioDoPeriodoFechado(JANELA, new Date('2026-10-11T13:00:00Z'))).toEqual(
      new Date('2026-10-09T21:00:00Z'),
    );
  });

  it('dois instantes do MESMO período, com segundos diferentes, dão a MESMA chave', async () => {
    // Quarta 22:03:17.412 e 22:40:42.900 BRT. Se o início do período herdar os
    // segundos de `agora`, a chave muda a cada mensagem e o dedupe nunca casa:
    // com debounce 0 (ou job em hold) cada mensagem viraria um aviso novo.
    const primeiro = new Date('2026-10-08T01:03:17.412Z');
    const segundo = new Date('2026-10-08T01:40:42.900Z');

    expect(inicioDoPeriodoFechado(JANELA, primeiro)).toEqual(new Date('2026-10-07T21:00:00Z'));
    expect(inicioDoPeriodoFechado(JANELA, segundo)).toEqual(new Date('2026-10-07T21:00:00Z'));

    const { deps, enviadas } = portasFalsas();
    await enviaAvisoForaDoHorario(deps, entrada(primeiro));
    const repetida = await enviaAvisoForaDoHorario(deps, entrada(segundo));

    expect(repetida).toEqual({ enviar: false, motivo: 'ja_avisado_no_periodo' });
    expect(enviadas).toHaveLength(1);
  });

  it('cada período gera chave própria', () => {
    const um = chaveDoAviso('lead-1', new Date('2026-10-07T21:00:00Z'));
    const dois = chaveDoAviso('lead-1', new Date('2026-10-08T21:00:00Z'));
    const outroContato = chaveDoAviso('lead-2', new Date('2026-10-07T21:00:00Z'));

    expect(um).not.toBe(dois);
    expect(um).not.toBe(outroContato);
    expect(um).toContain('lead-1');
  });
});

describe('texto configurável pela organização', () => {
  it('lê filters.business_hours.notice', () => {
    expect(
      lerTextoDoAvisoForaDoHorario({
        filters: { business_hours: { notice: `  ${TEXTO}  ` } },
      }),
    ).toBe(TEXTO);
  });

  it('a API que salva a versão PRESERVA o texto (o Zod não o descarta)', () => {
    // É o schema da rota PATCH /versions/[vid], por onde a tela salva. Sem o
    // campo declarado, o parse devolvia business_hours sem `notice` e o aviso
    // nunca ligava pela tela.
    const parsed = versionPatchSchema.safeParse({
      trigger_config: {
        filters: {
          business_hours: {
            timezone: 'America/Sao_Paulo',
            start: '08:00',
            end: '18:00',
            weekdays: [1, 2, 3, 4, 5],
            notice: TEXTO,
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(lerTextoDoAvisoForaDoHorario(parsed.data?.trigger_config)).toBe(TEXTO);
  });

  it('vazio, ausente ou com shape torto ⇒ null (não avisa, não inventa)', () => {
    expect(lerTextoDoAvisoForaDoHorario(null)).toBeNull();
    expect(lerTextoDoAvisoForaDoHorario({})).toBeNull();
    expect(lerTextoDoAvisoForaDoHorario({ filters: { business_hours: null } })).toBeNull();
    expect(
      lerTextoDoAvisoForaDoHorario({ filters: { business_hours: { notice: '   ' } } }),
    ).toBeNull();
    expect(
      lerTextoDoAvisoForaDoHorario({ filters: { business_hours: { notice: 42 } } }),
    ).toBeNull();
  });

  it('lê filters.business_hours.notice_feriado com o MESMO trim e o mesmo teto (#3877)', () => {
    const cfg = {
      filters: {
        business_hours: {
          notice: TEXTO,
          notice_feriado: `  ${TEXTO_FERIADO}  `,
        },
      },
    };

    expect(lerTextoDoAvisoForaDoHorario(cfg, 'notice_feriado')).toBe(TEXTO_FERIADO);
    // O teto é o do aviso, não um limite novo: 1001 caracteres viram 1000 —
    // e o mesmo `notice` de sempre continua sendo lido pela chave padrão.
    const longo = 'a'.repeat(1001);
    expect(
      lerTextoDoAvisoForaDoHorario(
        { filters: { business_hours: { notice_feriado: longo } } },
        'notice_feriado',
      ),
    ).toHaveLength(1000);
    expect(lerTextoDoAvisoForaDoHorario(cfg)).toBe(TEXTO);
    // Ausente ou vazio ⇒ null, a mesma direção segura do `notice`.
    expect(
      lerTextoDoAvisoForaDoHorario({ filters: { business_hours: { notice: TEXTO } } }, 'notice_feriado'),
    ).toBeNull();
    expect(
      lerTextoDoAvisoForaDoHorario(
        { filters: { business_hours: { notice_feriado: '   ' } } },
        'notice_feriado',
      ),
    ).toBeNull();
  });

  it('a API que salva a versão também PRESERVA o texto de feriado', () => {
    // Mesmo motivo da linha do `notice`: schema `.strict()` + campo não
    // declarado = o campo é descartado no parse e some do banco ao salvar.
    const parsed = versionPatchSchema.safeParse({
      trigger_config: {
        filters: {
          business_hours: {
            timezone: 'America/Sao_Paulo',
            start: '08:00',
            end: '18:00',
            weekdays: [1, 2, 3, 4, 5],
            notice: TEXTO,
            notice_feriado: TEXTO_FERIADO,
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(lerTextoDoAvisoForaDoHorario(parsed.data?.trigger_config, 'notice_feriado')).toBe(
      TEXTO_FERIADO,
    );
  });
});

/**
 * #3877 — o aviso sabe que HOJE é feriado nacional.
 *
 * O pedido da issue é o de uma sexta (Finados caindo numa segunda): o aviso
 * prometia "o próximo horário de atendimento" para um dia em que a loja não
 * abre. A prova é de ORQUESTRAÇÃO, com data fixa e fuso de America/Sao_Paulo:
 * portas falsas gravam o texto que sairia pelo canal.
 *
 * Duas fronteiras que o teste fixa, e que são o desenho da fatia:
 *
 *   - feriado NÃO fecha a janela semanal. Às 10:00 de um feriado o turno não é
 *     adiado (o agente responde), então não há aviso — e isso é o de hoje. Fazer
 *     o feriado fechar a janela silenciaria o agente em todo feriado, o que é
 *     outra entrega e outra retrocompatibilidade;
 *   - sem `notice_feriado` o calendário NEM É CONSULTADO: o texto e o custo do
 *     aviso de quem não configurou são exatamente os de antes.
 */
describe('feriado nacional no aviso (#3877)', () => {
  it('a régua é o calendário que já existe: 02/11/2026 é Finados, 03/11 não', () => {
    // `feriadoDoDia` é o MESMO leitor do bloco `## Agora` (régua dos nacionais:
    // `isHolidayBR`). Se estas duas linhas mudarem, a fixture do teste é que
    // está errada — não a implementação.
    expect(feriadoDoDia('2026-11-02', FERIADOS_DESLIGADOS)).toBe('Finados');
    expect(feriadoDoDia('2026-11-03', FERIADOS_DESLIGADOS)).toBeNull();
  });

  it('feriado + notice_feriado configurado ⇒ envia o texto de FERIADO', async () => {
    const { deps, enviadas, leiturasDeCalendario } = portasFalsas({ feriado: 'Finados' });

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(FINADOS_19H, { textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(decisao).toEqual({ enviar: true, texto: TEXTO_FERIADO });
    expect(enviadas).toHaveLength(1);
    expect(enviadas[0]?.body).toBe(TEXTO_FERIADO);
    expect(enviadas[0]?.body).not.toBe(TEXTO);
    // O calendário foi perguntado UMA vez, com a data do aviso.
    expect(leiturasDeCalendario()).toBe(1);
  });

  it('feriado SEM notice_feriado ⇒ o texto é o notice de hoje, byte a byte', async () => {
    // A prova dura de retrocompatibilidade: além do texto, o calendário não é
    // lido nenhuma vez. Nenhum turno de quem não configurou paga I/O novo.
    const { deps, enviadas, leiturasDeCalendario } = portasFalsas({ feriado: 'Finados' });

    const decisao = await enviaAvisoForaDoHorario(deps, entrada(FINADOS_19H));

    expect(decisao).toEqual({ enviar: true, texto: TEXTO });
    expect(enviadas[0]?.body).toBe(TEXTO);
    expect(leiturasDeCalendario()).toBe(0);
  });

  it('dia útil com notice_feriado configurado ⇒ envia o notice (feriado não vaza)', async () => {
    const { deps, enviadas } = portasFalsas({ feriado: null });

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(TERCA_19H, { textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(decisao).toEqual({ enviar: true, texto: TEXTO });
    expect(enviadas[0]?.body).toBe(TEXTO);
  });

  it('feriado + opt-out ⇒ NADA é enviado (a régua dura não abre exceção)', async () => {
    const { deps, enviadas } = portasFalsas({
      feriado: 'Finados',
      contato: contato({ isBlocked: true }),
    });

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(FINADOS_19H, { textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(decisao).toEqual({ enviar: false, motivo: 'opt_out' });
    expect(enviadas).toHaveLength(0);
  });

  it('feriado + pacing vetado ⇒ não envia (feriado não fura o anti-ban)', async () => {
    const { deps, enviadas } = portasFalsas({
      feriado: 'Finados',
      pacingLiberado: false,
    });

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(FINADOS_19H, { textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(decisao).toEqual({ enviar: false, motivo: 'pacing:daily_cap' });
    expect(enviadas).toHaveLength(0);
  });

  it('feriado DENTRO da janela semanal (10:00) ⇒ não há aviso: o turno não é adiado', async () => {
    // Comportamento MEDIDO e mantido nesta fatia: quem decide o aviso é a
    // janela semanal. Fazer o feriado fechá-la é outra entrega (silenciaria o
    // agente no feriado inteiro) e está declarado no PR.
    const { deps, enviadas, leiturasDeCalendario } = portasFalsas({ feriado: 'Finados' });

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(FINADOS_10H, { textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(decisao).toEqual({ enviar: false, motivo: 'dentro_da_janela' });
    expect(enviadas).toHaveLength(0);
    expect(leiturasDeCalendario()).toBe(0);
  });

  it('só notice_feriado configurado, em dia útil ⇒ sem_configuracao (não inventa)', async () => {
    const { deps, enviadas } = portasFalsas({ feriado: null });

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(TERCA_19H, { texto: null, textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(decisao).toEqual({ enviar: false, motivo: 'sem_configuracao' });
    expect(enviadas).toHaveLength(0);
  });

  it('só notice_feriado configurado, em FERIADO ⇒ o texto de feriado basta', async () => {
    const { deps, enviadas } = portasFalsas({ feriado: 'Finados' });

    const decisao = await enviaAvisoForaDoHorario(
      deps,
      entrada(FINADOS_19H, { texto: null, textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(decisao).toEqual({ enviar: true, texto: TEXTO_FERIADO });
    expect(enviadas).toHaveLength(1);
  });

  it('o dedupe por período continua valendo no feriado (uma vez por contato)', async () => {
    const { deps, enviadas } = portasFalsas({ feriado: 'Finados' });

    const primeiro = await enviaAvisoForaDoHorario(
      deps,
      entrada(FINADOS_19H, { textoDeFeriado: TEXTO_FERIADO }),
    );
    const segundo = await enviaAvisoForaDoHorario(
      deps,
      entrada(FINADOS_19H, { textoDeFeriado: TEXTO_FERIADO }),
    );

    expect(primeiro.enviar).toBe(true);
    expect(segundo).toEqual({ enviar: false, motivo: 'ja_avisado_no_periodo' });
    expect(enviadas).toHaveLength(1);
  });
});
