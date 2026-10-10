import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * REDACT UNIFICADO: TODA TABELA COM FK PARA `contacts` TEM UMA DECISÃO ESCRITA
 * — issue #1504 (acompanhamento do #1501).
 *
 * ─── O defeito que este arquivo existe para impedir ────────────────────────
 *
 * Havia DUAS redações com conjuntos diferentes: o pedido formal passava por
 * `fn_lgpd_cascade_redact_contact`, e o botão da ficha reescrevia o CONTATO e
 * mais nada. O #1501 consertou o sintoma pelo gatilho; esta entrega conserta a
 * causa — o portão do botão passa a CHAMAR a cascata canônica (migration 0414),
 * e os dois caminhos terminam na mesma função.
 *
 * Mas "a função certa existe" não é cobertura: é a mesma falha muda de sempre.
 * Anonimizar devolve SUCESSO, a contagem fecha, o SLA D+15 é marcado como
 * cumprido, e a linha continua legível. Por isso o escopo aqui é derivado do
 * CATÁLOGO (`pg_constraint`), nunca de uma lista escrita à mão: tabela nova com
 * FK para o contato que aparecer amanhã REPROVA aqui, sem que ninguém precise
 * lembrar de acrescentá-la a lista nenhuma.
 *
 * ─── Decisão por tabela, e por que ela é o artefato ─────────────────────────
 *
 * A issue pede que cada tabela tenha decisão de REDIGIR ou MANTER, escrita no
 * próprio invariante — `orders` e `sales`, por exemplo, podem ter obrigação
 * fiscal de guarda. A decisão é o contrato; a asserção é que o BANCO cumpre o
 * que o contrato diz:
 *
 *   redigir + cascata  → a função única (lida de `pg_get_functiondef`) tem o
 *                        comando da tabela no corpo;
 *   redigir + gatilho  → alguma função de gatilho INSTALADA em `contacts`
 *                        (lida de `pg_trigger` + `pg_get_functiondef`) tem o
 *                        comando — o mesmo desenho da 0391: a virada de
 *                        `is_anonymized` é a porta por onde os DOIS caminhos e
 *                        qualquer um que venha passam;
 *   redigir + secao    → a tabela está declarada em `modulo_secoes_lgpd` (D8,
 *                        migration 0485) para o módulo que a criou, com o
 *                        gatilho `trg_lgpd_secoes_de_modulo` de pé: SQL DINÂMICO
 *                        que alcança onde o módulo está instalado e PULA, sem
 *                        erro, onde não está — o que uma cascata nomeada não
 *                        dá. É o caminho da comanda desde o #1907/0620: `sales`
 *                        saiu do corpo da função única porque, sem o módulo, o
 *                        passo nomeado abortava a ANONIMIZAÇÃO INTEIRA
 *                        (`relation "sales" does not exist`, CI do #1907).
 *   manter             → razão escrita, e a tabela fica FORA da cascata (se
 *                        entrar, a decisão virou mentira e o teste reprova).
 *
 * A cobertura das 11 tabelas da issue é medida À PARTE, porque várias delas
 * (`agent_cases`, `agent_case_events`, `agent_inbox_items`,
 * `entregas_de_aviso_de_caso`) não têm FK DIRETA para `contacts` — chegam pela
 * conversa e pelo caso — e o catálogo de FKs não as enxerga.
 */

/** Colunas/decisões são texto; o catálogo é o banco que manda. */
function lista(script: string): string[] {
  return sql(script)
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** TODA tabela com FK para `contacts` — o catálogo, nunca uma lista à mão. */
function tabelasComFkParaContato(): string[] {
  return lista(`
    select cl.relname
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
     where c.contype = 'f'
       and c.confrelid = 'public.contacts'::regclass
     order by 1;
  `);
}

/** Tabelas com comando dentro da função única (corpo REAL instalado). */
function tabelasNaCascata(): string[] {
  return lista(`
    select distinct m[1]
      from pg_proc p,
           lateral regexp_matches(
             pg_get_functiondef(p.oid),
             '(?:update|delete from)\\s+(?:public\\.)?"?([a-z_]+)"?', 'gi') m
     where p.proname = 'fn_lgpd_cascade_redact_contact'
     order by 1;
  `);
}

/**
 * Tabelas declaradas em `modulo_secoes_lgpd` — o mecanismo da D8 (migration
 * 0485): o registro que o módulo escreve na sua provisionadora/migration e que
 * `trg_lgpd_secoes_de_modulo` consome com SQL dinâmico protegido por
 * `to_regclass`. `sales` está aqui desde o #1907/0620.
 */
function tabelasDeclaradasEmSeccao(): string[] {
  return lista(`
    select tabela from public.modulo_secoes_lgpd order by tabela;
  `);
}

/**
 * Tabelas alcançadas pela virada de `is_anonymized`: gatilho NÃO interno
 * instalado em `contacts`, cuja função tem o comando. Desativado não conta.
 */
function tabelasEmGatilhosDoContato(): string[] {
  return lista(`
    select distinct m[1]
      from (
        select distinct pg_get_functiondef(p.oid) as def
          from pg_trigger t
          join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = 'public.contacts'::regclass
           and not t.tgisinternal
           and t.tgenabled <> 'D'
      ) defs,
      lateral regexp_matches(
        defs.def,
        '(?:update|delete from)\\s+(?:public\\.)?"?([a-z_]+)"?', 'gi') m
     order by 1;
  `);
}

function corpo(funcao: string): string {
  const linhas = lista(`
    select count(*) from pg_proc
     where proname = '${funcao}' and pronamespace = 'public'::regnamespace;
  `);
  expect(linhas, `função ${funcao} não existe em public`).toEqual(["1"]);
  return sql(`
    select pg_get_functiondef(p.oid)
      from pg_proc p
     where p.proname = '${funcao}'
       and p.pronamespace = 'public'::regnamespace;
  `);
}

type Decisao =
  | { decidida: "redigir"; caminho: "cascata" | "gatilho" | "secao"; razao: string }
  | { decidida: "manter"; razao: string };

/**
 * As 34 tabelas com FK para `contacts` na main de 25/09/2026, cada uma com a
 * SUA decisão. Tabela do catálogo que não estiver aqui reprova (é nova, e
 * ninguém decidiu o que fazer com ela); entrada que nomear tabela que não
 * existe mais também reprova (dívida morta cobre o futuro por acidente).
 */
const DECISOES: Record<string, Decisao> = {
  // ── redigir na função única ───────────────────────────────────────────────
  contacts: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 1 da própria cascata: nome/rótulo, email, telefone, CPF, data de nascimento, consent, source_metadata e tags; is_anonymized/anonymized_at viram o que responde ao titular.",
  },
  conversations: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 2: metadata, last_message_preview e last_handoff_reason; a linha FICA porque a conversa é a linha do tempo do atendimento.",
  },
  messages: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 3: body vira '[mensagem anonimizada]', mídia zerada e metadata esvaziada; status e timestamps preservados.",
  },
  crm_lead_activities: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 4: payload, metadata e reason (texto livre escrito por LLM sobre a conversa) zerados; evidence guarda só ids.",
  },
  crm_leads: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 5: título vira o rótulo, descrição/custom_fields/source_metadata/tags zerados; funil, estágio e valor ficam (são do negócio, não da pessoa).",
  },
  orders: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 6: só os campos PESSOAIS do payload jsonb saem; valores, status e timestamps ficam — pedido tem obrigação fiscal de guarda, e a issue pede essa decisão escrita.",
  },
  sales: {
    decidida: "redigir",
    caminho: "secao",
    razao:
      "PR #1907 (migration 0620): a comanda saiu do corpo da função única e passou para a " +
      "SEÇÃO declarada `financeiro/sales` em `modulo_secoes_lgpd` (D8/0485) — o passo nomeado " +
      "abortava a anonimização INTEIRA em instalação sem o módulo (`relation \"sales\" " +
      "does not exist`, 68 ocorrências no CI). Na seção o efeito é o MESMO do passo 6c " +
      "antigo: `notes` some (NULO), `cancel_reason` e `reverse_reason` viram '[redigido]' só " +
      "onde havia texto (`colunas_redigidas`), `updated_at` = now(), e valor/status/datas e o vínculo com o " +
      "contato FICAM (obrigação fiscal da venda); quem aplica é " +
      "`trg_lgpd_secoes_de_modulo`, nos dois caminhos, com `to_regclass` pulando sem erro " +
      "onde o módulo não existe.",
  },
  crm_proposals: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0477: destinatario_nome (nome impresso no PDF, D10/0466), briefing_json e resumo_comercial saem — número, valores, itens, datas e status ficam, mesmo molde de orders/crm_leads.",
  },
  voice_calls: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "peer_phone e demais campos de gente viram resíduo; a chamada em si (duração, status, destino técnico) fica — 0235 tirou a tabela de fora da cascata e foi aqui que ela voltou.",
  },
  prospecting_candidates: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0370: telefone e conteúdo da prospecção viram tombstone (suppression_salt), que é o que continua BARRANDO a reimportação depois da anonimização.",
  },
  demandas: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0359: texto livre do que o cliente pediu (a comanda) é redigido; a linha da demanda fica com o ciclo de vida.",
  },
  agent_case_chat_messages: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0281: corpo da conversa do caso redigido por transição, com redacted_at idempotente; a linha fica para o histórico do caso.",
  },
  passagens_de_atendimento: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0291: o texto rico do que foi passado ao humano é a transcrição da pessoa; redigido, com o resto do fato preservado.",
  },
  campaign_recipients: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0379: rendered_body (a MENSAGEM dita à pessoa) e recipient_address saem; a LINHA fica, porque é a prova de que esteve na campanha.",
  },
  campaign_suppressions: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0379: a cauda do número sai, mas a linha é o 'não me mande mais' — apagá-la faria a pessoa voltar a receber campanha.",
  },
  channel_session_groups: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "0482 (grupos na inbox, #1647): subject é o NOME do grupo e vira null; contact_id aponta para o placeholder do grupo (contacts.kind = 'whatsapp_group'), e número, conversa e liga/desliga ficam. O que o TITULAR escreveu em grupo é redigido pelo gatilho fn_redigir_conversas_ao_anonimizar, em messages.",
  },
  // ── redigir pela virada de is_anonymized (gatilho) ────────────────────────
  ai_reply_drafts: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "fn_reply_redact (0227): rascunho/original/propostas zerados na virada — texto gerado sobre a conversa da pessoa, alcançável pelos DOIS caminhos.",
  },
  calendar_appointments: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0184: title, description, notes, location_details e cancellation_reason são texto livre que nomeia a pessoa (queixa clínica numa clínica); gatilho da virada, com google/meet no mesmo acorde.",
  },
  contact_field_proposals: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "fn_apaga_propostas_de_contato_anonimizado: a fila guarda o VALOR proposto para virar escrita em contacts — apaga, não redige, porque proposta pendente de contato anonimizado não tem mais destinatário.",
  },
  crm_tasks: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0210: título trocado e descrição apagada na virada — 'Ligar para Fulano confirmar o orçamento' é texto que nomeia a pessoa.",
  },
  job_queue: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "Payload do trabalho em curso esvaziado na virada (fn_meet_redact_contact / fn_reply_redact), com o job derrubado para failed: o payload carrega ids do compromisso e do contato.",
  },
  lead_checkpoints: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0391: resumo corrido, compromissos, objeções, próxima ação e declaração do turno são texto de modelo sobre a pessoa — redigidos pela virada, que é o caminho que os DOIS compartilham.",
  },
  import_rows: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0449 (metade B2B do #1621): raw_data/normalized_data são a linha da planilha como veio — nome, telefone, e-mail, cargo — e error citava o telefone; zerados na virada por fn_redigir_b2b_do_contato_anonimizado, que também redige a pessoa (people) e o vínculo (company_people). A linha fica: número, status e lote são a prova de que o lote rodou.",
  },
  webhook_lead_captures: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0174: captured_name/captured_email/captured_phone (o payload cru de captação) zerados por gatilho — a entrada na dívida do invariante irmão é o aviso de que este instrumento não lia gatilho.",
  },
  ai_agent_runs: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0494 (#1964): a LINHA fica (status, erro, tokens, ids das mensagens: é a trilha do que o agente fez), mas tool_calls — texto do modelo, argumentos e resultados das ferramentas, com nome e trechos do que a pessoa escreveu — é redigido na virada de is_anonymized pelo gatilho fn_redigir_conversas_ao_anonimizar (fn_lgpd_redigir_tool_calls preserva o nome das ferramentas e apaga o resto, `redacted = true` em todo passo), a MESMA porta que o desenho da 0391 e que a app já usava em lib/lgpd/cascata.ts passo 6.",
  },
  lead_notes: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "DÍVIDA PARCIAL QUITADA na 0494 (#1964): headline/body são texto livre do agente SOBRE a pessoa (e embedding é derivado dele). A virada de is_anonymized redige os dois (→ `(anonimizado)`, `embedding` → null) pelo gatilho fn_redigir_conversas_ao_anonimizar — a mesma porta da 0391 e a mesma régua que a app usava em lib/lgpd/cascata.ts passo 5. O irmão (lgpd-cascata-alcanca-quem-guarda-pessoa) mantém a entrada na dívida porque o instrumento dele só lê fn_lgpd_cascade_redact_contact + trg_reply_redact, não este gatilho — a dívida lá sai no dia em que aquele instrumento derivar também os gatilhos de contacts, no desenho da 0391.",
  },
  lead_state: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0494 (#1964): a LINHA e o estágio ficam (é o estado do negócio), mas next_action (texto) e qualification (jsonb) — texto livre que cita a pessoa — são zerados na virada de is_anonymized pelo gatilho fn_redigir_conversas_ao_anonimizar (a porta da 0391 que a app já usava em lib/lgpd/cascata.ts passo 7).",
  },
  // ── manter: a linha e o conteúdo ficam, por decisão ───────────────────────
  before_send_traces: {
    decidida: "manter",
    razao: "Traço de decisão do gate de envio (vetoed_gate/vetoed_code) para auditoria de POR QUE a mensagem não saiu; é código de vocabulário, não o conteúdo enviado — o corpo mora em messages.",
  },
  cron_jobs: {
    decidida: "manter",
    razao: "Agenda do agendador (kind, intervalo, expressão, payload de configuração) — dado de operação da instalação, sem texto da pessoa; a FK existe para dizer de QUEM é o job.",
  },
  followup_enrollments: {
    decidida: "manter",
    razao: "Trilha de estados do roteiro (ponte, nó atual, status, motivo de cancelamento — vocabulário fechado), sem texto livre. A virada de is_anonymizado ENCERRA o roteiro em curso pelo gatilho da 0394; encerrar não é redigir, e não sobra nada legível da pessoa.",
  },
  google_ads_click_refs: {
    decidida: "manter",
    razao: "gclid/token de clique da plataforma e a query de aterrissagem — identificador de campanha que existe para casar o clique ao contato. Sem nome, telefone ou e-mail; apagar desfaria a atribuição da conversão.",
  },
  lead_state_transitions: {
    decidida: "manter",
    razao: "Histórico de transições (de/para estágio e reason em código): é a trilha de auditoria do funil, legível sem identificar a pessoa além do próprio contato, que já está anonimizado.",
  },
  lgpd_requests: {
    decidida: "manter",
    razao: "O PRÓPRIO pedido do titular — justificativa, escopo e desfecho. Guardá-lo é a prova de que o direito foi exercido no prazo (D+7 export, D+15 redact); apagá-lo apagaria a resposta ao titular sobre o próprio pedido.",
  },
  llm_calls: {
    decidida: "manter",
    razao: "Ficha de custo e propósito da chamada (provider, modelo, cost_cents) — sem prompt e sem resposta no corpo. É o que a tela de orçamento soma; a entrada de texto pessoal está nas tabelas que a cascata redige.",
  },
  loyalty_ledger: {
    decidida: "manter",
    razao: "Extrato de pontos (quantidade, reason em vocabulário, idempotency_key): dado do PROGRAMA de fidelidade, e o histórico de saldo precisa fechar. A pessoa por trás já está anônima na cascata.",
  },
  meta_ads_click_refs: {
    decidida: "manter",
    razao: "token/utm/query de aterrissagem da Meta, mesmo motivo do gclid: identificador de campanha que só serve enquanto existir — apagar desfaz a atribuição sem proteger texto de ninguém.",
  },
  send_ledger: {
    decidida: "manter",
    razao: "body_hash é IRREVERSÍVEL (a própria doutrina do invariante irmão manda `_hash` ficar de fora) e last_error/status são código; é a prova de que a mensagem saiu, sem guardar o que ela dizia.",
  },
};

/** As 11 tabelas da issue #1504 — nenhuma tem FK DIRETA, por isso medida à parte. */
const DEZ_E_UM = [
  "orders",
  "sales",
  "voice_calls",
  "prospecting_candidates",
  "agent_cases",
  "agent_case_events",
  "demandas",
  "agent_inbox_items",
  "agent_case_chat_messages",
  "passagens_de_atendimento",
  "entregas_de_aviso_de_caso",
];

/**
 * O módulo financeiro INSTALADO antes de medir — #1907, item 3.
 *
 * As cinco tabelas da comanda saíram do `baseline.sql` e nascem na
 * provisionadora (ADR-0002 D2/D3): num banco sem o módulo elas não existem, o
 * catálogo de FKs não as enxerga e as decisões escritas de `sales` e
 * `loyalty_ledger` viram "dívida morta" — o teste reprovaria por o BANCO estar
 * incompleto, não por a decisão estar errada. A D8 manda esta varredura rodar
 * sobre um banco COM o módulo, e não perder cobertura.
 */
beforeAll(() => {
  sql("select public.fn_financeiro_provisionar();");
});

describe("LGPD: redact unificado — catálogo de FKs com decisão escrita", () => {
  it("CONTROLE: o catálogo está vivo — `contacts` tem FK para si e há massa medida", () => {
    const escopo = tabelasComFkParaContato();
    expect(
      escopo.length,
      "o catálogo devolveu menos de 30 tabelas — a FK mudou de nome ou a query quebrou, e TODO o resto passaria por vazio",
    ).toBeGreaterThanOrEqual(30);
    expect(escopo).toContain("contacts");
    expect(escopo).toContain("conversations");
  });

  it("CONTROLE: a cascata e os gatilhos vieram do banco, com corpo", () => {
    expect(tabelasNaCascata().length).toBeGreaterThanOrEqual(14);
    expect(tabelasNaCascata()).toContain("contacts");
    expect(tabelasEmGatilhosDoContato().length).toBeGreaterThanOrEqual(5);
  });

  it("TODA tabela com FK para contacts tem decisão — tabela NOVA fora da cascata reprova", () => {
    const semDecisao = tabelasComFkParaContato().filter((t) => !(t in DECISOES));
    expect(
      semDecisao,
      "Tabela nova com FK para `contacts` sem decisão escrita: anonimizar vai devolver " +
        "SUCESSO e esta tabela continua legível, com o SLA marcado como cumprido. " +
        "Acrescente a entrada aqui com `redigir` (caminho: cascata ou gatilho) ou " +
        "`manter` + a razão — e, se for redigir, o passo na função única " +
        "(migration + apêndice do baseline) no mesmo commit.",
    ).toEqual([]);
  });

  it("Toda decisão nomeia tabela que existe — dívida morta não cobre o futuro", () => {
    const escopo = new Set(tabelasComFkParaContato());
    const obsoletas = Object.keys(DECISOES).filter((t) => !escopo.has(t));
    expect(
      obsoletas,
      "Entrada de decisão para tabela sem FK para `contacts` — ou a FK saiu, ou o nome " +
        "errou. Tirar a entrada: quem não existe não precisa de decisão, e sobrar aqui " +
        "vira permissão para uma tabela real passar sem decisão.",
    ).toEqual([]);
  });

  it("`redigir` na cascata: a função única do banco realmente alcança a tabela", () => {
    const naCascata = new Set(tabelasNaCascata());
    const fora = Object.entries(DECISOES)
      .filter(([, d]) => d.decidida === "redigir" && d.caminho === "cascata")
      .map(([t]) => t)
      .filter((t) => !naCascata.has(t));
    expect(
      fora,
      "Decisão `redigir` pela cascata, mas o corpo instalado de " +
        "`fn_lgpd_cascade_redact_contact` não tem o comando da tabela — a decisão " +
        "prometeu cobertura que o banco não dá.",
    ).toEqual([]);
  });

  it("`redigir` por gatilho: a virada de is_anonymized alcança a tabela", () => {
    const emGatilho = new Set(tabelasEmGatilhosDoContato());
    const fora = Object.entries(DECISOES)
      .filter(([, d]) => d.decidida === "redigir" && d.caminho === "gatilho")
      .map(([t]) => t)
      .filter((t) => !emGatilho.has(t));
    expect(
      fora,
      "Decisão `redigir` por gatilho, mas nenhum gatilho NÃO-interno e ativo em " +
        "`contacts` tem o comando da tabela — a virada acontece e nada é redigido.",
    ).toEqual([]);
  });

  it("`redigir` por seção declarada: a D8 alcança a tabela e o gatilho está de pé", () => {
    const emSeccao = new Set(tabelasDeclaradasEmSeccao());
    const fora = Object.entries(DECISOES)
      .filter(([, d]) => d.decidida === "redigir" && d.caminho === "secao")
      .map(([t]) => t)
      .filter((t) => !emSeccao.has(t));
    expect(
      fora,
      "Decisão `redigir` por seção declarada, mas `modulo_secoes_lgpd` não tem a linha da " +
        "tabela — a decisão prometeu o SQL dinâmico que o registro é quem dá. O registro " +
        "se escreve na provisionadora do módulo (e no topo da migration dele, para a " +
        "comanda que já existe).",
    ).toEqual([]);
    // E o gatilho da D8 que consome o registro tem de estar instalado em contacts:
    // sem ele o registro é só uma linha e ninguém redige nada.
    const gatilho = lista(`
      select tgname
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
       where c.relname = 'contacts' and t.tgname = 'trg_lgpd_secoes_de_modulo'
         and not t.tgisinternal;
    `);
    expect(
      gatilho,
      "O gatilho `trg_lgpd_secoes_de_modulo` não está em `contacts` — a seção declarada " +
        "não tem quem a aplique, e a cobertura seria só papel.",
    ).toEqual(["trg_lgpd_secoes_de_modulo"]);
  });

  it("`manter`: razão escrita, e a tabela fica FORA da cascata", () => {
    const naCascata = new Set(tabelasNaCascata());
    const semRazao: string[] = [];
    const estaNaCascata: string[] = [];
    for (const [t, d] of Object.entries(DECISOES)) {
      if (d.decidida !== "manter") continue;
      if (d.razao.trim().length < 50) semRazao.push(t);
      if (naCascata.has(t)) estaNaCascata.push(t);
    }
    expect(
      semRazao,
      "Decisão `manter` sem razão escrita — manter por padrão é o mesmo defeito " +
        "de não decidir. A razão precisa dizer POR QUÊ a tabela fica.",
    ).toEqual([]);
    expect(
      estaNaCascata,
      "Decisão `manter` para tabela que a cascata ALCANÇA — a decisão virou mentira; " +
        "troque para `redigir` para o invariante continuar descrevendo o banco.",
    ).toEqual([]);
  });

  it("as 11 tabelas da issue estão alcançadas — pela função única ou pela seção declarada", () => {
    const naCascata = new Set(tabelasNaCascata());
    const emSeccao = new Set(tabelasDeclaradasEmSeccao());
    const ausentes = DEZ_E_UM.filter((t) => !naCascata.has(t) && !emSeccao.has(t));
    expect(
      ausentes,
      "Tabela da issue #1504 fora da função única E fora de `modulo_secoes_lgpd`: os dois " +
        "caminhos passaram a chamar a mesma função justamente para alcançá-las, e a D8 " +
        "acrescentou o terceiro caminho (seção declarada) para a comanda, que sem o " +
        "módulo não existe na instalação. Nenhum dos dois ⇒ nada é redigido.",
    ).toEqual([]);
    // O controle que impede a exceção de virar esconderijo: `sales` só saiu da
    // cascata porque ENTROU na seção — as duas provas juntas, nunca uma só.
    expect(emSeccao, "`sales` saiu da cascata e não entrou em nenhuma seção declarada").toContain(
      "sales",
    );
  });

  it("contacts: consent, source_metadata e tags zerados NO PASSO 1", () => {
    const corpoDaCascata = corpo("fn_lgpd_cascade_redact_contact");
    const passo1 = /update\s+contacts\s+set([\s\S]*?);/.exec(corpoDaCascata)?.[1] ?? "";
    expect(passo1.length, "passo 1 (o update de contacts) não encontrado na função").toBeGreaterThan(0);
    for (const campo of ["consent = '{}'::jsonb", "source_metadata = '{}'::jsonb", "tags = '{}'::text[]"]) {
      expect(
        passo1,
        `contacts.${campo.split(" ")[0]} não é zerado no passo 1 — é o campo que a issue #1504 cobre junto com as 11 tabelas`,
      ).toContain(campo);
    }
    expect(passo1).toContain("is_anonymized = true");
    expect(passo1).toContain("anonymized_at = now()");
  });

  it("os DOIS caminhos chamam a mesma função — o portão chama a cascata e não redige", () => {
    const doPortao = corpo("fn_lgpd_anonymize_contact");
    expect(
      doPortao,
      "O portão do botão não chama `fn_lgpd_cascade_redact_contact` — os dois " +
        "caminhos voltaram a ter conjuntos diferentes, que é a causa da issue #1504.",
    ).toContain("fn_lgpd_cascade_redact_contact");
    expect(
      doPortao,
      "O portão tem escrita própria: um `update … set` no corpo seria a divergência " +
        "de novo, com a chamada dando a ilusão de cobertura.",
    ).not.toMatch(/\bupdate\s+(?:public\.)?"?[a-z_]+"?\s+set\b/i);
    expect(
      doPortao,
      "O portão perdeu o portão de MFA da 0229 — `create or replace` troca o corpo " +
        "inteiro e não avisa (a mesma classe que mfa-nao-some-em-funcao-recriada vigia).",
    ).toContain("fn_session_mfa_proven");
  });
});
