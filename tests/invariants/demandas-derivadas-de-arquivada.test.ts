/**
 * DIAGNÓSTICO #2992 — as três categorias classificam corretamente numa
 * instalação que aplicou o backfill ANTES do #2825.
 *
 * ## O que este arquivo mede, e por que aqui
 *
 * A issue pede medir antes de propor código. O instrumento da medida é
 * `supabase/diagnostico/demandas-derivadas-de-arquivada.sql`, e o único jeito de
 * saber que ele separa resíduo de demanda legítima é executá-lo, num banco com
 * as três situações de verdade. Reescrever a régua em TypeScript mediria a minha
 * cópia — ela ficaria verde com o SQL sabotado. Então: o bloco é EXTRAÍDO do
 * `baseline.sql` (com UMA linha declarada removida, a do #2825) e o arquivo .sql
 * é LIDO do disco e rodado como está.
 *
 * ## A semente é a instalação antiga, não uma linha escrita à mão
 *
 * `blocoAntesDo2825()` tira do apêndice a guarda `where cv.status <> 'archived'`
 * que o #2825 acrescentou. É literalmente o backfill que rodou em quem
 * atualizou antes do conserto, e por isso a "derivada limpa" do caso 1 nasce do
 * backfill de verdade — não de um `insert` que eu inventei. As conversas são
 * arquivadas por `fn_service_status`, o mesmo comando da porta de API.
 *
 * ## Os casos
 *
 *  1. **derivada limpa** — conversa única, arquivada, intocada: a assinatura do
 *     R2 (`aberta_em` = `conversations.created_at`, `estado` 'aberta', desfecho
 *     e `fechada_em` nulos). É o resíduo que a issue descreve.
 *  2. **ambígua, dois canais** — a mesma demanda com dois vínculos, dois canais,
 *     os dois arquivados: o caso "compartilhada entre canais" da #2822. Apagar
 *     deixaria dois canais sem demanda.
 *  3. **ambígua, card** — `current_demanda_id` aponta para ela. A armadilha
 *     medida: arquivar grava sozinho o próximo passo
 *     `'Revisar atendimento e registrar o desfecho da demanda'`, e um
 *     diagnóstico que tomasse esse texto por trabalho de gente promoveria TODO
 *     resíduo arquivado a legítima — um relatório que sempre recomenda zero.
 *  4. **legítima, próximo passo de gente** — alguém escreveu outro próximo
 *     passo depois do backfill.
 *  5. **legítima, sem vínculo** — vínculo apagado: a consulta não classifica o
 *     que não consegue explicar.
 *  6. **fora do universo** — conversa reaberta depois do backfill: a demanda tem
 *     canal vivo, então não é resíduo e não entra na conta (nem no total).
 *
 * ## Somente-leitura, provado pelo banco
 *
 * A consulta roda dentro de `begin transaction read only`: se um dia ela ganhar
 * um `update`/`delete`, o Postgres recusa e este arquivo fica vermelho. Além
 * disso, um retrato (contagem, ids, estado, desfecho, `fechada_em` e vínculos)
 * é tirado antes e depois — nenhuma linha pode mudar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  CATEGORIAS,
  lerLinhas,
  resumir,
} from "@/scripts/demandas-derivadas-de-arquivada.leitura";

import { GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const CONSULTA = join("supabase", "diagnostico", "demandas-derivadas-de-arquivada.sql");

/** Marcadores do apêndice do baseline — os mesmos do invariante do #2822. */
const MARCADOR_INICIO = "-- ---- Índice de Atrito + DEMANDAS";
const MARCADOR_PROXIMO = "\n-- ---- ";
/** A linha que o #2825 acrescentou ao R2: sem ela, o bloco é o backfill antigo. */
const GUARDA_DO_2825 = "where cv.status <> 'archived'";
/** O que `fn_service_status` grava sozinho ao arquivar (baseline, bloco da 0222). */
const PROXIMO_PASSO_DO_ARQUIVAMENTO = "Revisar atendimento e registrar o desfecho da demanda";

/**
 * O backfill como ele rodava em quem atualizou ANTES do #2825: o bloco do
 * apêndice, com a guarda do conserto substituída por `where true`.
 *
 * Sem a conferência da guarda, um baseline futuro que mudasse a linha faria este
 * seed deixar de reproduzir a instalação antiga EM SILÊNCIO — e o arquivo ficaria
 * verde medindo um cenário que não existe no campo.
 */
function blocoAntesDo2825(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(MARCADOR_INICIO);
  if (inicio < 0) {
    throw new Error(`marcador ${MARCADOR_INICIO} não encontrado em supabase/baseline.sql`);
  }
  const fim = baseline.indexOf(MARCADOR_PROXIMO, inicio + MARCADOR_INICIO.length);
  const bloco = fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim);
  if (!bloco.includes("'derivada'")) {
    throw new Error("bloco extraído não contém o backfill R2 (extração quebrada)");
  }
  if (!bloco.includes(GUARDA_DO_2825)) {
    throw new Error(
      `a guarda '${GUARDA_DO_2825}' sumiu do apêndice — o seed não reproduziria a instalação antiga`,
    );
  }
  return bloco.replace(GUARDA_DO_2825, "where true");
}

const SESSAO_2 = "2992aaaa-2222-4000-8000-000000000002";

const CT_LIMPA = "2992aaaa-0000-4000-8000-000000000001";
const CT_AMBIGUA = "2992aaaa-0000-4000-8000-000000000002";
const CT_CARD = "2992aaaa-0000-4000-8000-000000000003";
const CT_LEGITIMA = "2992aaaa-0000-4000-8000-000000000004";
const CT_SEM_VINCULO = "2992aaaa-0000-4000-8000-000000000005";
const CT_VIVA = "2992aaaa-0000-4000-8000-000000000006";

const CV_LIMPA = "2992aaaa-1111-4000-8000-000000000001";
const CV_AMBIGUA_1 = "2992aaaa-1111-4000-8000-000000000002";
const CV_AMBIGUA_2 = "2992aaaa-1111-4000-8000-000000000003";
const CV_CARD = "2992aaaa-1111-4000-8000-000000000004";
const CV_LEGITIMA = "2992aaaa-1111-4000-8000-000000000005";
const CV_SEM_VINCULO = "2992aaaa-1111-4000-8000-000000000006";
const CV_VIVA = "2992aaaa-1111-4000-8000-000000000007";

const CONTATOS = [CT_LIMPA, CT_AMBIGUA, CT_CARD, CT_LEGITIMA, CT_SEM_VINCULO, CT_VIVA];
const CONVERSAS = [CV_LIMPA, CV_AMBIGUA_1, CV_AMBIGUA_2, CV_CARD, CV_LEGITIMA, CV_SEM_VINCULO, CV_VIVA];

const lista = (valores: readonly string[]) => valores.map((v) => `'${v}'`).join(", ");

/** As colunas que a consulta devolve, na ordem do `select` do .sql. */
const COLUNAS = [
  "categoria",
  "motivo",
  "organization_id",
  "demanda_id",
  "aberta_em",
  "estado",
  "conversas",
  "canais",
  "no_card",
  "mensagens",
  "checkpoints",
  "tarefas",
] as const;

/**
 * Id da demanda derivada ligada a UMA conversa. Determinístico por conversa, ao
 * contrário de "a demanda do contato": durante a montagem da semente o contato
 * ambíguo tem duas, e escolher por contato pegaria a primeira que o banco
 * devolvesse.
 */
function demandaDerivadaDe(conversa: string): string {
  const saida = sql(`
    select d.id
      from public.demandas d
      join public.demanda_conversas dc on dc.demanda_id = d.id
     where d.origem = 'derivada' and dc.conversation_id = '${conversa}';
  `).trim();
  const linhas = saida.split("\n").filter((linha) => linha.trim() !== "");
  if (linhas.length !== 1) {
    throw new Error(`esperava UMA demanda derivada para a conversa ${conversa}, achei ${linhas.length}: ${saida}`);
  }
  return (linhas[0] ?? "").trim();
}

/** Ids das demandas da semente, capturados ANTES da cirurgia que apaga vínculo. */
const DEMANDA: Record<string, string> = {
  limpa: "",
  ambigua: "",
  card: "",
  legitima: "",
  sem_vinculo: "",
  viva: "",
};

/**
 * Roda a consulta DENTRO de transação somente-leitura e devolve as linhas já
 * validadas pelo módulo de leitura. `-tA` imprime uma linha por registro com
 * `|`; as tags de comando (`BEGIN`/`COMMIT`) são descartadas pela forma.
 */
function medir() {
  const consulta = readFileSync(join(process.cwd(), CONSULTA), "utf8");
  const saida = sql(`
    begin transaction read only;
    ${consulta}
    commit;
  `);
  const cruas: Record<string, unknown>[] = [];
  for (const linha of saida.split("\n")) {
    const campos = linha.split("|");
    if (campos.length !== COLUNAS.length) continue;
    const objeto: Record<string, unknown> = {};
    COLUNAS.forEach((coluna, indice) => {
      objeto[coluna] = campos[indice];
    });
    cruas.push(objeto);
  }
  return { linhas: lerLinhas(cruas as ReadonlyArray<Record<string, unknown>>), cruas };
}

/**
 * Só as linhas das demandas que ESTE arquivo semeou. O backfill antigo roda com
 * `where true` sobre o banco inteiro, e a consulta também: contar sobre o banco
 * faria o total depender do que mais existe nele (o molde, ou outro arquivo que
 * divida o banco) — e não do que a semente montou. A derivada da conversa
 * reaberta está no conjunto de propósito: quem a deixa de fora é a CONSULTA, não
 * este filtro.
 */
function daSemente<T extends { readonly demanda_id: string }>(linhas: readonly T[]): T[] {
  const semeadas = new Set(Object.values(DEMANDA));
  return linhas.filter((l) => semeadas.has(l.demanda_id));
}

/** Retrato do que o diagnóstico NÃO pode mexer. */
function retrato(): string {
  return sql(`
    select 'demandas', count(*)::text from public.demandas where contact_id in (${lista(CONTATOS)})
    union all
    select 'vinculos', count(*)::text from public.demanda_conversas dc
      join public.demandas d on d.id = dc.demanda_id
     where d.contact_id in (${lista(CONTATOS)})
    union all
    select 'abertas', count(*)::text from public.demandas
     where contact_id in (${lista(CONTATOS)}) and fechada_em is null
    union all
    select 'com-desfecho', count(*)::text from public.demandas
     where contact_id in (${lista(CONTATOS)}) and desfecho is not null
  `);
}

beforeAll(() => {
  seedGov();

  sql(`
    delete from public.messages where contact_id in (${lista(CONTATOS)});
    delete from public.demanda_conversas
     where demanda_id in (select id from public.demandas where contact_id in (${lista(CONTATOS)}));
    delete from public.demandas where contact_id in (${lista(CONTATOS)});
    delete from public.conversations where contact_id in (${lista(CONTATOS)});
    delete from public.contacts where id in (${lista(CONTATOS)});
    delete from public.channel_sessions where id = '${SESSAO_2}';

    insert into public.contacts (id, organization_id, display_name) values
      ('${CT_LIMPA}',      '${GOV_ORG}', '2992 derivada limpa'),
      ('${CT_AMBIGUA}',    '${GOV_ORG}', '2992 compartilhada entre canais'),
      ('${CT_CARD}',       '${GOV_ORG}', '2992 com card apontando'),
      ('${CT_LEGITIMA}',   '${GOV_ORG}', '2992 com proximo passo de gente'),
      ('${CT_SEM_VINCULO}', '${GOV_ORG}', '2992 sem vinculo'),
      ('${CT_VIVA}',       '${GOV_ORG}', '2992 conversa reaberta');

    -- DO + exception, e não ON CONFLICT: channel_sessions tem unique DEFERRABLE
    -- (phone_per_org) que o ON CONFLICT sem arbiter rejeita — mesma forma do
    -- seedGov (issue #207).
    do $gov$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_2}', '${GOV_ORG}', 'gov-inv-2992', '\\x00'::bytea);
    exception when unique_violation then null; end $gov$;

    -- Todas nascem 'open' e são arquivadas pelo COMANDO da porta de API, não por
    -- UPDATE à mão: é o caminho que carimba status_changed_at/service_closed_at,
    -- e sem ele o backfill estouraria em demandas_desfecho_coerente.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, created_at) values
      ('${CV_LIMPA}',       '${GOV_ORG}', '${CT_LIMPA}',       '${GOV_SESSION}', 'open', '2026-08-01T10:00:00Z'),
      ('${CV_AMBIGUA_1}',   '${GOV_ORG}', '${CT_AMBIGUA}',     '${GOV_SESSION}', 'open', '2026-08-02T10:00:00Z'),
      ('${CV_AMBIGUA_2}',   '${GOV_ORG}', '${CT_AMBIGUA}',     '${SESSAO_2}',    'open', '2026-08-02T11:00:00Z'),
      ('${CV_CARD}',        '${GOV_ORG}', '${CT_CARD}',        '${GOV_SESSION}', 'open', '2026-08-03T10:00:00Z'),
      ('${CV_LEGITIMA}',    '${GOV_ORG}', '${CT_LEGITIMA}',    '${GOV_SESSION}', 'open', '2026-08-04T10:00:00Z'),
      ('${CV_SEM_VINCULO}', '${GOV_ORG}', '${CT_SEM_VINCULO}', '${GOV_SESSION}', 'open', '2026-08-05T10:00:00Z'),
      ('${CV_VIVA}',        '${GOV_ORG}', '${CT_VIVA}',        '${GOV_SESSION}', 'open', '2026-08-06T10:00:00Z');

    select public.fn_service_status('${GOV_ORG}', '${CV_LIMPA}',       'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_AMBIGUA_1}',   'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_AMBIGUA_2}',   'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_CARD}',        'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_LEGITIMA}',    'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_SEM_VINCULO}', 'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_VIVA}',        'archived', null);
  `);

  // O backfill ANTIGO — o que rodou nas instalações de quem atualizou antes do
  // #2825. Aqui nascem as demandas dos seis contatos, uma por conversa.
  sql(`begin; ${blocoAntesDo2825()} commit;`);

  // Ids capturados ANTES da cirurgia: o caso 5 apaga o vínculo, e depois disso
  // "a demanda desta conversa" deixa de existir no banco.
  DEMANDA.limpa = demandaDerivadaDe(CV_LIMPA);
  DEMANDA.ambigua = demandaDerivadaDe(CV_AMBIGUA_1);
  DEMANDA.card = demandaDerivadaDe(CV_CARD);
  DEMANDA.legitima = demandaDerivadaDe(CV_LEGITIMA);
  DEMANDA.sem_vinculo = demandaDerivadaDe(CV_SEM_VINCULO);
  DEMANDA.viva = demandaDerivadaDe(CV_VIVA);

  sql(`
    -- 2) Um canal só não é o caso da #2822: o vínculo do segundo canal entra na
    --    MESMA demanda (é o que o caminho nativo faz quando o cliente muda de
    --    canal), e a derivada que o backfill criou para a conversa 2 sai — o
    --    retrato final de produção tem UMA demanda com dois vínculos.
    insert into public.demanda_conversas (organization_id, demanda_id, conversation_id, service_revision)
    select '${GOV_ORG}', '${DEMANDA.ambigua}', '${CV_AMBIGUA_2}', c.service_revision
      from public.conversations c where c.id = '${CV_AMBIGUA_2}'
    on conflict do nothing;
    delete from public.demandas d
     where d.contact_id = '${CT_AMBIGUA}'
       and d.id <> '${DEMANDA.ambigua}';

    -- 3) O card aponta para a derivada, e a conversa volta a ser arquivada pelo
    --    MESMO comando de produção — que grava o próximo passo de arquivamento
    --    na demanda do card. É a armadilha: card + texto automático, e mesmo
    --    assim ambígua.
    --    A ordem importa e foi medida: reabrir ZERA o current_demanda_id
    --    (fn_service_status, bloco da 0222), então o ponteiro é plantado
    --    DEPOIS da reabertura e ANTES do arquivamento — arquivar preserva o card
    --    (é terminal) e carimba o próximo passo nele.
    select public.fn_service_status('${GOV_ORG}', '${CV_CARD}', 'open', null);
    update public.conversations set current_demanda_id = '${DEMANDA.card}' where id = '${CV_CARD}';
    select public.fn_service_status('${GOV_ORG}', '${CV_CARD}', 'archived', null);

    -- 4) Próximo passo escrito por gente, diferente do texto do arquivamento.
    update public.demandas set proximo_passo = 'ligar de volta amanha de manha'
     where id = '${DEMANDA.legitima}';

    -- 5) Vínculo apagado: a demanda existe, a conversa existe, a ligação não.
    delete from public.demanda_conversas dc
     using public.demandas d
     where dc.demanda_id = d.id and d.contact_id = '${CT_SEM_VINCULO}';

    -- 6) A conversa reabre depois do backfill: a demanda passa a ter canal vivo
    --    e sai do universo (não é resíduo de nada).
    select public.fn_service_status('${GOV_ORG}', '${CV_VIVA}', 'open', null);
  `);
});

describe("o diagnóstico separa resíduo de demanda legítima numa instalação anterior ao #2825", () => {
  it("precondição: o cenário é o que a consulta supõe (seis derivadas, sete conversas)", () => {
    // Sem esta conferência, fixture que não semeou nada faria as contagens
    // abaixo passarem com 0 == 0 — verde por não medir.
    const derivadas = sql(`select count(*) from public.demandas
      where contact_id in (${lista(CONTATOS)}) and origem = 'derivada';`).trim();
    expect(derivadas).toBe("6");
    const arquivadas = sql(`select count(*) from public.conversations
      where id in (${lista(CONVERSAS)}) and status = 'archived';`).trim();
    // Sete conversas semeadas; a do caso 6 foi reaberta de propósito. Se o
    // arquivamento tivesse falhado em qualquer uma, o universo encolheria e as
    // contagens de categoria passariam a medir outra coisa.
    expect(arquivadas).toBe("6");
    expect(
      sql(`select proximo_passo from public.demandas where contact_id = '${CT_CARD}';`).trim(),
      "o comando de arquivar não gravou o próximo passo automático — a armadilha do caso 3 não está montada",
    ).toBe(PROXIMO_PASSO_DO_ARQUIVAMENTO);
  });

  it("1. derivada limpa: conversa única arquivada, intocada — a assinatura do backfill", () => {
    const { linhas } = medir();
    const daLimpa = linhas.find((l) => l.demanda_id === DEMANDA.limpa);
    expect(daLimpa, "a derivada limpa não apareceu na medição").toBeDefined();
    expect(daLimpa?.categoria).toBe("derivada_limpa");
    expect(daLimpa?.motivo).toBe("conversa_arquivada_sem_mais_nada");
    expect(daLimpa?.conversas).toBe(1);
    expect(daLimpa?.canais).toBe(1);
    expect(daLimpa?.no_card).toBe(false);
  });

  it("2. ambígua: a demanda compartilhada entre dois canais não é resíduo", () => {
    const { linhas } = medir();
    const daAmbigua = linhas.find((l) => l.demanda_id === DEMANDA.ambigua);
    expect(daAmbigua, "a demanda de dois canais não apareceu na medição").toBeDefined();
    expect(daAmbigua?.categoria).toBe("ambigua");
    expect(daAmbigua?.motivo).toBe("compartilhada_entre_canais");
    expect(daAmbigua?.conversas).toBe(2);
    expect(daAmbigua?.canais).toBe(2);
  });

  it("3. ambígua: card apontando para ela, MESMO com o próximo passo do arquivamento", () => {
    const { linhas } = medir();
    const doCard = linhas.find((l) => l.demanda_id === DEMANDA.card);
    expect(doCard, "a demanda com card não apareceu na medição").toBeDefined();
    // Se o texto automático do arquivamento contasse como trabalho de gente, este
    // caso sairia 'legitima' — e todo resíduo arquivado sairia igual.
    expect(doCard?.categoria).toBe("ambigua");
    expect(doCard?.motivo).toBe("card_aponta_para_ela");
    expect(doCard?.no_card).toBe(true);
  });

  it("4. legítima: próximo passo escrito por gente", () => {
    const { linhas } = medir();
    const daLegitima = linhas.find((l) => l.demanda_id === DEMANDA.legitima);
    expect(daLegitima, "a demanda trabalhada não apareceu na medição").toBeDefined();
    expect(daLegitima?.categoria).toBe("legitima");
    expect(daLegitima?.motivo).toBe("proximo_passo_de_gente");
  });

  it("5. legítima: sem vínculo, a consulta não classifica o que não explica", () => {
    const { linhas } = medir();
    const semVinculo = linhas.find((l) => l.demanda_id === DEMANDA.sem_vinculo);
    expect(semVinculo, "a demanda sem vínculo não apareceu na medição").toBeDefined();
    expect(semVinculo?.categoria).toBe("legitima");
    expect(semVinculo?.motivo).toBe("sem_vinculo");
    expect(semVinculo?.conversas).toBe(0);
  });

  it("a contagem por categoria é a da semente, e a conversa reaberta fica FORA", () => {
    // Seis ids distintos e preenchidos: um filtro sobre conjunto vazio ou
    // repetido deixaria as contagens abaixo verdes por não medir.
    expect(new Set(Object.values(DEMANDA).filter((id) => id !== "")).size).toBe(6);
    const linhas = daSemente(medir().linhas);
    const resumo = resumir(linhas);
    expect(resumo.total, "o universo contou a demanda com canal vivo").toBe(5);
    expect(resumo.porCategoria.derivada_limpa).toBe(1);
    expect(resumo.porCategoria.ambigua).toBe(2);
    expect(resumo.porCategoria.legitima).toBe(2);
    for (const categoria of CATEGORIAS) {
      expect(resumo.porCategoria[categoria]).toBeGreaterThanOrEqual(0);
    }
    const daViva = linhas.find((l) => l.demanda_id === DEMANDA.viva);
    expect(daViva, "a derivada de conversa reaberta entrou na conta").toBeUndefined();
    // Uma instalação só, e é a do seed: nada de linha de outro tenant.
    expect(resumo.porOrganizacao.map((o) => o.organization_id)).toEqual([GOV_ORG]);
  });

  it("a consulta é somente-leitura: roda em transação read only e não muda uma linha", () => {
    const antes = retrato();
    const linhas = daSemente(medir().linhas);
    const depois = retrato();
    expect(linhas.length).toBeGreaterThan(0);
    expect(depois, "o diagnóstico escreveu no banco").toBe(antes);
    // Nenhum desfecho inventado: a constraint `demandas_desfecho_coerente` exige
    // desfecho junto de fechada_em, e escolher um para estas linhas afirmaria o
    // que não aconteceu (#2992).
    expect(
      sql(`select count(*) from public.demandas
            where contact_id in (${lista(CONTATOS)}) and (desfecho is not null or fechada_em is not null);`).trim(),
    ).toBe("0");
  });
});
