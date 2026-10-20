import { expect, it } from 'vitest';
import { criarContextoCompartilhadoDoTurno, limitarContextoCompartilhado, observarFerramentasDoTurno } from './contexto-compartilhado-do-turno';
import { tool } from 'ai';
import { z } from 'zod';
import { pacoteParaJev } from '@/lib/ai/decisao/revisao-resposta';

it('a ponte real captura ferramenta desconhecida antes de devolver o mesmo resultado ao agente', async () => {
  const c = criarContextoCompartilhadoDoTurno();
  const resultado = { pagamento: 'boleto', horarios: ['14:00', '14:40'] };
  const ferramentas = observarFerramentasDoTurno({
    crm_ferramenta_futura: tool({ inputSchema: z.object({}), execute: async () => resultado }),
  }, c);
  expect(await ferramentas.crm_ferramenta_futura!.execute!({}, { toolCallId: 'chamada', messages: [], context: {} })).toBe(resultado);
  expect(c.atual()!.fontes[0]).toMatchObject({ nome: 'crm_ferramenta_futura', estado: 'present', conteudo: { entrada: {}, resultado } });
});

it('preserva resultado real, parâmetros, origem e ordem de ferramentas de qualquer nicho', () => {
  const c = criarContextoCompartilhadoDoTurno();
  c.registrarInstrucao('agente_publicado', 'Consulta de avaliação, sem preço inventado.');
  const uma = c.iniciarFerramenta('crm_consultar_servico_novo');
  const duas = c.iniciarFerramenta('crm_list_event_types');
  c.concluir(duas, { resultado: [{ nome: 'Avaliação', duracao: 40 }] });
  expect(c.atual()!.fontes[1]!.estado).toBe('pending');
  c.concluir(uma, { entrada: { periodo: 'tarde' }, resultado: { horarios: ['14:00', '14:40'] } });
  const p = pacoteParaJev({ candidate: 'Tenho 14h e 14h40.', agentContext: c.atual() });
  const fontes = (p.contexto_observado_do_turno as ReturnType<typeof c.atual>)!.fontes;
  expect(fontes.map(f => f.sequencia)).toEqual([1, 2, 3]);
  expect(fontes[1]!.conteudo).toEqual({ entrada: { periodo: 'tarde' }, resultado: { horarios: ['14:00', '14:40'] } });
  expect(fontes[2]!.conteudo).toEqual({ resultado: [{ nome: 'Avaliação', duracao: 40 }] });
  const outra = criarContextoCompartilhadoDoTurno();
  expect(outra.atual()).toBeUndefined();
  const antiga = c.atual()!;
  antiga.fontes[0]!.estado = 'unavailable';
  expect(c.atual()!.fontes[0]!.estado).toBe('present');
});

it('não transporta segredos ou IDs e mantém referências diferentes distinguíveis', () => {
  const c = criarContextoCompartilhadoDoTurno();
  const um = '11111111-1111-4111-8111-111111111111', dois = '22222222-2222-4222-8222-222222222222';
  c.concluir(c.iniciarFerramenta('crm_consultar'), { id: um, outro: dois, mesmo: um,
    authorization: 'credencial-secreta', access_token: 'credencial-secreta', credential_id: 'credencial-secreta',
    link: 'https://host/storage?token=credencial-secreta' });
  const texto = JSON.stringify(c.atual());
  expect(texto).not.toContain('credencial-secreta');
  expect(texto).not.toContain(um);
  expect(c.atual()!.fontes[0]!.conteudo).toMatchObject({ id: 'referencia_1', outro: 'referencia_2', mesmo: 'referencia_1' });
});

it('teto e falha nunca se passam por consulta vazia ou retiram as fontes canônicas', () => {
  const c = criarContextoCompartilhadoDoTurno();
  c.concluir(c.iniciarFerramenta('consulta_grande'), { dados: 'x'.repeat(17000) });
  c.falhar(c.iniciarFerramenta('consulta_falhou'));
  expect(c.atual()!.fontes.map(f => f.estado)).toEqual(['excluded_by_limit', 'unavailable']);
  expect(limitarContextoCompartilhado(c.atual()!, 0)).toMatchObject({ fontes: [], omitidas: 2 });
  const p = pacoteParaJev({ candidate: 'Olá.', agentContext: c.atual(),
    commercialEvidence: [{ titulo: 'Política', conteudo: 'Sem parcelamento.', origem: 'conhecimento', referencia: 'r' }] });
  expect(p.evidencias).toEqual([{ titulo: 'Política', conteudo: 'Sem parcelamento.', origem: 'conhecimento' }]);
  expect(p.limite_contexto).toBeUndefined();
  expect(p.contexto_observado_do_turno).toBeDefined();
});

const opcoes = { toolCallId: 'chamada', messages: [], context: {} };

it('o envio espera o Caso e o contexto no mesmo passo, sem forçar linguagem impessoal', async () => {
  const contexto = criarContextoCompartilhadoDoTurno();
  let abrir!: () => void;
  const espera = new Promise<void>(resolve => { abrir = resolve; });
  let caso = false;
  let enviado = false;
  const ferramentas = observarFerramentasDoTurno({
    open_human_case: tool({ inputSchema: z.object({}), execute: async () => {
      await espera; caso = true; return { ok: true, case_id: 'caso-atual' };
    } }),
    send_message: tool({ inputSchema: z.object({}), execute: async () => {
      enviado = true;
      expect(caso).toBe(true);
      expect(contexto.atual()!.fontes[0]!).toMatchObject({ estado: 'present', nome: 'open_human_case' });
      return { enviada: true };
    } }),
  }, contexto);
  const abertura = ferramentas.open_human_case!.execute!({}, opcoes);
  const envio = ferramentas.send_message!.execute!({}, opcoes);
  expect(enviado).toBe(false);
  abrir();
  await expect(Promise.all([abertura, envio])).resolves.toEqual([{ ok: true, case_id: 'caso-atual' }, { enviada: true }]);
  expect(contexto.atual()!.fontes).toHaveLength(1);
});

it('falha da ferramenta não vira prova de Caso nem bloqueia a avaliação do envio', async () => {
  const contexto = criarContextoCompartilhadoDoTurno();
  const ferramentas = observarFerramentasDoTurno({
    open_human_case: tool({ inputSchema: z.object({}), execute: async () => { throw new Error('falha'); } }),
    send_message: tool({ inputSchema: z.object({}), execute: async () => {
      expect(contexto.atual()!.fontes[0]!.estado).toBe('unavailable');
      return { enviada: false, code: 'case_promise_without_case' };
    } }),
  }, contexto);
  const resultados = await Promise.allSettled([
    ferramentas.open_human_case!.execute!({}, opcoes), ferramentas.send_message!.execute!({}, opcoes),
  ]);
  expect(resultados).toMatchObject([{ status: 'rejected' }, { status: 'fulfilled', value: { enviada: false } }]);
});

it('leituras independentes continuam concorrentes e a fila não atravessa turnos', async () => {
  let concluir!: () => void;
  const espera = new Promise<void>(resolve => { concluir = resolve; });
  let segundaIniciada = false;
  const ferramentas = observarFerramentasDoTurno({
    consulta_lenta: tool({ inputSchema: z.object({}), execute: async () => { await espera; return 1; } }),
    consulta_outra: tool({ inputSchema: z.object({}), execute: async () => { segundaIniciada = true; return 2; } }),
  }, criarContextoCompartilhadoDoTurno());
  const uma = ferramentas.consulta_lenta!.execute!({}, opcoes);
  const duas = ferramentas.consulta_outra!.execute!({}, opcoes);
  expect(segundaIniciada).toBe(true);
  const outroTurno = observarFerramentasDoTurno({ send_message: tool({ inputSchema: z.object({}), execute: async () => 'outro' }) }, criarContextoCompartilhadoDoTurno());
  await expect(outroTurno.send_message!.execute!({}, opcoes)).resolves.toBe('outro');
  concluir(); await Promise.all([uma, duas]);
});

it('aguarda também quando o SDK inicia o envio antes da ferramenta irmã no mesmo passo', async () => {
  let abriu = false;
  const ferramentas = observarFerramentasDoTurno({
    send_message: tool({ inputSchema: z.object({}), execute: async () => abriu }),
    open_human_case: tool({ inputSchema: z.object({}), execute: async () => { await Promise.resolve(); abriu = true; return true; } }),
  }, criarContextoCompartilhadoDoTurno());
  const envio = ferramentas.send_message!.execute!({}, opcoes);
  const abertura = ferramentas.open_human_case!.execute!({}, opcoes);
  await expect(Promise.all([envio, abertura])).resolves.toEqual([true, true]);
});
