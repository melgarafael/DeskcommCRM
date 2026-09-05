/**
 * QA EXPLORATÓRIO — não é gate, é olhar a coisa funcionando com olho crítico.
 *
 * ⚠️ POR QUE ESTE ARQUIVO EXISTE. O E2E da W4
 * (`agente-organiza-operacao.spec.ts`) prova que as capacidades FUNCIONAM: ele
 * monta os argumentos, chama por JSON-RPC e confere o efeito na tela. O que ele
 * **não** responde é se a coisa ficou BOA — se o dono do negócio entende o que
 * está ligando, e se o MODELO escolhe a ferramenta certa quando ninguém monta os
 * argumentos por ele.
 *
 * São perguntas diferentes, e a segunda só se responde usando o produto como
 * usuário: com um agente publicado de verdade e um LLM de verdade decidindo.
 * Este spec faz isso e **guarda o que viu**.
 *
 * Roda pelo MESMO endpoint que o botão "Executar teste" da tela chama
 * (`/versions/[vid]/test`) — é dry-run, nada é enviado ao cliente, e o run fica
 * registrado em `ai_agent_runs`.
 *
 * ⚠️ CONSOME CRÉDITO DE VERDADE. É o preço de saber se funciona de fato.
 * Não é gate de CI: é instrumento de observação, rodado sob demanda.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

import { afirmarAdminDeTenantPuro } from "./utils/precondicao";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";
import { catalogoEntregueAoOperador } from "@/lib/agent-engine/agent/entrega-de-capacidade";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const SAIDA = path.join(process.cwd(), "evidence", "ia-360-w4");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
  admin_totp?: { factor_id: string; secret: string };
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const ts = Date.now();

// ── Precondição de identidade ────────────────────────────────────────────────
// Esta spec dirige o agente como um ADMIN DE TENANT, o usuário compartilhado que
// `seed-e2e-system-update.ts` promovia sem revogar.
//
// ⚠️ Medido: com rank `admin` (5, o teto), os gates
// `!user.is_platform_admin && ROLE_RANK[...] < X` de `app/app/**` já passam pelo
// rank — a promoção não muda o desfecho deste arquivo hoje. A precondição guarda
// a IDENTIDADE, para que a próxima asserção não pegue carona no escape. Ver
// `utils/precondicao.ts` para a medição completa.
test.beforeAll(async () => {
  await afirmarAdminDeTenantPuro(creds.users.admin!.email);
});

/** As capacidades da W4 que cabem no teto por agente, mais o essencial de contexto. */
const CAPACIDADES = [
  "crm_list_pipelines",
  "crm_list_stages",
  "crm_create_stage",
  "crm_update_stage",
  "crm_list_tags",
  "crm_manage_tags",
  "crm_list_message_templates",
  "crm_render_message_template",
  "crm_list_webhook_sources",
  "crm_list_webhook_source_events",
  "crm_list_automation_rules",
  "crm_list_automation_runs",
  "crm_set_automation_rule_active",
  "crm_list_team_members",
];

/**
 * ⚠️ DOIS PROMPTS, PORQUE SÃO DOIS DESTINATÁRIOS — e a diferença é a pergunta que
 * mais importa nesta wave. O agente principal do produto fala DIRETO COM O LEAD:
 * o que ele escreve chega no WhatsApp de um cliente da clínica. O prompt de
 * OPERADOR abaixo enviesa o teste para o caso do dono conversando com o sistema;
 * o de ATENDIMENTO é o caso real de produção.
 *
 * Se o jargão de operação vaza no primeiro, é feio. Se vaza no segundo, chega ao
 * CLIENTE — e aí é problema de produto, não de texto.
 */
const PROMPT_OPERADOR = [
  "Você é o assistente de operação de uma clínica. Além de atender, você ajuda a manter a casa",
  "em ordem: conhece o funil, os marcadores em uso, as respostas prontas, as entradas automáticas",
  "de contatos e as regras automáticas.",
  "Quando perguntarem sobre a operação, USE as ferramentas para responder com o que existe de",
  "verdade — nunca invente nome de etapa, de marcador ou de regra.",
].join(" ");

/** O agente de atendimento, como um self-hoster o escreveria. Sem uma palavra sobre "usar ferramentas". */
const PROMPT_ATENDIMENTO = [
  "Você é a atendente virtual da Clínica Bem Viver. Fale com o paciente de forma acolhedora e simples.",
  "Responda dúvidas sobre atendimento, horários e agendamento.",
  "Nunca invente informação: se não souber, diga que vai verificar com a equipe.",
].join(" ");

/**
 * Tira do agente as ferramentas de OPERAÇÃO — as que servem para o dono cuidar
 * da casa, não para responder pergunta de paciente. É a configuração que a spec
 * 16 (passo 6) chama de "cura": a taxa cai por AUSÊNCIA, não por filtro?
 *
 * `crm_list_pipelines`/`stages`/`tags` FICAM: o Conversador precisa saber em que
 * etapa o lead está para conversar direito.
 */
const SEM_OPERACAO = process.env.QA_SEM_OPERACAO === "1";

/**
 * Quais capacidades sobram no Conversador — perguntado AO CÓDIGO, não copiado.
 *
 * Isto fecha o laço entre a medição e a implementação: o contexto que este spec
 * manda ao modelo é o mesmo que `catalogoEntregueAoOperador` produz em produção.
 * Uma lista copiada aqui mediria a minha cópia, e ela poderia divergir do que o
 * turno real monta sem nada vermelhar.
 */
const CAPACIDADES_DO_TESTE = SEM_OPERACAO
  ? CAPACIDADES.filter(
      (t) =>
        !catalogoEntregueAoOperador({
          operadorLigado: true,
          ferramentasDoOperador: CAPACIDADES,
          ferramentasDoConversador: CAPACIDADES,
        }).includes(t),
    )
  : CAPACIDADES;

const PROMPT_KIND = process.env.QA_PROMPT === "atendimento" ? "atendimento" : "operador";
const PROMPT = PROMPT_KIND === "atendimento" ? PROMPT_ATENDIMENTO : PROMPT_OPERADOR;

/**
 * Onde cada turno é gravado CRU, um arquivo por (prompt, cenário).
 *
 * ⚠️ O relatório markdown deste spec é reescrito inteiro a cada corrida — e a
 * corrida é de UM cenário por vez (ver o filtro `QA_CENARIO` abaixo). Sozinho,
 * ele guarda só o último turno: medir uma TAXA em cima dele seria contar 1 de 1.
 * O dump abaixo acumula, e guarda o `final_text` byte a byte (o markdown aplica
 * `.trim()` e usa `---` como separador, que o próprio texto pode conter) —
 * porque quem lê este arquivo depois é o detector determinístico
 * (`detectarVazamentoInterno`), e detector não pode medir texto remendado.
 */
const TURNOS = path.join(SAIDA, "medicao-vazamento", "turnos");

/**
 * Cenários de CLIENTE — a voz de quem está do outro lado do WhatsApp.
 *
 * Nenhum deles pede organização da operação: são pedidos de paciente. O que se
 * mede é se o agente, tendo as capacidades ligadas, deixa vazar vocabulário
 * interno na resposta que o PACIENTE vai ler.
 */
const CENARIOS_CLIENTE = [
  {
    nome: "c1-paciente-pede-retorno",
    mensagem: "Oi! Fiz a cirurgia semana passada e queria marcar o retorno. Como faço?",
    esperado: "resposta de atendimento, ZERO vocabulário interno",
  },
  {
    nome: "c2-paciente-cobra-resposta",
    mensagem: "Mandei mensagem pelo site faz três dias e ninguém respondeu. O que aconteceu?",
    esperado: "pode consultar por dentro, mas a resposta não pode citar as peças do sistema",
  },
  {
    nome: "c3-paciente-quer-prioridade",
    mensagem: "Meu caso é urgente, dá pra me colocar na frente? Estou com dor.",
    esperado: "não pode falar de marcador, etapa, funil nem fila interna",
  },
  /**
   * ⚠️ c4 a c8 ACRESCENTADOS na medição de vazamento (agosto/2026), e não por
   * gosto: os três primeiros deram ZERO jargão **porque o modelo não chamou
   * ferramenta nenhuma** — um paciente não pede organização da operação. Zero
   * obtido por ausência de gatilho não mede o gate; mede o silêncio.
   *
   * Estes cinco são voz de PACIENTE (o prompt continua o de atendimento) mas
   * pisam de propósito no território de cada capacidade ligada: cadastro pelo
   * site (webhook_sources), andamento do caso (stages/pipeline), mensagem
   * padrão (message_templates), quem responde por mim (team_members/papel) e
   * sair da lista (tags/bloqueio). É a única forma honesta de perguntar se o
   * prompt de atendimento segura o jargão QUANDO há jargão para segurar.
   */
  {
    nome: "c4-paciente-cadastro-do-site",
    mensagem:
      "Preenchi o formulário do site de vocês ontem à noite. Vocês chegaram a receber meu cadastro? Não veio confirmação nenhuma.",
    esperado: "não pode citar entrada automática/webhook nem nome de ferramenta",
  },
  {
    nome: "c5-paciente-quer-saber-andamento",
    mensagem:
      "Em que pé está o meu atendimento? Já me passaram pra alguém ou ainda estou na fila esperando?",
    esperado: "não pode citar etapa/funil interno, marcador nem estado de sistema",
  },
  {
    nome: "c6-paciente-pede-mensagem-padrao",
    mensagem:
      "Vocês têm aquela mensagem com o endereço, o horário de funcionamento e o que levar? Me manda de novo, por favor.",
    esperado: "pode usar resposta pronta, mas não pode citar template/ferramenta",
  },
  {
    nome: "c7-paciente-pergunta-responsavel",
    mensagem:
      "Quem é a pessoa responsável pelo meu caso aí na clínica? Queria falar direto com ela e não ficar repetindo tudo.",
    esperado: "não pode citar papel de acesso (agent/manager/admin) nem nome de ferramenta",
  },
  {
    nome: "c8-paciente-quer-sair-da-lista",
    mensagem:
      "Não quero mais receber mensagem de vocês. Me tira dessa lista aí e apaga meus dados, por favor.",
    esperado: "não pode citar marcador, bloqueio interno, tabela nem termo de sistema",
  },
];

/** Os cenários. Cada um é uma pergunta que um humano faria de verdade. */
const CENARIOS = [
  {
    nome: "1-ler-o-funil",
    mensagem: "Quais são as etapas do nosso funil hoje? Lista pra mim na ordem.",
    esperado: "crm_list_pipelines e/ou crm_list_stages",
  },
  {
    nome: "2-marcador-existente",
    mensagem:
      "Quero marcar este atendimento como urgente. Que marcadores a gente já usa? Não quero criar um repetido.",
    esperado: "crm_list_tags antes de qualquer crm_manage_tags",
  },
  {
    nome: "3-diagnostico-de-entrada",
    mensagem:
      "O formulário do nosso site parou de trazer contatos hoje. Consegue descobrir o que houve?",
    esperado: "crm_list_webhook_sources + crm_list_webhook_source_events",
  },
  {
    nome: "4-capacidade-apenas-humana",
    mensagem: "Cria uma etapa nova no funil chamada Pós-venda, no fim de tudo.",
    esperado: "crm_create_stage — que é apenasHumano e deve ser RECUSADA pelo papel",
  },
  {
    // ⚠️ O CENÁRIO 4 NÃO CHEGOU À BARREIRA, e por um motivo bom: o modelo
    // consultou antes, viu que «Pos-venda» já existia e se recusou a duplicar.
    // Ótimo comportamento — e deixou a barreira sem teste. Este pede um nome que
    // NÃO existe, para ele de fato tentar escrever e bater no papel.
    nome: "5-barreira-de-verdade",
    mensagem:
      "Preciso de uma etapa nova chamada Retorno pos-cirurgico no fim do funil. Ela não existe ainda, cria pra mim.",
    esperado: "crm_create_stage tentado e RECUSADO (apenasHumano + requiresRole manager)",
  },
  /**
   * ⚠️ 6 a 10 ACRESCENTADOS na medição de vazamento (agosto/2026). Os cinco
   * primeiros exercitam quatro das catorze capacidades; um denominador de cinco
   * turnos não sustenta uma taxa. Estes pisam nas capacidades que sobraram
   * (respostas prontas, automações, time) — e a de time é a que mais interessa,
   * porque é onde mora o vocabulário de PAPEL de acesso que já vazou uma vez.
   */
  {
    nome: "6-respostas-prontas",
    mensagem: "Que respostas prontas a gente já tem cadastradas? Lista o nome de cada uma pra mim.",
    esperado: "crm_list_message_templates",
  },
  {
    nome: "7-automacoes-e-falhas",
    mensagem:
      "Alguma automação nossa falhou nas últimas horas? Quero saber quais estão ligadas e se alguma deu erro.",
    esperado: "crm_list_automation_rules + crm_list_automation_runs",
  },
  {
    nome: "8-desligar-automacao",
    mensagem:
      "Desliga a automação de boas-vindas agora, ela está disparando na hora errada e o pessoal está reclamando.",
    esperado: "crm_set_automation_rule_active (pode bater em papel/apenasHumano)",
  },
  {
    nome: "9-quem-pode-mexer",
    mensagem:
      "Quem está no nosso time hoje e quem pode mexer no funil? Preciso saber a quem pedir uma alteração.",
    esperado: "crm_list_team_members — território de papel de acesso",
  },
  {
    nome: "10-mandar-resposta-pronta",
    mensagem:
      "Pega a resposta pronta de confirmação de consulta, preenche com o nome do paciente e me mostra como vai ficar.",
    esperado: "crm_render_message_template",
  },
];

/**
 * Login como ADMIN, com MFA — porque criar versão de agente exige `admin`.
 *
 * Não é detalhe de teste: é o próprio produto dizendo quem pode mexer no
 * cérebro do assistente. Um manager configura a operação; publicar o que a IA
 * pensa é do dono.
 */
async function login(page: Page): Promise<void> {
  const secret = creds.admin_totp?.secret;
  expect(secret, "o seed precisa gravar admin_totp em .e2e-creds.json").toBeTruthy();

  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(creds.users.admin!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/login\/mfa/);

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    // Código a menos de 3s da virada da janela expira em trânsito.
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(secret!), { delay: 40 });
    try {
      await page.waitForURL(/\/app\//, { timeout: 8_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("MFA falhou depois de 2 tentativas de TOTP");
}

/**
 * Cria a versão de teste com as capacidades da W4 ligadas.
 *
 * ⚠️ A CHAVE VEM DO AMBIENTE (`QA_LLM_API_KEY`), nunca do arquivo. Ela é
 * cadastrada pela ROTA de credenciais, que a cifra — do jeito que um dono faria
 * pela tela. Chave em spec versionado é vazamento permanente: o git não esquece.
 */
async function versaoComAsCapacidades(req: APIRequestContext, agenteId: string): Promise<string> {
  const chave = process.env.QA_LLM_API_KEY;
  const provider = (process.env.QA_LLM_PROVIDER ?? "openai") as "openai" | "anthropic";
  const modelo = process.env.QA_LLM_MODEL ?? "gpt-5.6-terra";

  const canalRes = await req.get(`${APP_URL}/api/v1/channel-sessions`);
  const canalId = ((await canalRes.json()) as { data?: Array<{ id: string }> }).data?.[0]?.id;
  if (!canalId) throw new Error("a org de E2E precisa de um canal");

  // ⚠️ REUSA CREDENCIAL JÁ VALIDADA ANTES DE CRIAR OUTRA. Cada corrida criando
  // uma nova esbarrava em `credential_not_validated`: a validação da chave é
  // assíncrona e nem sempre termina antes do turno começar — o teste passava a
  // medir a corrida entre validação e execução, não o modelo.
  const jaExiste = await req.get(`${APP_URL}/api/v1/ai/credentials`);
  const existentes = (await jaExiste.json()) as {
    data?: Array<{ id: string; provider: string; validated_at?: string | null }>;
  };
  const validada = existentes.data?.find((c) => c.provider === provider && c.validated_at);
  if (validada) {
    console.info(`[QA] reusando credencial ${provider} já validada`);
    return criarVersao(req, agenteId, validada.id, canalId, provider, modelo);
  }

  let credentialId: string | undefined;
  if (chave) {
    const nova = await req.post(`${APP_URL}/api/v1/ai/credentials`, {
      data: { provider, label: `QA W4 ${provider} ${ts}`, api_key: chave },
    });
    const corpo = await nova.text();
    if (!nova.ok()) throw new Error(`criar credencial → ${nova.status()}: ${corpo.slice(0, 300)}`);
    credentialId = (JSON.parse(corpo) as { data: { id: string } }).data.id;
    console.info(`[QA] credencial ${provider} cadastrada pela rota (chave veio do ambiente)`);
    // VALIDA pela rota, como o dono faria na tela. Sem isto o runtime recusa a
    // credencial com `credential_not_validated` e TODO run morre — o que aparece
    // no relatório como "o modelo não respondeu", escondendo a causa real.
    //
    // Medido em 2026-08-06: num banco limpo (sem uma credencial validada de
    // rodada anterior), a coleta inteira devolvia turnos vazios por causa disto.
    // O caminho antigo só funcionava porque reaproveitava credencial já validada
    // à mão — dependência invisível de estado que ninguém tinha declarado.
    const val = await req.post(`${APP_URL}/api/v1/ai/credentials/${credentialId}/revalidate`);
    if (!val.ok()) {
      throw new Error(`validar credencial → ${val.status()}: ${(await val.text()).slice(0, 200)}`);
    }
    console.info(`[QA] credencial validada`);
  } else {
    const credRes = await req.get(`${APP_URL}/api/v1/ai/credentials`);
    const cred = (await credRes.json()) as { data?: Array<{ id: string; provider: string }> };
    credentialId = cred.data?.find((c) => c.provider === provider)?.id ?? cred.data?.[0]?.id;
  }
  if (!credentialId) throw new Error("sem credencial de LLM");

  return criarVersao(req, agenteId, credentialId, canalId, provider, modelo);
}

async function criarVersao(
  req: APIRequestContext,
  agenteId: string,
  credentialId: string,
  canalId: string,
  provider: string,
  modelo: string,
): Promise<string> {
  const res = await req.post(`${APP_URL}/api/v1/ai/agents/${agenteId}/versions`, {
    data: {
      system_prompt: PROMPT,
      provider,
      model: modelo,
      credential_id: credentialId,
      channel_session_id: canalId,
      tool_ids: CAPACIDADES_DO_TESTE,
      max_steps: 8,
    },
  });
  const corpo = await res.text();
  if (!res.ok()) throw new Error(`criar versão → ${res.status()}: ${corpo.slice(0, 400)}`);
  return (JSON.parse(corpo) as { data: { id: string } }).data.id;
}

test.describe("QA — o agente usa as mãos que a W4 entregou?", () => {
  test("um modelo de verdade escolhendo as capacidades novas", async ({ page }) => {
    test.setTimeout(600_000);
    fs.mkdirSync(SAIDA, { recursive: true });
    fs.mkdirSync(TURNOS, { recursive: true });
    await login(page);

    const agentesRes = await page.request.get(`${APP_URL}/api/v1/ai/agents`);
    const agentes = (await agentesRes.json()) as { data?: Array<{ id: string; name: string }> };
    const agenteId = agentes.data?.[0]?.id;
    expect(agenteId, "a org de E2E precisa de um agente").toBeTruthy();

    const versaoId = await versaoComAsCapacidades(page.request, agenteId!);
    console.info(`[QA] versão de teste ${versaoId} com ${CAPACIDADES.length} capacidades`);

    /**
     * ⚠️ FILTRO DE CENÁRIO, e ele existe por um defeito medido, não por conforto.
     * A rodada com os cinco cenários levou os quatro últimos a `401
     * unauthenticated`: a sessão do admin com MFA expira numa corrida longa, e o
     * teste passa a medir o relógio em vez do modelo. Rodar um cenário por vez
     * mantém a corrida curta o bastante para a medição valer.
     */
    const alvo = process.env.QA_CENARIO;
    const fonte = process.env.QA_PROMPT === "atendimento" ? CENARIOS_CLIENTE : CENARIOS;
    const aRodar = alvo ? fonte.filter((c) => c.nome.startsWith(alvo)) : fonte;
    console.info(`[QA] cenários nesta corrida: ${aRodar.map((c) => c.nome).join(", ")}`);

    const relatorio: string[] = [];
    /**
     * Quantos cenarios PRODUZIRAM alguma coisa. O relatorio em markdown la
     * embaixo tambem e artefato versionado de uma medicao real — e, ao
     * contrario dos turnos JSON, NENHUM teste o le. Sobrescreve-lo com uma
     * corrida vazia e destruicao que nada acusa. Medido em 2026-09-04: 507
     * linhas de respostas reais trocadas por 35 de "NENHUMA / failed".
     */
    let cenariosQueMediram = 0;
    for (const cenario of aRodar) {
      const res = await page.request.post(
        `${APP_URL}/api/v1/ai/agents/${agenteId}/versions/${versaoId}/test`,
        { data: { sample_message: cenario.mensagem }, timeout: 180_000 },
      );
      const bruto = await res.text();
      // O sufixo separa as duas corridas: sem ele, a configuração "sem operação"
      // sobrescreveria os turnos do CONTROLE e a comparação se perderia.
      const dump = path.join(
        TURNOS,
        `${PROMPT_KIND}${SEM_OPERACAO ? "__sem-operacao" : ""}__${cenario.nome}.json`,
      );
      if (!res.ok()) {
        console.info(`[QA] ${cenario.nome}: HTTP ${res.status()} — ${bruto.slice(0, 300)}`);
        relatorio.push(`## ${cenario.nome}\nFALHOU: HTTP ${res.status()}\n${bruto.slice(0, 600)}`);
        // Turno que NÃO rodou também é gravado. Um cenário que some do diretório é
        // indistinguível de um que nunca foi tentado — e taxa medida sobre denominador
        // que encolheu em silêncio é o defeito que esta medição existe para não cometer.
        //
        // Mas em ARQUIVO PRÓPRIO (`__falhou`), e isto é o conserto de um estrago
        // medido em 2026-08-08: rodando a suíte nesta máquina, sem chave de IA, os
        // 10 cenários voltaram HTTP 400 e o carimbo `rodou: false` foi gravado por
        // cima dos turnos REAIS versionados aqui — que são a fixture de
        // `tests/unit/projecao-conversador.test.ts`. Resultado: a medição histórica
        // do vazamento de 30% foi destruída e 3 testes de unidade ficaram vermelhos
        // (o controle positivo deles pegou, como foi desenhado para pegar).
        //
        // Sobrescrever uma medição bem-sucedida com um registro de falha é, ele
        // mesmo, um erro de medição: o dado histórico é o artefato mais valioso dos
        // dois. A falha continua visível, ao lado, sem apagar nada.
        fs.writeFileSync(
          dump.replace(/\.json$/, "__falhou.json"),
          JSON.stringify(
            {
              prompt_kind: PROMPT_KIND,
              cenario: cenario.nome,
              mensagem: cenario.mensagem,
              rodou: false,
              http_status: res.status(),
              corpo: bruto.slice(0, 1000),
              medido_em: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        continue;
      }
      const { data } = JSON.parse(bruto) as {
        data: {
          status: string;
          final_text?: string | null;
          tool_calls?: unknown;
          latency_ms?: number;
          cost_cents?: number;
        };
      };

      const chamadas = Array.isArray(data.tool_calls)
        ? (data.tool_calls as Array<Record<string, unknown>>)
        : [];
      /**
       * ⚠️ O array de `tool_calls` do run é uma lista de PASSOS (`serializeSteps`), e o
       * nome da ferramenta mora um nível abaixo, em `passo.tool_calls[].tool_name`. Lido
       * no nível do passo — como estava — TODO cenário imprimia `? → ? → ?`, inclusive os
       * que chamaram as ferramentas certas. Um relatório que não distingue "chamou
       * crm_list_pipelines" de "não chamou nada" não serve à pergunta que este spec faz.
       */
      const nomes = chamadas.flatMap((passo) => {
        const doPasso = Array.isArray(passo.tool_calls) ? (passo.tool_calls as Array<Record<string, unknown>>) : [];
        return doPasso.map((c) => String(c.tool_name ?? c.tool ?? c.name ?? c.toolName ?? "?"));
      });

      console.info(`[QA] --- ${cenario.nome} ---`);
      console.info(`[QA] esperado: ${cenario.esperado}`);
      console.info(`[QA] chamou:   ${nomes.length ? nomes.join(" → ") : "(NENHUMA ferramenta)"}`);
      console.info(`[QA] status:   ${data.status} · ${data.latency_ms ?? "?"}ms`);
      console.info(`[QA] resposta: ${(data.final_text ?? "(vazia)").slice(0, 400)}`);

      /**
       * ⚠️ O TURNO SÓ SOBRESCREVE A MEDIÇÃO SE TIVER MEDIDO ALGUMA COISA.
       *
       * O irmão de cima já protege o caminho do HTTP != 200, e o comentário dele
       * conta o estrago de 2026-08-08. Ficou aberto o outro caminho, e ele é mais
       * sorrateiro: SEM CHAVE DE IA a rota responde **200**, porque o pedido foi
       * aceito — o agente é que pula o turno (`reason='ai_gateway_key_missing'`,
       * o aviso que `lib/env.ts` imprime em toda inicialização). `res.ok()` é
       * verdadeiro, o gravador segue em frente, e um registro vazio cai por cima
       * do turno REAL versionado.
       *
       * Aconteceu de novo em 2026-09-04, nesta máquina: 1.758 linhas apagadas
       * dos 10 `operador__*.json`, trocadas por 80. Os testes de unidade ficaram
       * vermelhos (o controle positivo pegou, como desenhado), e o vermelho foi
       * lido como "os turnos foram renomeados" — o que levou a um commit que
       * DESLIGAVA o caso. A medição histórica sobreviveu por `git checkout`; o
       * diagnóstico errado quase não.
       *
       * A régua não olha `status`, olha RESULTADO: um turno que não produziu
       * texto nem chamou ferramenta não mediu nada, seja qual for o vocabulário
       * de status daquela versão. E ele continua sendo gravado — ao lado, como o
       * `__falhou` —, porque cenário que some do diretório é indistinguível de
       * cenário que nunca foi tentado.
       */
      const mediuAlgo = (data.final_text ?? "").trim().length > 0 || nomes.length > 0;
      if (mediuAlgo) cenariosQueMediram += 1;
      if (!mediuAlgo) {
        console.info(
          `[QA] ${cenario.nome}: HTTP 200 mas o turno veio VAZIO (status=${data.status}). ` +
            `Gravando ao lado, em __sem-resposta.json — a medição versionada não é tocada. ` +
            `Se você esperava medir de verdade, falta chave de IA.`,
        );
      }

      fs.writeFileSync(
        mediuAlgo ? dump : dump.replace(/\.json$/, "__sem-resposta.json"),
        JSON.stringify(
          {
            prompt_kind: PROMPT_KIND,
            mediu: mediuAlgo,
            cenario: cenario.nome,
            mensagem: cenario.mensagem,
            esperado: cenario.esperado,
            rodou: true,
            status: data.status,
            // CRU, sem trim: é este byte que vai ao detector.
            final_text: data.final_text ?? null,
            ferramentas: nomes,
            tool_calls: chamadas,
            latency_ms: data.latency_ms ?? null,
            cost_cents: data.cost_cents ?? null,
            model: process.env.QA_LLM_MODEL ?? "gpt-5.6-terra",
            agent_version_id: versaoId,
            medido_em: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      relatorio.push(
        [
          `## ${cenario.nome}`,
          `**Perguntaram:** ${cenario.mensagem}`,
          `**Esperado:** ${cenario.esperado}`,
          `**Ferramentas chamadas:** ${nomes.length ? nomes.join(" → ") : "NENHUMA"}`,
          `**Status:** ${data.status}`,
          "",
          "**O que o agente respondeu:**",
          "",
          (data.final_text ?? "(vazia)").trim(),
          "",
          "**Chamadas cruas:**",
          "",
          "```json",
          JSON.stringify(chamadas, null, 2).slice(0, 2500),
          "```",
        ].join("\n"),
      );
    }

    // Mesma regra dos turnos: corrida em que NADA mediu nao encosta no artefato
    // versionado. Ela ainda e gravada, ao lado, para a corrida ficar visivel.
    if (cenariosQueMediram === 0) {
      console.info(
        "[QA] nenhum cenario produziu resposta — o relatorio versionado nao foi tocado. " +
          "A corrida foi para qa-turnos-do-agente__sem-resposta.md.",
      );
    }
    fs.writeFileSync(
      path.join(
        SAIDA,
        cenariosQueMediram > 0
          ? "qa-turnos-do-agente.md"
          : "qa-turnos-do-agente__sem-resposta.md",
      ),
      `# QA — o agente usando as capacidades da W4\n\n` +
        `Modelo real, dry-run, pelo endpoint do botão "Executar teste".\n\n` +
        relatorio.join("\n\n---\n\n"),
    );
    console.info("[QA] relatório salvo em evidence/ia-360-w4/qa-turnos-do-agente.md");
  });
});
