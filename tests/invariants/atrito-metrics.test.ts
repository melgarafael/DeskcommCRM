import { beforeAll, describe, expect, it } from "vitest";

import { razao } from "@/lib/metrics/atrito";

import { GOV_ORG, GOV_PIPELINE, GOV_SESSION, GOV_STAGE, GOV_AGENT_A, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * fn_atrito_metrics — a medida do PROPÓSITO (spec 17, migration 0133).
 *
 * ## Por que isto vive num invariante de banco
 *
 * O typecheck NÃO vigia nome de RPC: medido nesta sessão com um controle
 * (`s.rpc("fn_nome_que_nao_existe_xyz")` passa no `tsc --noEmit` sem uma linha
 * de erro). Então a rota compilar não prova que a função existe, muito menos
 * que ela conta certo. Um unitário com dublê provaria que a rota chama; só o
 * Postgres prova que a agregação agrega.
 *
 * ## O que se guarda aqui
 *
 * 1. **Os números.** Cada componente tem um valor DISTINTO na fixture, para que
 *    trocar dois campos de lugar reprove em vez de passar batido.
 * 2. **O isolamento.** A função é SECURITY INVOKER de propósito. Um usuário da
 *    org A pedindo `p_org` da org B tem que receber ZERO — não os dados dela.
 *    Se alguém a promover a SECURITY DEFINER "para simplificar", este teste
 *    vermelha antes de a promoção virar vazamento entre inquilinos.
 * 3. **A ausência é null.** Janela sem demanda devolve `null` nos campos que
 *    dependem de denominador, nunca `0` — zero ali afirmaria "sem atrito" onde
 *    o certo é "não medido".
 */

const VIZINHA = "aeae0000-0000-4000-8000-000000000001";
const CONTATO_BLOQ = "aeae1111-0000-4000-8000-000000000001";
const CONTATO_VIZ = "aeae1111-0000-4000-8000-000000000002";
/**
 * Contato PRÓPRIO, não um do seed compartilhado. Duas razões, ambas medidas:
 * `conversations` tem unique por (org, contato, sessão) e o seed já gastou o par
 * (GOV_CONTACT_1, GOV_SESSION) — reusá-lo fazia meu insert cair no `on conflict
 * do nothing` em SILÊNCIO e a FK do caso estourar depois, longe da causa. E
 * mensagem de outra suíte na mesma conversa contaminaria turnos e envios daqui.
 */
const CONTATO_CASO = "aeae1111-0000-4000-8000-000000000003";
const CONV = "aeae2222-0000-4000-8000-000000000001";
const CONV_VIZ = "aeae2222-0000-4000-8000-000000000002";
const SESSION_VIZ = "aeae2222-0000-4000-8000-0000000000ff";
const CASO_1 = "aeae3333-0000-4000-8000-000000000001";
const CASO_2 = "aeae3333-0000-4000-8000-000000000002";
const CASO_VIZ = "aeae3333-0000-4000-8000-000000000003";
const JOB_1 = "aeae4444-0000-4000-8000-000000000001";
const JOB_2 = "aeae4444-0000-4000-8000-000000000002";
const DEM_1 = "aeae6666-0000-4000-8000-000000000001";
const DEM_2 = "aeae6666-0000-4000-8000-000000000002";
const DEM_VIZ = "aeae6666-0000-4000-8000-000000000003";
const CONV_RESPONDIDA = "aeae2222-0000-4000-8000-000000000009";
const CONTATO_RESP = "aeae1111-0000-4000-8000-000000000009";
const LEAD_GANHO = "aeae5555-0000-4000-8000-000000000001";

/** Janela FIXA — nada depende de now(), então a fixture não envelhece. */
const DE = "2026-03-01T00:00:00Z";
const ATE = "2026-04-01T00:00:00Z";

/** Chama a função como `authenticated` com os claims do usuário. */
function atritoComo(userId: string, org: string, horas = 72, de = DE, ate = ATE): Record<string, Record<string, number | null>> {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select public.fn_atrito_metrics('${org}'::uuid, '${de}'::timestamptz, '${ate}'::timestamptz, ${horas});
  `);
  return JSON.parse(lastLine(out));
}

beforeAll(() => {
  seedGov();
  // Idempotência por LIMPEZA, não por ON CONFLICT: `agent_cases` tem unique
  // deferrable e o Postgres recusa usá-la como árbitro. Ordem inversa das FKs.
  sql(`
    delete from public.demanda_conversas where demanda_id in ('${DEM_1}', '${DEM_2}', '${DEM_VIZ}');
    delete from public.demandas where id in ('${DEM_1}', '${DEM_2}', '${DEM_VIZ}');
    delete from public.agent_case_events where case_id in ('${CASO_1}', '${CASO_2}', '${CASO_VIZ}');
    delete from public.agent_cases       where id in ('${CASO_1}', '${CASO_2}', '${CASO_VIZ}');
    delete from public.before_send_traces where job_id in ('${JOB_1}', '${JOB_2}');
    delete from public.job_queue          where id in ('${JOB_1}', '${JOB_2}');
    delete from public.messages           where conversation_id in ('${CONV}', '${CONV_VIZ}', '${CONV_RESPONDIDA}');
    delete from public.crm_lead_activities where lead_id = '${LEAD_GANHO}';
    delete from public.crm_leads          where id = '${LEAD_GANHO}';
    delete from public.conversations      where id in ('${CONV}', '${CONV_VIZ}', '${CONV_RESPONDIDA}');
    delete from public.contacts           where id in ('${CONTATO_CASO}', '${CONTATO_BLOQ}', '${CONTATO_VIZ}', '${CONTATO_RESP}');
  `);
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${VIZINHA}', 'atrito-vizinha', 'Vizinha Atrito', 'Vizinha');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSION_VIZ}', '${VIZINHA}', 'atrito-viz', '\\x00'::bytea);

    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_CASO}', '${GOV_ORG}', 'Contato do Caso');
    insert into public.contacts (id, organization_id, display_name, blocked_at, is_blocked)
      values ('${CONTATO_BLOQ}', '${GOV_ORG}', 'Contato Descadastrado', '2026-03-10T00:00:00Z', true);
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_VIZ}', '${VIZINHA}', 'Contato Vizinho');

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV}', '${GOV_ORG}', '${CONTATO_CASO}', '${GOV_SESSION}', 'open');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_VIZ}', '${VIZINHA}', '${CONTATO_VIZ}', '${SESSION_VIZ}', 'open');

    -- ABANDONO: falamos por último e a pessoa não voltou (CONV) × a pessoa
    -- voltou depois da nossa fala (CONV_RESPONDIDA, controle negativo — sem ele
    -- o teste não distingue "conta abandono" de "conta toda conversa").
    update public.conversations
       set last_outbound_at = '2026-03-20T12:00:00Z', last_inbound_at = '2026-03-20T10:00:00Z'
     where id = '${CONV}';

    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_RESP}', '${GOV_ORG}', 'Contato Que Respondeu');
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, last_outbound_at, last_inbound_at)
      values ('${CONV_RESPONDIDA}', '${GOV_ORG}', '${CONTATO_RESP}', '${GOV_SESSION}', 'open',
              '2026-03-21T00:00:00Z', '2026-03-22T10:00:00Z');

    -- A conversa respondida também recebeu uma mensagem no dia anterior ao
    -- follow-up que aparece em last_outbound_at.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
    values
      ('${GOV_ORG}', '${CONV_RESPONDIDA}', '${GOV_SESSION}', '${CONTATO_RESP}', 'text',
       'outbound', 'sent', 'system', '2026-03-20T00:00:00Z'),
      ('${GOV_ORG}', '${CONV_RESPONDIDA}', '${GOV_SESSION}', '${CONTATO_RESP}', 'text',
       'outbound', 'sent', 'system', '2026-03-21T00:00:00Z'),
      ('${GOV_ORG}', '${CONV_RESPONDIDA}', '${GOV_SESSION}', '${CONTATO_RESP}', 'text',
       'inbound', 'received', 'system', '2026-03-22T10:00:00Z');

    -- DUAS demandas encerradas na janela. followup_attempts 4 e 0 → média 2, máx 4.
    insert into public.agent_cases
      (id, organization_id, conversation_id, status, title, summary, blocker,
       followup_attempts, opened_at, closed_at)
    values
      ('${CASO_1}', '${GOV_ORG}', '${CONV}', 'resolved', 'Caso 1', 'resumo', 'bloqueio',
       4, '2026-03-05T10:00:00Z', '2026-03-06T10:00:00Z'),
      ('${CASO_2}', '${GOV_ORG}', '${CONV}', 'resolved', 'Caso 2', 'resumo', 'bloqueio',
       0, '2026-03-08T10:00:00Z', '2026-03-08T12:00:00Z');

    -- A vizinha tem demanda na MESMA janela: se vazar, os números mudam.
    insert into public.agent_cases
      (id, organization_id, conversation_id, status, title, summary, blocker,
       followup_attempts, opened_at, closed_at)
    values
      ('${CASO_VIZ}', '${VIZINHA}', '${CONV_VIZ}', 'resolved', 'Caso Vizinho', 'r', 'b',
       99, '2026-03-05T10:00:00Z', '2026-03-06T10:00:00Z');

    -- FASE 4: o denominador agora e a tabela demandas. Elas espelham os casos
    -- (mesma abertura e fechamento) e apontam para eles por agent_case_id: e
    -- assim que insistencia e toque humano continuam ligados.
    insert into public.demandas
      (id, organization_id, contact_id, agent_case_id, aberta_em, origem, estado, dono_kind, desfecho, fechada_em)
    values
      ('${DEM_1}', '${GOV_ORG}', '${CONTATO_CASO}', '${CASO_1}', '2026-03-05T10:00:00Z', 'handoff', 'resolvida', 'ia', 'resolvida', '2026-03-06T10:00:00Z'),
      ('${DEM_2}', '${GOV_ORG}', '${CONTATO_CASO}', '${CASO_2}', '2026-03-08T10:00:00Z', 'handoff', 'resolvida', 'ia', 'resolvida', '2026-03-08T12:00:00Z'),
      ('${DEM_VIZ}', '${VIZINHA}', '${CONTATO_VIZ}', '${CASO_VIZ}', '2026-03-05T10:00:00Z', 'handoff', 'resolvida', 'ia', 'resolvida', '2026-03-06T10:00:00Z');
    insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
    values
      ('${GOV_ORG}', '${DEM_1}', '${CONV}'),
      ('${GOV_ORG}', '${DEM_2}', '${CONV}'),
      ('${VIZINHA}', '${DEM_VIZ}', '${CONV_VIZ}');

    -- Toque humano SÓ no caso 1: 2 eventos, primeiro 600s após a abertura.
    insert into public.agent_case_events (organization_id, case_id, kind, actor_kind, created_at)
    values
      ('${GOV_ORG}', '${CASO_1}', 'human_replied', 'human', '2026-03-05T10:10:00Z'),
      ('${GOV_ORG}', '${CASO_1}', 'escalated',     'human', '2026-03-05T11:00:00Z');

    -- Mensagens DENTRO da vida do caso 1 (3) e do caso 2 (1) → turnos 3 e 1, p50 = 2.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at)
    values
      ('${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${CONTATO_CASO}', 'text', 'inbound',  'received', 'ai',              '2026-03-05T10:05:00Z'),
      ('${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${CONTATO_CASO}', 'text', 'outbound', 'sent',     'ai',              '2026-03-05T10:06:00Z'),
      ('${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${CONTATO_CASO}', 'text', 'outbound', 'sent',     'ai',              '2026-03-05T10:07:00Z'),
      ('${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${CONTATO_CASO}', 'text', 'outbound', 'sent',     'ai',              '2026-03-08T11:00:00Z'),
      -- Fora da vida de qualquer caso, mas DENTRO da janela: conta em envios, não em turnos.
      ('${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${CONTATO_CASO}', 'text', 'outbound', 'sent',     'user',            '2026-03-20T10:00:00Z'),
      ('${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${CONTATO_CASO}', 'text', 'outbound', 'sent',     'user',            '2026-03-20T11:00:00Z'),
      ('${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${CONTATO_CASO}', 'text', 'outbound', 'sent',     'external_device', '2026-03-20T12:00:00Z');

    -- Vetos: 2 execuções distintas, 1 vetada.
    insert into public.job_queue (id, organization_id, contact_id, kind)
      values ('${JOB_1}', '${GOV_ORG}', '${CONTATO_CASO}', 'inbound_turn'),
             ('${JOB_2}', '${GOV_ORG}', '${CONTATO_CASO}', 'inbound_turn');
    insert into public.before_send_traces
      (organization_id, job_id, contact_id, channel_session_id, trace, vetoed_gate, created_at)
    values
      ('${GOV_ORG}', '${JOB_1}', '${CONTATO_CASO}', '${GOV_SESSION}', '[]'::jsonb, 'stop',  '2026-03-12T10:00:00Z'),
      ('${GOV_ORG}', '${JOB_2}', '${CONTATO_CASO}', '${GOV_SESSION}', '[]'::jsonb, null,    '2026-03-12T11:00:00Z');

    -- O lead vem ANTES da activity: a FK exige, e um segundo beforeAll não
    -- garantiria a ordem — garantiria só uma violação mais difícil de ler.
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, status, closed_at)
    values ('${LEAD_GANHO}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Ganho', 'won', '2026-03-18T10:00:00Z');

    -- UM pedido de humano na timeline (inserir duas vezes faria a contagem virar 2).
    insert into public.crm_lead_activities
      (organization_id, lead_id, source_module, type, performed_at)
    values ('${GOV_ORG}', '${LEAD_GANHO}', 'agent', 'handoff_triggered', '2026-03-15T10:00:00Z');
  `);
});

describe("fn_atrito_metrics — os números", () => {
  it("conta as demandas encerradas na janela, e só as da própria org", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(m.escopo!.demandas).toBe(2);
  });

  it("insistência: média 2 e máximo 4 — a vizinha tem 99 e não entra", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.cliente!.insistencia_media)).toBeCloseTo(2, 6);
    expect(Number(m.cliente!.insistencia_max)).toBe(4);
  });

  it("turnos contam só as mensagens DENTRO da vida da demanda", () => {
    // Caso 1 tem 3 mensagens entre abertura e fechamento; caso 2 tem 1.
    // As 3 de 20/03 estão fora de qualquer caso → não entram. p50 de [1,3] = 2.
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.cliente!.turnos_p50)).toBeCloseTo(2, 6);
  });

  it("espera na fila humana é da abertura até o PRIMEIRO toque humano", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.empresa!.espera_humana_p50_s)).toBeCloseTo(600, 6);
  });

  it("intervenções por demanda considera as demandas SEM toque humano", () => {
    // Caso 1: 2 eventos humanos. Caso 2: nenhum. Média = 1, não 2 — o left join
    // é o que impede a demanda resolvida sozinha de sumir do denominador.
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.empresa!.intervencoes_por_demanda)).toBeCloseTo(1, 6);
  });

  it("retrabalho conta a demanda que precisou subir de nível", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.empresa!.retrabalho)).toBe(1);
  });

  it("envios separam IA, humano no sistema e humano POR FORA", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.empresa!.envios_por_ia)).toBe(3);
    expect(Number(m.empresa!.envios_humano_no_sistema)).toBe(2);
    expect(Number(m.empresa!.envios_humano_fora)).toBe(1);
  });

  it("vetos: 1 vetado em 2 execuções medidas", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.empresa!.vetos)).toBe(1);
    expect(Number(m.empresa!.execucoes_medidas)).toBe(2);
  });

  it("descadastro e pedido de humano entram pelos seus próprios carimbos", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.cliente!.descadastros)).toBe(1);
    expect(Number(m.cliente!.pedidos_de_humano)).toBe(1);
  });
});

describe("fn_atrito_metrics — abandono (Fase 2)", () => {
  it("conta a conversa em que falamos por último e a pessoa não voltou", () => {
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.cliente!.abandonos)).toBe(1);
  });

  it("NÃO conta a conversa em que a pessoa respondeu depois da nossa fala", () => {
    // Controle negativo: as DUAS conversas têm last_outbound_at na janela. Sem
    // esta asserção, um predicado que contasse toda conversa com fala nossa
    // daria 2 e o teste acima passaria por engano.
    const m = atritoComo(GOV_AGENT_A, GOV_ORG);
    expect(Number(m.cliente!.conversas_com_fala_nossa)).toBe(2);
    expect(Number(m.cliente!.abandonos)).toBeLessThan(
      Number(m.cliente!.conversas_com_fala_nossa),
    );
  });

  it("mantém na base do dia a conversa com novo envio e resposta depois da janela", () => {
    const { cliente } = atritoComo(GOV_AGENT_A, GOV_ORG, 72, "2026-03-20T00:00:00Z", "2026-03-21T00:00:00Z");
    const abandonos = Number(cliente!.abandonos);
    const conversas = Number(cliente!.conversas_com_fala_nossa);
    expect(abandonos).toBe(1);
    expect(razao(abandonos, conversas)).toBe(0.5);
    expect(conversas).toBe(2);
  });

  it("a RÉGUA governa: janela larga o bastante não acusa abandono nenhum", () => {
    // Mesma fixture, régua diferente. Se o número não mudar, p_abandono_horas
    // está sendo ignorado e a configuração da tela seria decorativa.
    const largo = atritoComo(GOV_AGENT_A, GOV_ORG, 24 * 365 * 50);
    expect(Number(largo.cliente!.abandonos)).toBe(0);
  });

  it("a régua usada volta no payload, junto do número", () => {
    // Cap. 3.4 regra 4: número sem régua não é comparável entre períodos.
    const m = atritoComo(GOV_AGENT_A, GOV_ORG, 96);
    expect(Number(m.escopo!.abandono_horas)).toBe(96);
  });
});

describe("fn_atrito_jaccard — o detector de repergunta (Fase 3)", () => {
  function jac(a: string, b: string): number {
    return Number(lastLine(sql(`select public.fn_atrito_jaccard('${a}', '${b}');`)));
  }

  it("repergunta quase literal fica ACIMA do limiar 0.7", () => {
    expect(jac("qual o prazo de entrega do pedido", "qual o prazo de entrega desse pedido"))
      .toBeGreaterThanOrEqual(0.7);
  });

  it("pergunta DIFERENTE sobre o mesmo tema fica ABAIXO — falso positivo é o risco caro", () => {
    // "horário aos sábados" × "aos domingos" mede 0.67 na calibração. Se esta
    // asserção quebrar, o painel passa a acusar repergunta onde não houve, e
    // alguém vai "consertar" um agente que está certo.
    expect(jac("qual o horario de funcionamento aos sabados", "qual o horario de funcionamento aos domingos"))
      .toBeLessThan(0.7);
  });

  /**
   * OS CASOS ACIMA COMPARAM CONTRA O LITERAL `0.7` ESCRITO AQUI — não contra o
   * limiar que a função de fato aplica. Medido na triagem pós-merge: baixar o
   * default de `p_repeticao_min` de 0.7 para 0.5 no banco e rodar este arquivo
   * inteiro dá **20 passed, exit 0**. A calibração estava documentada em três
   * lugares (a migration 0135, o MANIFEST e o HANDOFF) e protegida em nenhum.
   *
   * A "bateria de 15 pares" citada nessa documentação **não existe como
   * artefato executável** — é prosa, e por isso não dá para recriá-la sem
   * inventar dado. O que dá para medir são pares reais, e é disso que os três
   * casos abaixo são feitos.
   *
   * Correção de fato, para o registro: o HANDOFF cita o par de sábados×domingos
   * como `0.67`. Medido aqui, com a frase curta, ele dá **0.600**. O número da
   * prosa não bate com a função; o que vale é o medido.
   */
  function limiarEmVigor(): number {
    const args = lastLine(
      sql(`select pg_get_function_arguments(oid) from pg_proc where proname = 'fn_atrito_metrics';`),
    );
    const m = /p_repeticao_min\s+double precision\s+DEFAULT\s+([0-9.]+)/i.exec(args);
    if (m === null) throw new Error(`não achei p_repeticao_min na assinatura: ${args}`);
    return Number(m[1]);
  }

  it("o limiar EM VIGOR é 0.7 — o valor calibrado, não um que alguém baixou", () => {
    expect(limiarEmVigor()).toBe(0.7);
  });

  it("o falso positivo conhecido fica abaixo do limiar EM VIGOR, não de um literal", () => {
    // 0.600 medido. É pergunta DIFERENTE sobre o mesmo tema; contá-la como
    // repergunta levaria alguém a "consertar" um agente que está certo, e a
    // assimetria de custo é o que justifica 0.7. Ler o limiar da função (e não
    // escrever 0.7 aqui) é o que faz baixar o default reprovar.
    const jaccard = jac("qual o horario aos sabados", "qual o horario aos domingos");
    expect(jaccard).toBeGreaterThan(0.5); // guarda de vacuidade: o par é mesmo parecido
    expect(jaccard).toBeLessThan(limiarEmVigor());
  });

  it("e a repergunta de verdade continua ACIMA do limiar em vigor (guarda de vacuidade)", () => {
    // Sem este caso, SUBIR o limiar passaria: nada seria falso positivo porque
    // nada seria positivo, e a métrica reportaria zero repergunta para sempre.
    //
    // O par importa. A primeira versão deste caso usava "qual o prazo de
    // entrega" × "qual o prazo da entrega", que mede **1.000** — com ele, subir
    // o limiar para 0.99 continuava passando, e a guarda era inerte. Medido:
    // previ 2 vermelhos nessa sabotagem e observei 1.
    //
    // Este par mede **0.750**: é repergunta de verdade (a pessoa repetiu a mesma
    // pergunta trocando uma palavra) e fica na faixa que o limiar pode invadir.
    expect(jac("voces parcelam a compra", "voces parcelam essa compra")).toBeGreaterThanOrEqual(
      limiarEmVigor(),
    );
  });

  it("assunto sem relação mede zero", () => {
    expect(jac("qual o prazo de entrega", "voces aceitam cartao de credito")).toBe(0);
  });

  it("texto vazio não divide por zero", () => {
    expect(jac("", "qualquer coisa")).toBe(0);
    expect(jac("", "")).toBe(0);
  });

  it("a limitação declarada é REAL: reformulação com outro vocabulário escapa", () => {
    // Isto NÃO é um defeito escondido — é o limite medido da camada lexical, e
    // está escrito no cabeçalho da 0135 e na nota que a tela exibe. O teste
    // existe para que ninguém "conserte" o número baixando o limiar sem antes
    // recalibrar os falsos positivos.
    expect(jac("qual o prazo de entrega", "quanto tempo demora pra chegar")).toBeLessThan(0.7);
  });
});

describe("fn_atrito_metrics — isolamento entre organizações", () => {
  it("usuário da org A pedindo p_org da vizinha recebe ZERO, não os dados dela", () => {
    // A vizinha tem 1 demanda com followup_attempts=99 na MESMA janela. Se a
    // função virar SECURITY DEFINER, isto passa a devolver 1 e 99.
    const m = atritoComo(GOV_AGENT_A, VIZINHA);
    expect(m.escopo!.demandas).toBe(0);
    expect(m.cliente!.insistencia_max).toBeNull();
  });
});

describe("fn_atrito_metrics — ausência é null, nunca zero", () => {
  it("janela sem demanda devolve null nos campos com denominador", () => {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
      select public.fn_atrito_metrics('${GOV_ORG}'::uuid,
        '2019-01-01T00:00:00Z'::timestamptz, '2019-02-01T00:00:00Z'::timestamptz, 72);
    `);
    const m = JSON.parse(lastLine(out));
    expect(m.escopo.demandas).toBe(0);
    expect(m.cliente.turnos_p50).toBeNull();
    expect(m.cliente.insistencia_media).toBeNull();
    expect(m.empresa.espera_humana_p50_s).toBeNull();
    // Contagens puras podem ser 0 — elas não dependem de denominador.
    expect(m.cliente.descadastros).toBe(0);
  });
});
