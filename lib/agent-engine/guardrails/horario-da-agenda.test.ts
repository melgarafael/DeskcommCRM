import { describe, expect, it } from 'vitest';

import {
  afirmaQueMarcou,
  avaliarHorarios,
  colherDaFerramenta,
  horariosCitados,
  marcouComSucesso,
  type HorariosDaAgenda,
} from './horario-da-agenda';

const FUSO = 'America/Sao_Paulo';
// Terça, 27/10/2026, 19h17 em São Paulo — o turno do Lorenzo.
const AGORA = new Date('2026-10-27T22:17:00Z');

const base = (p: Partial<HorariosDaAgenda> = {}): HorariosDaAgenda => ({
  ativo: true,
  fuso: FUSO,
  livres: [],
  doContato: [],
  marcouNesteTurno: false,
  vetosAnteriores: 0,
  ...p,
});

describe('horariosCitados', () => {
  it('liga cada horário à data mais próxima antes dele', () => {
    const c = horariosCitados('📅 Terça, 03/11: 9h, 9h15 · noite 19h 📅 Quarta, 04/11: 10:30', AGORA, FUSO);
    expect(c.map((x) => x.rotulo)).toEqual(['03/11 9h', '03/11 9h15', '03/11 19h', '04/11 10h30']);
    expect(new Date(c[1]!.instante).toISOString()).toBe('2026-11-03T12:15:00.000Z');
  });

  it('mensagem de agendamento: hora na linha de baixo da única data', () => {
    const c = horariosCitados('📅 terça-feira, 03/11\n🕒 11:00\n💻 Google Meet', AGORA, FUSO);
    expect(c.map((x) => x.rotulo)).toEqual(['03/11 11h']);
  });

  it('sem data DD/MM não há o que conferir', () => {
    expect(horariosCitados('Tenho às 9h15 na terça', AGORA, FUSO)).toEqual([]);
  });

  it('janeiro citado em outubro é do ano que vem', () => {
    const [c] = horariosCitados('📅 05/01: 9h', AGORA, FUSO);
    expect(new Date(c!.instante).getUTCFullYear()).toBe(2027);
  });
});

describe('afirmaQueMarcou', () => {
  it.each([
    'Ótimo, Lorenzo! Sua teleconsulta com o Dr. Fillipe Agra está agendada: 📅 terça-feira, 03/11',
    'Tudo certo, Renan! Sua teleconsulta com o Dr. Fillipe Agra está confirmada',
    'Sua consulta ficou marcada para quinta.',
  ])('reconhece confirmação: %s', (t) => expect(afirmaQueMarcou(t)).toBe(true));

  it.each([
    'Ótimo, vou reservar terça, 03/11, às 11h para você.',
    'Sua consulta ainda não está confirmada.',
    'As próximas datas disponíveis para teleconsulta são: 03/11 11h',
  ])('não confunde com confirmação: %s', (t) => expect(afirmaQueMarcou(t)).toBe(false));
});

describe('avaliarHorarios', () => {
  const THALES =
    'As próximas datas disponíveis para teleconsulta são: 📅 Terça, 03/11: 9h, 9h15, 10h, 11h';
  const LIVRES_0311 = ['2026-11-03T14:00:00.000Z']; // só 11h livre

  it('caso Thales: veta os horários que a busca não devolveu', () => {
    const v = avaliarHorarios(THALES, AGORA, base({ livres: LIVRES_0311 }));
    expect(v.pass).toBe(false);
    if (!v.pass) {
      expect(v.code).toBe('horario_sem_fonte');
      expect(v.reason).toContain('03/11 9h, 03/11 9h15, 03/11 10h');
      expect(v.reason).not.toContain('11h,');
    }
  });

  it('lista copiada da busca passa', () => {
    expect(avaliarHorarios('📅 Terça, 03/11: 11h', AGORA, base({ livres: LIVRES_0311 })).pass).toBe(true);
  });

  it('caso Lorenzo: "está agendada" sem marcação gravada é vetado', () => {
    const t = 'Ótimo, Lorenzo! Sua teleconsulta está agendada: 📅 terça-feira, 03/11 🕒 11:00';
    const v = avaliarHorarios(t, AGORA, base({ livres: LIVRES_0311 }));
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe('agenda_confirmou_sem_marcar');
  });

  it('confirmação depois de marcar com sucesso passa', () => {
    const t = 'Pronto, Lorenzo! Sua teleconsulta está agendada: 📅 terça-feira, 03/11 🕒 11:00';
    expect(
      avaliarHorarios(t, AGORA, base({ marcouNesteTurno: true, doContato: ['2026-11-03T14:00:00Z'] })).pass,
    ).toBe(true);
  });

  it('lembrar a consulta que o paciente já tem passa', () => {
    const t = 'Sua teleconsulta está confirmada: 📅 quinta, 29/10 🕒 10h';
    expect(avaliarHorarios(t, AGORA, base({ doContato: ['2026-10-29T13:00:00Z'] })).pass).toBe(true);
  });

  it('confirmar data diferente da consulta existente é vetado', () => {
    const t = 'Sua teleconsulta está confirmada: 📅 quinta, 29/10 🕒 11h';
    expect(avaliarHorarios(t, AGORA, base({ doContato: ['2026-10-29T13:00:00Z'] })).pass).toBe(false);
  });

  it('na 3ª tentativa o ensino manda passar para a equipe', () => {
    const v = avaliarHorarios(THALES, AGORA, base({ livres: LIVRES_0311, vetosAnteriores: 2 }));
    expect(!v.pass && v.reason).toContain('chame a ferramenta de passar para um humano');
  });

  it('desarmado não faz nada', () => {
    expect(avaliarHorarios(THALES, AGORA, undefined).pass).toBe(true);
    expect(avaliarHorarios(THALES, AGORA, base({ ativo: false })).pass).toBe(true);
  });
});

describe('leitura do resultado das tools', () => {
  it('colhe `horarios[].inicio` de topo, em qualquer embalagem', () => {
    expect(
      colherDaFerramenta({ horarios: [{ inicio: '2026-11-03T14:00:00.000Z', quando: 'ter 03/11 11:00' }] }).livres,
    ).toEqual(['2026-11-03T14:00:00.000Z']);
    expect(
      colherDaFerramenta({ content: [{ type: 'text', text: '{"horarios":[{"inicio":"2026-11-04T12:30:00Z"}]}' }] })
        .livres,
    ).toEqual(['2026-11-04T12:30:00Z']);
    const marcou = colherDaFerramenta(
      JSON.stringify({ marcado: true, compromisso: { starts_at: '2026-11-03T14:00:00Z' } }),
    );
    expect(marcou).toMatchObject({ marcou: true, marcados: ['2026-11-03T14:00:00Z'], livres: [] });
  });

  it('marcação recusada não conta como marcada', () => {
    expect(marcouComSucesso({ marcado: true, compromisso: { id: 'x' } })).toBe(true);
    expect(marcouComSucesso({ marcado: false, motivo: 'slot_taken' })).toBe(false);
    expect(marcouComSucesso('erro')).toBe(false);
  });

  // O formato de `crm_find_and_book_appointment` com o horário pedido OCUPADO
  // (`lib/mcp/tools/agendamento.ts`, `motivo: 'horario_indisponivel'`): nada marcado, a
  // lista do dia, e a ordem de oferecer uma das opções. Oferecê-la não é horário sem fonte.
  it('find_and_book ocupado: oferecer um item da `horarios` devolvida passa', () => {
    const resultado = {
      horarios: [
        { inicio: '2026-11-03T13:00:00.000Z', fim: '2026-11-03T13:15:00.000Z', quando: 'ter 03/11 10:00' },
      ],
      total_de_horarios: 1,
      ha_mais: false,
      fuso_da_regra: FUSO,
      marcado: false,
      motivo: 'horario_indisponivel',
      mensagem: '11:00 não está livre em 2026-11-03, e NADA foi marcado. Ofereça ao cliente uma das opções de `horarios`.',
    };
    const c = colherDaFerramenta(resultado);
    expect(c.marcou).toBe(false);
    expect(c.marcados).toEqual([]);
    expect(avaliarHorarios('Tenho 03/11 às 10h, pode ser?', AGORA, base({ livres: c.livres }))).toEqual({
      pass: true,
    });
  });

  // `servico.horarios[]` é a disponibilidade CRUA do serviço, com itens ocupados.
  it('servico.horarios com disponivel:false não aprova o horário ocupado', () => {
    const resultado = {
      horarios: [{ inicio: '2026-11-03T13:00:00.000Z', quando: 'ter 03/11 10:00' }],
      fuso_da_regra: FUSO,
      servico: {
        modo: 'individual',
        horarios: [
          { inicio: '2026-11-03T13:00:00.000Z', disponivel: true },
          { inicio: '2026-11-03T14:15:00.000Z', disponivel: false, motivo: 'lotado' },
        ],
      },
    };
    const c = colherDaFerramenta(resultado);
    expect(c.livres).toEqual(['2026-11-03T13:00:00.000Z']);
    const v = avaliarHorarios('Tenho 03/11 às 11h15', AGORA, base({ livres: c.livres }));
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe('horario_sem_fonte');
  });
});
