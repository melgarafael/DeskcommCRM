/**
 * A CONVERSA SEM DONO E SEM TRAVA PERTENCE A QUEM PODE RESPONDER (issue #4012).
 *
 * ─── O defeito, em uma linha ────────────────────────────────────────────────
 *
 * `fn_comando_da_conversa` (SQL) devolvia `automatico` para TODA conversa sem
 * dono e sem trava, sem perguntar se a organização tem agente no ar. O
 * TypeScript pergunta (`comandoDaConversa` com `automaticoDaOrg === false` →
 * `ninguem`, `lib/inbox/comando-da-conversa.ts:249`). Duas réguas para a mesma
 * pergunta: a Fila compensava no servidor (`comandosDaFila` pede `automatico`
 * junto com `aguardando`), mas as funções do BANCO que decidem pelo comando não
 * compensavam — `fn_definir_carteira_do_cliente` (#3642), `fn_conversa_que_continua`
 * e a adoção de `fn_conversation_assign` só passam conversas com
 * `comando_da_conversa(c) <> 'automatico'`. Numa instalação sem IA no ar, passar
 * o cliente para um vendedor não levava conversa nenhuma.
 *
 * ─── O que este arquivo mede, e por que em banco de verdade ─────────────────
 *
 * Só o Postgres responde as duas perguntas que decidem o caso: qual é o comando
 * da linha (o campo calculado, com `now()` de verdade e o bit de trava do
 * contato) e o que a carteira faz com ela. Um dublê de `.eq()` não prova nem um
 * nem outro. Por isso tudo aqui roda via `pnpm test:db` (baseline aplicado,
 * install E update, ON_ERROR_STOP=1).
 *
 * ─── A matriz, e o que cada bloco existe para impedir ───────────────────────
 *
 * - **A** é o RED literal: a MESMA conversa, comando do banco × comando do TS,
 *   numa organização sem agente. Antes do conserto o banco diz `automatico` e o
 *   TS diz `ninguem`.
 * - **B** exaure os ESTADOS DE AGENTE que decidem o fato org-wide (nenhum,
 *   nunca publicado, publicado, pausado, arquivado) — a régua da organização é
 *   `agenteAtende` (`lib/ai/agents/no-ar.ts`), e ela é quem o TS do comando usa.
 * - **C** é o LADO OPOSTO, sem o qual "virar tudo `ninguem`" passaria: com dono
 *   continua `humano`, travada continua `aguardando`, grupo continua
 *   `aguardando`, encerrada continua `encerrada`, e org COM agente publicado
 *   continua `automatico`.
 * - **D** prova o efeito que a issue nomeia: a carteira (#3642) passa a levar a
 *   conversa no caso "org sem agente" — e continua NÃO levando a que a IA
 *   atende, na org com agente publicado (o Doc 237, escolha 3-B, segue de pé).
 * - **E** prova que a Fila não perde a conversa: o filtro que o servidor manda
 *   (`comandosDaFila`) alcança a linha real.
 */
import { describe, expect, it } from "vitest";

import { agenteAtende, type FatosDoAgente } from "@/lib/ai/agents/no-ar";
import { comandoDaConversa, comandosDaFila } from "@/lib/inbox/comando-da-conversa";

import { lastLine, sql } from "./gov-helpers";

/** Os estados de agente que respondem "esta org tem atendimento automático?". */
type EstadoDeAgente = "sem_agente" | "pre_go_live" | "publicado" | "pausado" | "arquivado";

const CASOS: readonly {
  caso: EstadoDeAgente;
  /** `null` = a organização não tem NENHUMA linha em `ai_agents`. */
  agente: { publicado: boolean; pausado: boolean; arquivado: boolean } | null;
  /** A mesma pergunta, respondida por `agenteAtende` — o oráculo do TS. */
  atende: boolean;
}[] = [
  // Nunca configurou agente. É o estado de todo primeiro deploy.
  { caso: "sem_agente", agente: null, atende: false },
  // Agente criado e NUNCA publicado: em pré-go-live, ninguém responde.
  { caso: "pre_go_live", agente: { publicado: false, pausado: false, arquivado: false }, atende: false },
  // O único estado que atende.
  { caso: "publicado", agente: { publicado: true, pausado: false, arquivado: false }, atende: true },
  // Pausado pela tela: a versão segue publicada, o atendimento não.
  { caso: "pausado", agente: { publicado: true, pausado: true, arquivado: false }, atende: false },
  { caso: "arquivado", agente: { publicado: true, pausado: false, arquivado: true }, atende: false },
];

/**
 * Ids por caso, determinísticos e fora da faixa que os outros invariantes usam.
 * O sufixo de duas posições é o índice do caso em `CASOS`.
 */
function ids(caso: EstadoDeAgente) {
  const n = String(CASOS.findIndex((c) => c.caso === caso) + 1).padStart(2, "0");
  const sufixo = (prefixo: string) => `aaaaaaaa-0000-4000-8000-${prefixo}${n}`;
  return {
    org: sufixo("00000000a1"),
    sessao: sufixo("00000000a2"),
    contato: sufixo("00000000a3"),
    contatoTravado: sufixo("00000000a4"),
    contatoComDono: sufixo("00000000c1"),
    contatoGrupo: sufixo("00000000c2"),
    contatoEncerrada: sufixo("00000000c3"),
    conversaLivre: sufixo("00000000a5"),
    conversaComDono: sufixo("00000000a6"),
    conversaTravada: sufixo("00000000a7"),
    conversaGrupo: sufixo("00000000a8"),
    conversaEncerrada: sufixo("00000000a9"),
    agente: sufixo("00000000b1"),
    versao: sufixo("00000000b2"),
    gerente: sufixo("00000000b3"),
    vendedor: sufixo("00000000b4"),
  };
}

/** Semeia a organização do caso com as cinco conversas da matriz. */
function semear(caso: (typeof CASOS)[number]): void {
  const i = ids(caso.caso);
  const a = caso.agente;
  sql(`
    delete from conversations where organization_id = '${i.org}';
    delete from contacts where organization_id = '${i.org}';
    -- Versão antes de agente (a FK vai de versão para agente), e as duas antes da
    -- sessão: semear() é chamada mais de uma vez no arquivo e precisa ser
    -- idempotente — um bloco que herda o estado de outro mede o bloco anterior.
    delete from ai_agent_versions where organization_id = '${i.org}';
    delete from ai_agents where organization_id = '${i.org}';
    delete from channel_sessions where organization_id = '${i.org}';
    delete from user_organizations where organization_id = '${i.org}';
    delete from organizations where id = '${i.org}';

    insert into auth.users (id, email) values
      ('${i.gerente}', 'gerente-${caso.caso}-4012@invariant.test'),
      ('${i.vendedor}', 'vendedor-${caso.caso}-4012@invariant.test')
      on conflict (id) do nothing;

    insert into organizations (id, slug, legal_name, display_name)
      values ('${i.org}', 'comando-agente-${caso.caso}-4012', 'Comando LTDA', 'Comando');
    insert into user_organizations (user_id, organization_id, role, accepted_at) values
      ('${i.gerente}', '${i.org}', 'manager', now()),
      ('${i.vendedor}', '${i.org}', 'agent', now());
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
      values ('${i.sessao}', '${i.org}', '\\x00', 'comando-${caso.caso}-4012');

    -- UM contato por conversa: uniq_conversations_1to1_per_contact_session é
    -- 1:1 por (organização, contato, sessão) e duas conversas no mesmo par são
    -- recusadas pelo banco — a matriz precisa de contatos distintos, não de um só.
    insert into contacts (id, organization_id, force_human, is_blocked) values
      ('${i.contato}',          '${i.org}', false, false),
      ('${i.contatoTravado}',   '${i.org}', true,  false),
      ('${i.contatoComDono}',   '${i.org}', false, false),
      ('${i.contatoGrupo}',     '${i.org}', false, false),
      ('${i.contatoEncerrada}', '${i.org}', false, false);

    insert into conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, is_group, group_chat_id) values
      ('${i.conversaLivre}',    '${i.org}', '${i.contato}',          '${i.sessao}', 'open',   null,            false, null),
      ('${i.conversaComDono}',  '${i.org}', '${i.contatoComDono}',   '${i.sessao}', 'open',   '${i.vendedor}', false, null),
      ('${i.conversaGrupo}',    '${i.org}', '${i.contatoGrupo}',     '${i.sessao}', 'open',   null,            true,  'grupo-${caso.caso}@g.us'),
      ('${i.conversaTravada}',  '${i.org}', '${i.contatoTravado}',   '${i.sessao}', 'open',   null,            false, null),
      ('${i.conversaEncerrada}','${i.org}', '${i.contatoEncerrada}', '${i.sessao}', 'closed', null,            false, null);
  `);

  if (a === null) return;

  // A versão existe SEMPRE (a FK de `published_version_id` aponta para ela); quem
  // decide se está publicada no agente é o PONTEIRO, exatamente como em produção.
  //
  // A ordem é agente → versão → ponteiro porque as duas FKs se cruzam: a versão
  // aponta para o agente, e o agente aponta para a versão. Inserir a versão
  // primeiro é recusado por `ai_agent_versions_agent_id_fkey`.
  sql(`
    insert into ai_agents (id, organization_id, name, system_prompt, paused_at, archived_at)
      values ('${i.agente}', '${i.org}', 'Agente ${caso.caso}', 'prompt',
              ${a.pausado ? "now()" : "null"},
              ${a.arquivado ? "now()" : "null"});
    insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, published_at)
      values ('${i.versao}', '${i.org}', '${i.agente}', 1, 'prompt', 'anthropic', 'claude-sonnet-4-6', '${i.sessao}', 'published', now());
    ${a.publicado ? `update ai_agents set published_version_id = '${i.versao}' where id = '${i.agente}';` : ""}
  `);
}

/**
 * O FATO ORG-WIDE do lado do TS — lido das LINHAS reais, com a MESMA função que
 * `/api/v1/ai/automatico-ativo` e `orgTemAutomatico` usam.
 *
 * Cravar `false`/`true` no teste faria o lado do TS concordar por construção e
 * não por medição — o pecado que este arquivo existe para não cometer.
 */
function automaticoDaOrg(caso: EstadoDeAgente): boolean {
  const i = ids(caso);
  const bruto = lastLine(
    sql(`select coalesce(json_agg(json_build_object(
             'kind', kind, 'is_active', is_active, 'paused_at', paused_at,
             'published_version_id', published_version_id, 'archived_at', archived_at)), '[]')::text
           from ai_agents where organization_id = '${i.org}' and archived_at is null`),
  );
  return (JSON.parse(bruto) as FatosDoAgente[]).some(agenteAtende);
}

/** O comando que o BANCO devolve para a conversa (o campo calculado de verdade). */
function comandoDoBanco(idConversa: string): string {
  return lastLine(sql(`select public.comando_da_conversa(c) from conversations c where c.id = '${idConversa}'`));
}

/** O comando que o TS devolve para a MESMA conversa, com o fato org-wide lido do banco. */
function comandoDoTs(caso: EstadoDeAgente, fato: { dono: boolean; travado: boolean; grupo: boolean; encerrada: boolean }): string {
  return comandoDaConversa(
    {
      status: fato.encerrada ? "closed" : "open",
      assigned_to_user_id: fato.dono ? ids(caso).vendedor : null,
      bot_silenced_until: null,
      force_human: fato.travado,
      is_blocked: false,
      is_group: fato.grupo,
      automaticoDaOrg: automaticoDaOrg(caso),
    },
    new Date(),
  ).comando.quem;
}

describe("comando da conversa × organização sem agente no ar (#4012)", () => {
  for (const c of CASOS) semear(c);

  it("A — RED literal: a mesma conversa, comando do banco × comando do TS", () => {
    // Antes do conserto: banco=automatico, TS=ninguem. Depois: os dois `ninguem`.
    const i = ids("sem_agente");
    const doBanco = comandoDoBanco(i.conversaLivre);
    const doTs = comandoDoTs("sem_agente", { dono: false, travado: false, grupo: false, encerrada: false });
    // eslint-disable-next-line no-console
    console.log(`[4012] org SEM agente, conversa sem dono e sem trava — SQL=${doBanco} TS=${doTs}`);
    expect(doTs, "o lado do TS é o oráculo: org sem agente não tem `automatico`").toBe("ninguem");
    expect(doBanco, `SQL=${doBanco} TS=${doTs} — as duas réguas têm de dizer o mesmo`).toBe(doTs);
  });

  it("B — a régua da ORGANIZAÇÃO (SQL) concorda com `agenteAtende` nos cinco estados", () => {
    const divergentes: string[] = [];
    for (const c of CASOS) {
      const doBanco = lastLine(
        sql(`select public.fn_org_tem_automatico('${ids(c.caso).org}')::text`),
      );
      const doTs = automaticoDaOrg(c.caso);
      // O oráculo do arquivo, por sua vez, contra a função de produção.
      expect(doTs, `${c.caso}: agenteAtende × matriz do arquivo`).toBe(c.atende);
      if (doBanco !== String(doTs)) divergentes.push(`${c.caso}: sql=${doBanco} ts=${doTs}`);
    }
    expect(divergentes, "a função SQL da organização e `agenteAtende` divergem").toEqual([]);
  });

  it("B — o comando da conversa sem dono segue o estado do agente (matriz inteira)", () => {
    const divergentes: string[] = [];
    const matriz: Record<string, string> = {};
    for (const c of CASOS) {
      const i = ids(c.caso);
      const doBanco = comandoDoBanco(i.conversaLivre);
      const doTs = comandoDoTs(c.caso, { dono: false, travado: false, grupo: false, encerrada: false });
      const esperado = c.atende ? "automatico" : "ninguem";
      matriz[c.caso] = `sql=${doBanco} ts=${doTs}`;
      if (doBanco !== esperado) divergentes.push(`${c.caso}: banco=${doBanco} esperado=${esperado}`);
      if (doTs !== esperado) divergentes.push(`${c.caso}: ts=${doTs} esperado=${esperado}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[4012] matriz da conversa SEM dono e sem trava: ${JSON.stringify(matriz)}`);
    expect(divergentes, "o comando da conversa sem dono não segue o fato da organização").toEqual([]);
  });

  it("C — os quatro lados opostos continuam como eram", () => {
    // (a) org COM agente publicado: `automatico` segue `automatico` — a conversa
    //     não pode virar `ninguem` só porque o conserto existe.
    const comAgente = ids("publicado");
    expect(comandoDoBanco(comAgente.conversaLivre), "org com agente publicado").toBe("automatico");
    // (b) com dono: continua `humano`, e o dono continua nomeado.
    expect(comandoDoBanco(comAgente.conversaComDono), "com dono").toBe("humano");
    // (c) travada pelo contato (`contato_trava_humano`): continua `aguardando`.
    expect(comandoDoBanco(comAgente.conversaTravada), "travada pelo contato").toBe("aguardando");
    // (c) grupo sem dono: continua `aguardando` (o automático nunca atende grupo).
    expect(comandoDoBanco(comAgente.conversaGrupo), "grupo sem dono").toBe("aguardando");
    // (c) encerrada sem dono: continua `encerrada`.
    expect(comandoDoBanco(comAgente.conversaEncerrada), "encerrada sem dono").toBe("encerrada");

    // E os mesmos lados opostos na org SEM agente — onde o conserto age, ele não
    // pode ter atropelado nenhum deles.
    const semAgente = ids("sem_agente");
    expect(comandoDoBanco(semAgente.conversaComDono), "sem agente, com dono").toBe("humano");
    expect(comandoDoBanco(semAgente.conversaTravada), "sem agente, travada").toBe("aguardando");
    expect(comandoDoBanco(semAgente.conversaGrupo), "sem agente, grupo").toBe("aguardando");
    expect(comandoDoBanco(semAgente.conversaEncerrada), "sem agente, encerrada").toBe("encerrada");
  });

  it("D — a carteira (#3642) leva a conversa quando a IA não vai responder, e só então", () => {
    const resultado: Record<string, string> = {};
    for (const c of CASOS) {
      const i = ids(c.caso);
      // Antes: a conversa está sem dono e o comando diz quem responde.
      const antes = comandoDoBanco(i.conversaLivre);
      sql(`select public.fn_definir_carteira_do_cliente(
             '${i.org}', '${i.gerente}', '${i.contato}', '${i.vendedor}', 'manual')`);
      const dono = lastLine(
        sql(`select coalesce(assigned_to_user_id::text, 'null') from conversations where id = '${i.conversaLivre}'`),
      );
      resultado[c.caso] = `${antes} -> ${dono === i.vendedor ? "levada" : "parada"}`;
      if (c.atende) {
        expect(dono, `${c.caso}: a conversa da IA não pode ser roubada pela carteira (Doc 237, 3-B)`).toBe("null");
      } else {
        expect(dono, `${c.caso}: sem quem responda, a conversa é do vendedor novo`).toBe(i.vendedor);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[4012] carteira por caso: ${JSON.stringify(resultado)}`);
  });

  it("E — a Fila continua mostrando a conversa (o filtro do servidor alcança a linha)", () => {
    // O caso que a issue mediu: org sem agente. `comandosDaFila(false)` é o que a
    // rota manda no `?comando_da_conversa=in.(...)`; se o comando virasse um valor
    // fora dele, a conversa sumiria da tela — trocar uma mentira por um sumiço.
    for (const caso of ["sem_agente", "publicado"] as const) {
      // Re-semeia: o bloco D mexe na carteira e atribui a conversa livre, e um
      // bloco que herda o estado de outro mede o bloco anterior, não a Fila.
      semear(CASOS.find((c) => c.caso === caso)!);
      const i = ids(caso);
      const filtro = comandosDaFila(automaticoDaOrg(caso));
      const lista = filtro.map((v) => `'${v}'`).join(",");
      // Os ids, não a contagem: uma contagem igual por acidente (a conversa errada
      // entrando e a certa saindo) passaria. O esperado é a travada e o grupo
      // (`aguardando` nos dois casos) mais a livre SÓ quando ninguém a responde.
      const naFila = sql(`select c.id from conversations c
                           where c.organization_id = '${i.org}'
                             and public.comando_da_conversa(c) in (${lista})
                           order by c.id`)
        .split("\n")
        .filter(Boolean)
        .sort();
      const esperado = [
        i.conversaTravada,
        i.conversaGrupo,
        ...(caso === "sem_agente" ? [i.conversaLivre] : []),
      ].sort();
      expect(naFila, `${caso}: Fila com o filtro ${JSON.stringify(filtro)}`).toEqual(esperado);
    }
  });
});
