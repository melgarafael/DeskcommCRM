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
  } = {},
) {
  const avisados = new Set<string>();
  const enviadas: Array<{ chave: string; body: string }> = [];
  const registrosDePacing: number[] = [];

  const deps: PortasDoAviso = {
    leContato: async () =>
      parcial.contato === undefined ? contato() : parcial.contato,
    ehNumeroInterno: async () => parcial.ehNumeroInterno ?? false,
    jaAvisado: async (_org, _contactId, chave) => avisados.has(chave),
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

  return { deps, enviadas, registrosDePacing };
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
});
