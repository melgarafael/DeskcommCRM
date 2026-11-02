import { test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EventRow } from '@/lib/event-log/dispatcher';
import type { CanalDoAviso, ConfigDoAviso, PacingDoAviso, TransporteDoAviso } from './aviso-ao-suporte';
import type { AvisoHandoffDeps, EstadoEnvioHandoff } from './aviso-de-handoff';
import assert from 'node:assert/strict';
import {
  aplicaAvisoHandoff, criarPersistenciaAvisoHandoff, textoDoAvisoHandoff,
  corpoComResultadoHandoff, EVENTO_AVISO_HANDOFF, MARCA_ENVIO_HANDOFF,
  MARCA_EPISODIO_HANDOFF,
} from './aviso-de-handoff';

const ORG = '10000000-0000-4000-8000-000000000001';
const CONV = '20000000-0000-4000-8000-000000000002';
const EVENT = '30000000-0000-4000-8000-000000000003';
const CENTRAL = '40000000-0000-4000-8000-000000000004';
const CONTACT = '50000000-0000-4000-8000-000000000005';
const CHANNEL = '60000000-0000-4000-8000-000000000006';
const NOW = '2026-10-24T12:00:00.000Z';

// Simula apenas o contrato PostgREST (filtros + CAS indivisível). Não é prova
// de SQL executado, RLS, conexão externa nem entrega real de WhatsApp.
type Linhas = {
  event_log: EventRow[];
  conversations: { id: string; organization_id: string; contact_id: string; status: string;
    bot_silenced_until: string | null; metadata: Record<string, unknown> }[];
  agent_inbox_items: { id: string; organization_id: string; ref_kind: string; ref_id: string; body: string }[];
  organizations: { id: string; settings: Record<string, unknown> }[];
};
type Linha = Linhas[keyof Linhas][number];
type Alteracao = { metadata?: Record<string, { estado?: string }>; body?: string };
type Resultado = { data: Linha | Linha[] | null; error: { message: string } | null };
function banco(linhas: Linhas) {
  const consultas: { tabela: keyof Linhas; filtros: [string, unknown][]; alteracao?: Alteracao }[] = [];
  const api = { linhas, consultas, falharResultado: false,
    aposLeitura: undefined as ((tabela: keyof Linhas) => Promise<void>) | undefined,
    from(tabela: keyof Linhas) {
      const filtros: [string, unknown][] = []; let alteracao: Alteracao | undefined;
      const q = {
        select() { return q; },
        update(valor: Alteracao) { alteracao = valor; return q; },
        eq(coluna: string, valor: unknown) { filtros.push([coluna, valor]); return q; },
        is(coluna: string, valor: unknown) { filtros.push([coluna, valor]); return q; },
        maybeSingle() { return executar(true); },
        then(resolve: (resultado: Resultado) => unknown, reject?: (erro: unknown) => unknown) { return executar(false).then(resolve, reject); },
      };
      async function executar(single: boolean): Promise<Resultado> {
        consultas.push({ tabela, filtros: structuredClone(filtros), alteracao });
        const selecionadas = linhas[tabela].filter(linha => filtros.every(([coluna, valor]) =>
          coluna === 'metadata' ? JSON.stringify((linha as unknown as Record<string, unknown>).metadata) === valor : (linha as unknown as Record<string, unknown>)[coluna] === valor));
        if (alteracao?.metadata?.[MARCA_ENVIO_HANDOFF]?.estado === 'enviado' && api.falharResultado) {
          api.falharResultado = false;
          return { data: null, error: { message: 'simulado' } };
        }
        if (alteracao) for (const linha of selecionadas) Object.assign(linha, structuredClone(alteracao));
        const data = structuredClone(single ? selecionadas[0] ?? null : selecionadas);
        if (!alteracao && api.aposLeitura) await api.aposLeitura(tabela);
        return { data, error: null };
      }
      return q;
    },
  };
  return api;
}
function fixture() {
  const row: EventRow = { id: EVENT, organization_id: ORG, event_type: EVENTO_AVISO_HANDOFF,
    entity_kind: 'conversation', entity_id: CONV, payload: { central_id: CENTRAL },
    metadata: { source: 'human_handoff' }, consumed_by: [], attempts: 0, created_at: NOW };
  const admin = banco({
    event_log: [structuredClone(row)],
    conversations: [{ id: CONV, organization_id: ORG, contact_id: CONTACT,
      status: 'pending', bot_silenced_until: 'infinity', metadata: { [MARCA_EPISODIO_HANDOFF]: EVENT } }],
    agent_inbox_items: [{ id: CENTRAL, organization_id: ORG, ref_kind: 'conversation', ref_id: CONV,
      body: 'Uma pessoa precisa assumir esta conversa.' }],
    // Sem a chave: ausente é ligado, como o aviso de Propostas.
    organizations: [{ id: ORG, settings: { crm: {} } }],
  });
  const config: ConfigDoAviso = { organization_id: ORG, channel_session_id: CHANNEL,
    telefone_destino: '+5511999990000', destino_jid: null, ligado: true, resposta_whatsapp_habilitada: false };
  const canal: CanalDoAviso = { id: CHANNEL, status: 'WORKING', archived_at: null, aceitaMensagemLivre: true };
  const chamadas: Parameters<TransporteDoAviso['envia']>[] = [];
  const pacing: Parameters<PacingDoAviso['registraEnvio']>[] = []; let agora = new Date(NOW);
  const deps: AvisoHandoffDeps = {
    ...criarPersistenciaAvisoHandoff(admin as unknown as SupabaseClient),
    db: { carregaConfig: async org => { assert.equal(org, ORG); return structuredClone(config); },
      carregaCanal: async (org, id) => { assert.equal(org, ORG); assert.equal(id, CHANNEL); return canal; },
      contatoAnonimizado: async () => false, destinoEhDaPropriaOrganizacao: async () => false,
      registraJidDoAviso: async () => {} },
    transporte: { configurado: async () => true, resolveDestino: async () => 'destino-configurado',
      envia: async (...args) => { chamadas.push(args); return { externalId: 'recibo' }; } },
    pacing: { decide: async () => ({ liberado: true }), registraEnvio: async (...args) => { pacing.push(args); } },
    clock: () => agora, urlPublica: 'https://crm.exemplo.test', origemDoDreno: () => 'worker',
  };
  return { deps, row, admin, config, canal, chamadas, pacing,
    avancar: (ms: number) => { agora = new Date(agora.getTime() + ms); },
    marca: () => admin.linhas.event_log[0]!.metadata[MARCA_ENVIO_HANDOFF] as EstadoEnvioHandoff | undefined,
  };
}

test('um aviso usa só destino configurado, depois de reserva durável, sem conteúdo da conversa', async () => {
  const f = fixture();
  f.deps.transporte.envia = async (...args) => {
    assert.equal(f.marca()!.estado, 'reservado');
    assert.equal(f.admin.linhas.agent_inbox_items.length, 1);
    f.chamadas.push(args); return { externalId: 'recibo' };
  };
  assert.equal((await aplicaAvisoHandoff(f.deps, f.row)).status, 'ok');
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0]![2], 'destino-configurado');
  assert.match(f.chamadas[0]![3], new RegExp(`/app/inbox\\?id=${CONV}`));
  assert.doesNotMatch(f.chamadas[0]![3], /nome|diagnóstico|resumo|motivo/i);
  assert.equal(f.marca()!.estado, 'enviado');
  assert.equal(f.pacing.length, 1);
});

test('concorrência e replay só fazem uma tentativa externa', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 20 }, () => aplicaAvisoHandoff(f.deps, f.row)));
  await aplicaAvisoHandoff(f.deps, f.row);
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.marca()!.estado, 'enviado');
  assert.equal(f.admin.linhas.agent_inbox_items[0]!.body.split('Aviso à equipe').length - 1, 1);
});

test('timeout depois da reserva é incerto, nunca autoriza reenvio', async () => {
  const f = fixture();
  f.deps.transporte.envia = async () => { f.chamadas.push([ORG, f.canal, 'destino-configurado', 'tentativa']); throw new Error('timeout'); };
  await aplicaAvisoHandoff(f.deps, f.row); f.avancar(600_000);
  await aplicaAvisoHandoff(f.deps, f.row);
  assert.equal(f.chamadas.length, 1); assert.equal(f.marca()!.estado, 'incerto');
  assert.match(f.admin.linhas.agent_inbox_items[0]!.body, /Não haverá reenvio automático/);
});

test('crash após reserva e antes do transporte não abre uma segunda tentativa', async () => {
  const f = fixture(); await f.deps.reservar(f.row, NOW); f.avancar(180_000);
  await aplicaAvisoHandoff(f.deps, f.row);
  assert.equal(f.chamadas.length, 0); assert.equal(f.marca()!.estado, 'incerto');
});

test('falha de persistência depois do aceite não repete envio', async () => {
  const f = fixture(); f.admin.falharResultado = true;
  await assert.rejects(aplicaAvisoHandoff(f.deps, f.row));
  assert.equal(f.chamadas.length, 1); assert.equal(f.marca()!.estado, 'reservado');
  f.avancar(180_000); await aplicaAvisoHandoff(f.deps, f.row);
  assert.equal(f.chamadas.length, 1); assert.equal(f.marca()!.estado, 'incerto');
});

test('cancelamento concorrente nunca apaga reserva nem recibo positivo', async () => {
  const f = fixture(); await f.deps.reservar(f.row, NOW);
  await f.deps.concluir(f.row, { estado: 'cancelado', em: NOW });
  assert.equal(f.marca()!.estado, 'reservado');
  await f.deps.concluir(f.row, { estado: 'enviado', em: NOW });
  await f.deps.concluir(f.row, { estado: 'incerto', em: NOW });
  assert.equal(f.marca()!.estado, 'enviado');
});

test('retomada do automático cancela aviso pendente; outro episódio pode avisar', async () => {
  const f = fixture(); f.admin.linhas.conversations[0]!.bot_silenced_until = null;
  await aplicaAvisoHandoff(f.deps, f.row);
  assert.equal(f.marca()!.estado, 'cancelado'); assert.equal(f.chamadas.length, 0);
  const id = '30000000-0000-4000-8000-000000000007';
  const novo = { ...f.row, id }; f.admin.linhas.event_log.push(structuredClone(novo));
  Object.assign(f.admin.linhas.conversations[0]!, { bot_silenced_until: 'infinity', metadata: { [MARCA_EPISODIO_HANDOFF]: id } });
  await aplicaAvisoHandoff(f.deps, novo); assert.equal(f.chamadas.length, 1);
});

test('pacing e canal offline adiam sem consumir tentativa', async () => {
  const f = fixture(); f.canal.status = 'STOPPED';
  assert.equal((await aplicaAvisoHandoff(f.deps, f.row)).status, 'retry');
  f.canal.status = 'WORKING'; f.deps.pacing.decide = async () => ({ liberado: false, motivo: 'espacamento', liberaEm: new Date(NOW) });
  assert.equal((await aplicaAvisoHandoff(f.deps, f.row)).status, 'retry');
  assert.equal(f.marca(), undefined); assert.equal(f.chamadas.length, 0);
  f.deps.pacing.decide = async () => ({ liberado: true });
  await aplicaAvisoHandoff(f.deps, f.row); assert.equal(f.chamadas.length, 1);
});

test('opt-in retirado na releitura impede envio', async () => {
  const f = fixture(); let leituras = 0;
  f.deps.db.carregaConfig = async () => ({ ...f.config, ligado: ++leituras === 1 });
  await aplicaAvisoHandoff(f.deps, f.row);
  assert.equal(f.chamadas.length, 0); assert.equal(f.marca()!.estado, 'cancelado');
});

test('transferências desligadas na organização cancelam antes da reserva', async () => {
  const f = fixture();
  f.admin.linhas.organizations[0]!.settings = { crm: { avisar_transferencia_no_whatsapp: false } };
  const r = await aplicaAvisoHandoff(f.deps, f.row);
  assert.equal(r.detail, 'desligado_em_transferencias');
  assert.equal(f.chamadas.length, 0); assert.equal(f.pacing.length, 0);
  assert.equal(f.marca()!.estado, 'cancelado');
});

test('só o booleano false desliga as transferências; lixo e ausência continuam ligados', async () => {
  for (const crm of [{}, { avisar_transferencia_no_whatsapp: 'false' }, { avisar_transferencia_no_whatsapp: null }]) {
    const f = fixture(); f.admin.linhas.organizations[0]!.settings = { crm };
    assert.equal((await aplicaAvisoHandoff(f.deps, f.row)).status, 'ok', JSON.stringify(crm));
    assert.equal(f.chamadas.length, 1);
  }
});

test('evento de outra organização não lê nem grava dados desta', async () => {
  const f = fixture();
  await assert.rejects(aplicaAvisoHandoff(f.deps, { ...f.row, organization_id: 'outra-org' }));
  assert.equal(f.chamadas.length, 0); assert.equal(f.marca(), undefined);
});

test('todas as leituras e escritas do adapter carregam organization_id', async () => {
  const f = fixture(); await aplicaAvisoHandoff(f.deps, f.row);
  assert.ok(f.admin.consultas.length > 6);
  // `organizations` é a própria organização: a chave dela é `id`.
  for (const q of f.admin.consultas) {
    const coluna = q.tabela === 'organizations' ? 'id' : 'organization_id';
    assert.ok(q.filtros.some(([col, val]) => col === coluna && val === ORG));
  }
});

test('marcador ilegível falha fechado e não libera novo envio', async () => {
  const f = fixture(); f.admin.linhas.event_log[0]!.metadata[MARCA_ENVIO_HANDOFF] = 'corrompido';
  await aplicaAvisoHandoff(f.deps, f.row); assert.equal(f.chamadas.length, 0);
});

test('recibo substitui só sua própria linha e conserva adendos da Central', () => {
  const original = 'Passagem\nAdendo humano';
  const incerto = corpoComResultadoHandoff(original, EVENT, { estado: 'incerto', em: NOW });
  const enviado = corpoComResultadoHandoff(incerto, EVENT, { estado: 'enviado', em: NOW });
  assert.match(enviado, /^Passagem\nAdendo humano/);
  assert.equal(enviado.split('Aviso à equipe').length - 1, 1);
  assert.match(enviado, /aceito pelo canal/);
});

test('link usa a rota real e remove query e fragmento da configuração', () => {
  const texto = textoDoAvisoHandoff('https://crm.exemplo.test/path?secreto=sim#fragmento', CONV);
  assert.ok(texto);
  assert.match(texto, new RegExp(`https://crm.exemplo.test/app/inbox\\?id=${CONV}`));
  assert.doesNotMatch(texto, /secreto|fragmento/);
  assert.equal(textoDoAvisoHandoff('http://crm.exemplo.test', CONV), null);
  assert.equal(textoDoAvisoHandoff('https://user:password@crm.exemplo.test', CONV), null);
});

test('evento sem Central e eventos do dreno HTTP nunca enviam', async () => {
  const f = fixture();
  assert.equal((await aplicaAvisoHandoff(f.deps, { ...f.row, payload: {} })).detail, 'evento_invalido');
  f.deps.origemDoDreno = () => 'request';
  assert.equal((await aplicaAvisoHandoff(f.deps, f.row)).status, 'retry');
  assert.equal(f.chamadas.length, 0); assert.equal(f.marca(), undefined);
});
test('closed, resolved e archived cancelam aviso ainda pendente', async () => {
  for (const status of ['closed', 'resolved', 'archived']) {
    const f = fixture(); f.admin.linhas.conversations[0]!.status = status;
    await aplicaAvisoHandoff(f.deps, f.row);
    assert.equal(f.chamadas.length, 0, status);
    assert.equal(f.marca()!.estado, 'cancelado', status);
  }
});
test('recibo concorrente da Central nunca rebaixa aceite positivo para incerto', async () => {
  const f = fixture(); await f.deps.reservar(f.row, NOW);
  let intercalou = false;
  f.admin.aposLeitura = async tabela => {
    if (tabela !== 'agent_inbox_items' || intercalou) return;
    intercalou = true;
    await f.deps.concluir(f.row, { estado: 'enviado', em: NOW });
  };
  await f.deps.concluir(f.row, { estado: 'incerto', em: NOW });
  assert.ok(intercalou);
  assert.equal(f.marca()!.estado, 'enviado');
  assert.match(f.admin.linhas.agent_inbox_items[0]!.body, /aceito pelo canal de WhatsApp/);
  assert.doesNotMatch(f.admin.linhas.agent_inbox_items[0]!.body, /entrega não confirmada/);
});
