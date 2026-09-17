import { describe, expect, it } from 'vitest';
import {
  ETAPAS_INICIAIS,
  podeExcluirDeVez,
  regrasQueApontamPara,
  updatesDeMarcaExclusiva,
  updatesDePadrao,
  validarArquivamento,
  validarNomeDeFunil,
  type DependenciasDoFunil,
  type FunilEditavel,
} from './pipeline-editing';

const funis: FunilEditavel[] = [
  { id: 'f1', name: 'Pedidos', slug: 'pedidos', position: 1000, is_default: true, is_archived: false },
  { id: 'f2', name: 'Clínica', slug: 'clinica', position: 2000, is_default: false, is_archived: false },
  { id: 'f3', name: 'Pós venda', slug: 'pos_venda', position: 3000, is_default: false, is_archived: false },
];

const semDependencia: DependenciasDoFunil = { negocios: 0, fontesDeWebhook: [], regrasAtivas: [] };

describe('validarNomeDeFunil', () => {
  it('recusa nome vazio e nome só de espaços', () => {
    expect(validarNomeDeFunil('', funis, null).ok).toBe(false);
    expect(validarNomeDeFunil('   ', funis, null).ok).toBe(false);
  });

  it('recusa nome repetido, citando o funil que já existe', () => {
    const r = validarNomeDeFunil('Clínica', funis, null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/Clínica/);
  });

  it('aceita o próprio nome ao renomear', () => {
    expect(validarNomeDeFunil('Clínica', funis, 'f2').ok).toBe(true);
  });

  it('dobra acento e espaço interno — "Pos  venda" é o mesmo funil que "Pós venda"', () => {
    // Mesma decisão de produto das etapas: quem digita sem acento criaria um
    // segundo funil que ele lê como o mesmo, e ninguém explica por que há dois.
    // O hífen NÃO é dobrado (limite herdado de `chaveDeNome`, compartilhado com
    // as etapas): "Pós-venda" e "Pos venda" ainda convivem. Mudar isso mexeria no
    // comportamento das etapas, que não é escopo desta feature.
    expect(validarNomeDeFunil('Pos  venda', funis, null).ok).toBe(false);
  });

  it('funil arquivado não bloqueia o nome — ele saiu da lista', () => {
    // Recusar por causa de um funil que o usuário não vê é erro sem saída.
    const comArquivado = [
      ...funis,
      { id: 'f9', name: 'Antigo', slug: 'antigo', position: 4000, is_default: false, is_archived: true },
    ];
    expect(validarNomeDeFunil('Antigo', comArquivado, null).ok).toBe(true);
  });
});

describe('validarArquivamento', () => {
  it('recusa arquivar o único funil ativo — o Kanban ficaria sem quadro', () => {
    const soUm = [funis[0]!];
    const r = validarArquivamento(soUm, 'f1', semDependencia);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/Pedidos/);
  });

  it('recusa arquivar o funil padrão, mandando eleger outro antes', () => {
    // `uniq_crm_pipelines_org_default` é índice parcial: sem padrão, toda
    // criação de lead que resolve funil por default fica sem destino.
    const r = validarArquivamento(funis, 'f1', semDependencia);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/padrão/i);
  });

  it('recusa quando é destino de fonte de webhook, NOMEANDO a fonte', () => {
    // webhook_sources.default_pipeline_id é ON DELETE CASCADE: sem esta recusa,
    // arrumar o quadro derrubaria o formulário público do cliente.
    const r = validarArquivamento(funis, 'f2', { ...semDependencia, fontesDeWebhook: ['Landing page'] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/Landing page/);
  });

  it('recusa quando uma regra de automação ativa aponta para ele, NOMEANDO a regra', () => {
    // O pipeline_id mora dentro de automation_rules.actions (jsonb, sem FK):
    // o banco não defende nada aqui, então a defesa é esta.
    const r = validarArquivamento(funis, 'f2', { ...semDependencia, regrasAtivas: ['Lead do site'] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/Lead do site/);
  });

  it('permite arquivar funil COM negócios — o histórico continua de pé', () => {
    expect(validarArquivamento(funis, 'f2', { ...semDependencia, negocios: 42 }).ok).toBe(true);
  });

  it('recusa funil que não é da lista, mandando recarregar', () => {
    expect(validarArquivamento(funis, 'inexistente', semDependencia).ok).toBe(false);
  });

  it('quando é o único E é o padrão, explica a unicidade — é o que o usuário pode resolver', () => {
    // Mandar "eleja outro padrão" para quem só tem um funil é um beco sem saída.
    const soUm = [funis[0]!];
    const r = validarArquivamento(soUm, 'f1', semDependencia);
    expect(r.ok === false && r.erro).toMatch(/único/i);
  });
});

describe('podeExcluirDeVez', () => {
  it('recusa excluir funil com negócios, oferecendo arquivar', () => {
    const r = podeExcluirDeVez(funis, 'f2', { ...semDependencia, negocios: 3 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).toMatch(/arquiv/i);
  });

  it('permite excluir o funil criado por engano — zero de tudo', () => {
    expect(podeExcluirDeVez(funis, 'f2', semDependencia).ok).toBe(true);
  });

  it('herda TODA recusa do arquivamento — excluir é mais grave, nunca mais permissivo', () => {
    expect(podeExcluirDeVez(funis, 'f1', semDependencia).ok).toBe(false);
    expect(podeExcluirDeVez(funis, 'f2', { ...semDependencia, fontesDeWebhook: ['LP'] }).ok).toBe(false);
    expect(podeExcluirDeVez(funis, 'f2', { ...semDependencia, regrasAtivas: ['R'] }).ok).toBe(false);
  });
});

describe('updatesDePadrao', () => {
  it('libera o padrão anterior ANTES de marcar o novo', () => {
    // `uniq_crm_pipelines_org_default` é imediato, não deferível: a ordem
    // inversa é um 23505 cru na cara de quem só queria trocar o padrão.
    const updates = updatesDePadrao(funis, 'f2');
    expect(updates).toEqual([
      { pipelineId: 'f1', patch: { is_default: false } },
      { pipelineId: 'f2', patch: { is_default: true } },
    ]);
  });

  it('não emite nada quando o funil já é o padrão', () => {
    expect(updatesDePadrao(funis, 'f1')).toEqual([]);
  });

  it('sem padrão anterior, só marca o novo', () => {
    const semPadrao = funis.map((f) => ({ ...f, is_default: false }));
    expect(updatesDePadrao(semPadrao, 'f2')).toEqual([{ pipelineId: 'f2', patch: { is_default: true } }]);
  });

  it('libera o padrão anterior mesmo ARQUIVADO — o índice não recorta arquivado', () => {
    // ⚠️ ESTE TESTE AFIRMAVA O CONTRÁRIO, e o que ele congelava era um bug.
    // Dizia "o índice único é parcial (where is_archived = false)"; medido em
    // supabase/baseline.sql, `uniq_crm_pipelines_org_default` é
    // `where (is_default = true)` e mais nada. Pular o arquivado mandava UM
    // update onde precisava de dois, e o 23505 caía justamente na organização
    // que arquivou o funil antigo em vez de trocar o padrão antes — o caminho
    // mais comum de quem reorganiza o CRM.
    const arquivadoEraPadrao = [
      { id: 'fz', name: 'Velho', slug: 'velho', position: 500, is_default: true, is_archived: true },
      { ...funis[1]!, is_default: false },
    ];
    expect(updatesDePadrao(arquivadoEraPadrao, 'f2')).toEqual([
      { pipelineId: 'fz', patch: { is_default: false } },
      { pipelineId: 'f2', patch: { is_default: true } },
    ]);
  });

  it('não emite nada para funil que não está na lista', () => {
    expect(updatesDePadrao(funis, 'inexistente')).toEqual([]);
  });
});

describe('updatesDeMarcaExclusiva — funil de clientes', () => {
  // A marca de clientes tem o MESMO índice imediato que a de padrão
  // (`uniq_crm_pipelines_org_client`), então tem a mesma ordem obrigatória.
  // O teste existe porque as duas marcas são o mesmo mecanismo com nomes
  // diferentes, e o dia em que uma divergir da outra é o dia em que a tela
  // passa a se comportar de dois jeitos no mesmo gesto.
  const comClientes: FunilEditavel[] = [
    { ...funis[0]!, is_client_pipeline: false },
    { ...funis[1]!, is_client_pipeline: true },
    { ...funis[2]!, is_client_pipeline: false },
  ];

  it('libera o anterior ANTES de marcar o novo', () => {
    expect(updatesDeMarcaExclusiva(comClientes, 'f3', 'is_client_pipeline')).toEqual([
      { pipelineId: 'f2', patch: { is_client_pipeline: false } },
      { pipelineId: 'f3', patch: { is_client_pipeline: true } },
    ]);
  });

  it('não emite nada quando o funil já é o de clientes', () => {
    expect(updatesDeMarcaExclusiva(comClientes, 'f2', 'is_client_pipeline')).toEqual([]);
  });

  it('nenhum anterior (o estado de toda instalação nova) — só marca o novo', () => {
    expect(updatesDeMarcaExclusiva(funis, 'f2', 'is_client_pipeline')).toEqual([
      { pipelineId: 'f2', patch: { is_client_pipeline: true } },
    ]);
  });

  it('o mesmo funil pode ser padrão E de clientes — nada impede', () => {
    // A organização que tem UM funil só é o caso comum de instalação nova.
    // Proibir aqui quebraria justamente ela.
    expect(updatesDeMarcaExclusiva(funis, 'f1', 'is_client_pipeline')).toEqual([
      { pipelineId: 'f1', patch: { is_client_pipeline: true } },
    ]);
  });
});

describe('regrasQueApontamPara', () => {
  const regra = (name: string, is_active: boolean, pipelineId: string) => ({
    name,
    is_active,
    actions: [{ type: 'create_or_move_lead', config: { pipeline_id: pipelineId, stage_id: 's1' } }],
  });

  it('devolve o nome da regra ativa que move card para o funil', () => {
    expect(regrasQueApontamPara([regra('Lead do site', true, 'f2')], 'f2')).toEqual(['Lead do site']);
  });

  it('ignora regra inativa — ela não move nada hoje', () => {
    expect(regrasQueApontamPara([regra('Desligada', false, 'f2')], 'f2')).toEqual([]);
  });

  it('ignora regra que aponta para outro funil', () => {
    expect(regrasQueApontamPara([regra('Outra', true, 'f3')], 'f2')).toEqual([]);
  });

  it('ignora action de outro tipo e jsonb malformado sem quebrar', () => {
    // O jsonb não tem schema no banco: uma regra antiga pode ter qualquer forma,
    // e uma exceção aqui derrubaria o arquivamento com erro 500 sem explicação.
    const bagunca = [
      { name: 'Webhook', is_active: true, actions: [{ type: 'call_webhook', config: { url: 'x' } }] },
      { name: 'Nulo', is_active: true, actions: null },
      { name: 'String', is_active: true, actions: 'nao-e-array' },
      { name: 'Objeto', is_active: true, actions: [{ config: 'nao-e-objeto' }] },
    ];
    expect(regrasQueApontamPara(bagunca, 'f2')).toEqual([]);
  });

  it('não repete o nome quando a mesma regra cita o funil em duas ações', () => {
    const duasAcoes = {
      name: 'Dupla',
      is_active: true,
      actions: [
        { type: 'create_or_move_lead', config: { pipeline_id: 'f2', stage_id: 's1' } },
        { type: 'create_or_move_lead', config: { pipeline_id: 'f2', stage_id: 's2' } },
      ],
    };
    expect(regrasQueApontamPara([duasAcoes], 'f2')).toEqual(['Dupla']);
  });
});

describe('ETAPAS_INICIAIS', () => {
  it('tem exatamente uma etapa de ganho e uma de perda', () => {
    // Sem etapa de ganho, `/leads/[id]/win` responde 422 pipeline_no_won_stage —
    // o funil nasceria incapaz de fechar negócio.
    expect(ETAPAS_INICIAIS.filter((e) => e.is_won)).toHaveLength(1);
    expect(ETAPAS_INICIAIS.filter((e) => e.is_lost)).toHaveLength(1);
  });

  it('nenhuma etapa é de ganho e perda ao mesmo tempo (crm_stages_won_lost_mutex)', () => {
    expect(ETAPAS_INICIAIS.some((e) => e.is_won && e.is_lost)).toBe(false);
  });

  it('os slugs respeitam crm_stages_slug_format e não se repetem', () => {
    const slugs = ETAPAS_INICIAIS.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9_-]{2,40}$/);
  });
});
