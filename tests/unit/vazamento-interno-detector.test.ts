import { describe, expect, it } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";
import {
  detectarVazamentoInterno,
  renderVetoDeVazamento,
} from "@/lib/agent-engine/guardrails/vazamento-interno";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";

/**
 * CALIBRAÇÃO do detector de vazamento de vocabulário interno
 * (`docs/doctrine/separacao-fala-e-operacao.md`).
 *
 * Este é o ponto sensível do gate, e a assimetria não é opinião:
 *   - FALSO-POSITIVO **destrói a conversa**. A frase que o próprio repo documenta como o
 *     resultado CORRETO — «A etapa "Retorno pos-cirurgico" ainda não existe no funil...» —
 *     contém "etapa" e "funil"; e `fn_seed_default_pipeline_for_org` cria etapas chamadas
 *     "Aguardando pagamento"/"Em separação"/"Entregue", que o tenant renomeia à vontade.
 *     Um detector que cace SIGNIFICADO DE NEGÓCIO bane a única resposta boa que existe.
 *   - FALSO-NEGATIVO deixa o termo técnico chegar ao cliente — ruim, mas é o defeito que
 *     já existe hoje, e o fail-safe do gate garante que o custo nunca vira cliente mudo.
 * Por isso o detector caça FORMA (identificador técnico), nunca sentido.
 *
 * Fica em `tests/unit/` (e não em `tests/invariants/`, onde mora o irmão
 * `case-promise-detector.test.ts`) de propósito: `vitest.config.ts` EXCLUI
 * `tests/invariants/**` do `pnpm test:unit`, e a calibração precisa reprovar no gate
 * rápido — o mesmo que roda no job `verify` do CI. Puro: nenhum I/O, nenhum DB.
 */

/**
 * NÃO PODE BARRAR — textos REAIS que hoje vão ao cliente por este produto. Se algum
 * destes barrar, a lista de termos está errada, não a mensagem.
 */
const FALA_LEGITIMA: readonly string[] = [
  "Olá! Espero que sua recuperação esteja indo bem.",
  "Sinto muito pela demora — não consigo verificar por aqui o que ocorreu com a mensagem enviada pelo site, mas posso pedir que a equipe confira.",
  "Sinto muito que você esteja com dor. Posso pedir que a equipe avalie seu caso com prioridade.",
  "A etapa «Retorno pos-cirurgico» ainda não existe no funil, mas não consigo criá-la por aqui. Peça para alguém do time adicioná-la no fim do funil.",
  "Olá Ana, seu pedido 1234 foi confirmado.",
  "vou verificar seu pedido no sistema",
  "Confirmado: consulta dia 12 às 15h. Confirma pra mim?",
  "Quer que eu chame alguém do time pra fechar os detalhes com você?",
  "Sua dúvida sobre devolução: você tem 7 dias úteis após o recebimento.",
  "Olá {{nome}}, recebemos seu contato e retornamos em breve.",

  // ═══ CONGELADAS DA SONDA DE 102 FRASES (5 nichos: clínica, loja, imobiliária,
  // infoproduto, serviços). Cada uma destas era um FALSO-POSITIVO MEDIDO — a versão
  // anterior do detector calava 27 das 102, sendo 24 legítimas. Não são hipótese: são
  // fala real de atendimento brasileiro, e cada bloco abaixo nomeia a regra que as
  // calava, para que uma regressão diga QUAL correção morreu.

  // `role` = imperativo de *rolar*, e o contexto que o habilitava trazia `perfil`/`papel`
  // — duas palavras portuguesas comuníssimas. Quatro mensagens, três nichos.
  "Role a tela e clica no seu perfil pra atualizar o telefone",
  "No seu perfil, role a tela ate o final e clica em salvar",
  "Pra trocar a foto, role a tela ate o campo perfil",
  "Role a tela e imprime o papel timbrado pra assinar",

  // MENÇÃO e HASHTAG: o descascamento de pontuação tirava o `@`/`#` antes da proteção de
  // endereço rodar. O @ do Instagram do cliente virava "identificador de sistema".
  "Segue a gente no insta @loja_da_ana",
  "Bora de #black_friday? o cupom entra automatico ate 03/12",

  // CÓDIGO DE NEGÓCIO em MAIÚSCULAS. Identificador técnico desta base é lowercase; código
  // que o cliente digita é gritado. A caixa era apagada antes da varredura.
  "Seu pedido PED_2024_001 saiu pra entrega hoje",
  "Usa o cupom CUPOM_VERAO10 no checkout que da 10%",

  // `admin` casando DENTRO do e-mail — as regras de texto rodam sobre o corpo inteiro, sem
  // a proteção por token que o snake_case tem.
  "Qualquer problema com a NF fala com o admin@minhaloja.com.br",
  "Manda pro admin@imobiliariacentro.com.br que ele libera a doc",

  // Quem VENDE tecnologia diz isso ao cliente dele. Mesma razão pela qual `api` nunca
  // entrou na lista de arquitetura.
  "modulo 4 do curso e sobre backend com Node, ja ta liberado",
  "o curso ensina Supabase e Postgres do zero",
  "Tem um SDK pronto que a gente entrega junto com o curso",
  "O curso cobre JSON, integracoes e automacao",

  // `.ts` é container de vídeo e `.sql` é material de curso. Sem caminho e sem erro por
  // perto, a extensão sozinha não prova origem interna.
  "vc baixa o script banco.sql e roda no seu computador",
  "Seu arquivo gravacao.ts nao abriu, manda em mp4?",
];

/**
 * DEVE BARRAR — os vazamentos MEDIDOS com LLM real (`gpt-5.6-terra`), na doutrina
 * §problema, MAIS os controles da sonda de 102 frases. Os controles existem para que uma
 * correção de falso-positivo não possa "resolver" o problema desarmando o detector: cada
 * um cobre uma das regras que a sonda mexeu.
 */
const VAZAMENTO_MEDIDO: readonly string[] = [
  "seu perfil atual é agent, e essa alteração exige permissão de manager",
  "nenhuma entrada automática de contatos (webhook) configurada",
  "chamei crm_list_webhook_sources e não achei nada",
  "Role 'agent' insufficient (required: 'manager')",
  // controle da regra (A): slug interno + nome de tool, ambos minúsculos, na mesma frase.
  "Seu pedido esta com status interno em_separacao no crm_list_leads",
  // controle do 403: `erro` continua habilitando o código de status.
  "Deu erro 403 na hora de gerar o boleto",
  // controle do `admin`: solto continua sendo papel de acesso. A saída em português —
  // "o administrador da conta pode liberar isso pra você" — está em FALA_LEGITIMA e passa.
  "Vou pedir pro admin liberar seu acesso ao portal do paciente",
];

/**
 * ⚠️ FALSO-POSITIVO ACEITO DE PROPÓSITO — o resíduo que a sonda de 102 frases deixou, e
 * que NÃO tem conserto de FORMA. Fica congelado aqui, e não escondido: é medição, não
 * omissão. Se alguém achar o discriminador que falta, este teste é o que avisa que a
 * frase mudou de lado (mova-a para FALA_LEGITIMA).
 *
 * (1) snake_case MINÚSCULO e legítimo — login, senha, nome de documento. Não existe
 *     diferença de FORMA entre `maria_souza` e `crm_leads`, e as duas saídas testadas
 *     custam caro demais:
 *       - exigir 2+ underscores solta 28 das 65 tabelas (`crm_leads`, `event_log`,
 *         `agent_cases`…) e 4 das 12 tools nativas (`send_message`, `search_knowledge`,
 *         `send_template`, `schedule_followup`) — contado sobre `supabase/baseline.sql` +
 *         `supabase/migrations/` e sobre `AGENT_TOOL_DEFS`, não estimado;
 *       - exigir prefixo conhecido exige copiar a lista de 65 tabelas + 343 colunas,
 *         exatamente a "lista copiada que envelhece no dia seguinte" que o cabeçalho do
 *         detector proíbe — e ainda perderia `em_separacao`, que não é tabela nem `crm_`.
 *     O custo real do resíduo é UM turno a mais: `MAX_VETOS_DE_VOCABULARIO_INTERNO = 2`
 *     em `inbound-turn.ts` libera o envio no segundo veto. FP aqui não cala cliente.
 *
 * (2) `webhook` — a única palavra de arquitetura com vazamento MEDIDO ("nenhuma entrada
 *     automática de contatos (webhook) configurada"). Tirá-la reabre o defeito que este
 *     módulo veio fechar; mantê-la cobra uma reescrita do tenant AGÊNCIA, que revende
 *     integração. A saída certa é lista por organização — deliberadamente NÃO
 *     implementada: configuração sem demanda medida é especulação.
 */
const FALSO_POSITIVO_ACEITO: readonly string[] = [
  "A senha do wifi da loja e loja_2024",
  "Seu login na loja e maria_souza, a senha eu mando em seguida",
  "Seu login e joao_pedro, a senha vc cria no primeiro acesso",
  "O resultado do exame_sangue sai em 3 dias uteis",
  "O bonus_extra do combo entra automatico no carrinho",
  "Consigo te mandar o laudo_vistoria por aqui?",
  "A aula de webhooks e no modulo 6",
  "A gente configura o webhook do seu sistema por R$ 500,00, topa?",
];

describe("detectarVazamentoInterno — calibração contra fala legítima", () => {
  it.each(FALA_LEGITIMA)("NÃO barra (vai ao cliente hoje): %s", (body) => {
    const r = detectarVazamentoInterno(body);
    // A mensagem de erro carrega o termo culpado — sem ela, uma regressão aqui vira
    // "expected true to be false" e alguém gasta meia hora procurando qual palavra.
    expect(r.termos.join(" | ")).toBe("");
    expect(r.achou).toBe(false);
  });

  it("vocabulário de NEGÓCIO nunca barra — nome de etapa é dado do tenant, não do sistema", () => {
    // `fn_seed_default_pipeline_for_org` (supabase/baseline.sql) semeia estes nomes; o
    // tenant renomeia à vontade. Consultar `crm_stages` para montar blocklist seria
    // transformar dado de cliente em censura.
    const negocio = [
      "Seu pedido está em separação e sai hoje.",
      "Está aguardando pagamento — assim que cair, eu te aviso.",
      "Movi você para a etapa de proposta no nosso funil.",
      "Deixei um marcador na sua oportunidade e o responsável assume amanhã.",
      "Seu orçamento com desconto: R$ 403,00 à vista.",
      // ACHADO por sonda, não por dedução: `role` também é o imperativo de *rolar*.
      // A lista original de termos barrava esta instrução — cliente mudo por uma
      // palavra que ninguém suspeitava. Ver o cabeçalho de PALAVRAS_PAPEL.
      "Role a tela pra baixo que aparece o botão de pagar.",
      "Nosso agente de IA responde 24h por dia.",
      "O administrador da conta pode liberar isso pra você.",
      "A campanha de pós-venda tem um modelo de mensagem para isso.",
      "Sua consulta foi remarcada; a agenda já está atualizada.",
    ];
    for (const body of negocio) {
      expect({ body, termos: detectarVazamentoInterno(body).termos }).toEqual({ body, termos: [] });
    }
  });

  it("e-mail e link do cliente não são identificador de sistema", () => {
    // O underscore aqui é do endereço. Barrar um e-mail que o lead PEDIU é o
    // falso-positivo mais caro do conjunto.
    expect(detectarVazamentoInterno("me escreve em contato_vendas@empresa.com.br").termos).toEqual([]);
    expect(detectarVazamentoInterno("o cupom está em https://loja.com.br/promo_verao").termos).toEqual([]);
    const UUID = "afc35b68-fe81-4861-a4d4-f1603cb47a4f";
    const cliente = { linkDoCliente: true };
    // #4951: o link público do portal, com o UUID como segmento do caminho, chega ao cliente.
    expect(
      detectarVazamentoInterno(`Seu portal do cliente está disponível: https://portal.example.com/projeto/${UUID}.`, cliente)
        .termos,
    ).toEqual([]);
    // Controles: a exceção é só esta. Fora da mensagem ao cliente (tradução de erro de
    // ferramenta), o mesmo link segue barrado — a falha fica fechada.
    expect(detectarVazamentoInterno(`https://portal.example.com/projeto/${UUID}`).achou).toBe(true);
    for (const texto of [
      `Seu atendimento é /projeto/${UUID}`, // caminho sem esquema
      `Código: caso@${UUID}`, // colado a um @
      `Veja https://portal.example.com/projeto?id=${UUID}`, // na query, não no caminho
      `Erro em https://abcdefgh.supabase.co/rest/v1/contacts/${UUID}`, // host de infraestrutura
      `Veja https://crm.example.com/api/v1/leads/${UUID}`, // caminho de API
      `Veja http://10.0.0.5/projeto/${UUID}`, // IP
    ]) {
      expect(detectarVazamentoInterno(texto, cliente).achou, texto).toBe(true);
    }
  });
});

/**
 * AS SONDAS DE MECANISMO — pares mínimos em que só UMA coisa muda entre as duas frases.
 * Cada par isola a regra corrigida; sabotar a correção reprova exatamente aqui, e não
 * numa lista de 26 frases onde ninguém descobre qual regra morreu.
 */
describe("sondas de mecanismo — pares mínimos por correção", () => {
  it("menção/hashtag vs. endereço: o mesmo nome dos dois lados", () => {
    // A incoerência que denunciou o bug: `@loja_da_ana` barrava e `instagram.com/loja_da_ana`
    // — o MESMO nome — passava. O `@` sumia no descascamento antes da proteção rodar.
    expect(detectarVazamentoInterno("@loja_da_ana").termos).toEqual([]);
    expect(detectarVazamentoInterno("instagram.com/loja_da_ana").termos).toEqual([]);
    expect(detectarVazamentoInterno("#black_friday").termos).toEqual([]);
    // A menção com pontuação em volta é o caso que o teste do token BRUTO segura sozinho:
    // aqui o token não COMEÇA com `@`, e o descascamento faria o `@` sumir de novo.
    expect(detectarVazamentoInterno("Segue a gente no insta (@loja_da_ana)").termos).toEqual([]);
  });

  it("admin: colado a e-mail passa, solto continua barrando", () => {
    expect(detectarVazamentoInterno("admin@loja.com.br").termos).toEqual([]);
    expect(detectarVazamentoInterno("contato_vendas@loja.com.br").termos).toEqual([]);
    expect(detectarVazamentoInterno("fala com o admin").termos).toContain("admin");
    // "administrador" nunca casou, e continua sendo a saída em português que o veto pede.
    expect(detectarVazamentoInterno("fala com o administrador da conta").termos).toEqual([]);
  });

  it("role: o verbo rolar passa mesmo perto de 'perfil'/'papel'", () => {
    expect(detectarVazamentoInterno("Role a tela").termos).toEqual([]);
    expect(detectarVazamentoInterno("Role a tela ate o seu perfil").termos).toEqual([]);
    expect(detectarVazamentoInterno("Role a tela e pega o papel").termos).toEqual([]);
    // o que segura a ponta: os três vazamentos medidos trazem manager/insufficient/required.
    expect(detectarVazamentoInterno("a role exigida e manager").termos).toContain("role");
    expect(detectarVazamentoInterno("role insufficient").termos).toContain("role");
  });

  it("agent CONTINUA usando perfil/papel — o corte do contexto foi só do 'role'", () => {
    // Sabotagem óbvia seria cortar `perfil` dos dois de uma vez. Este é o vazamento
    // medido nº 1: sem `perfil` no contexto do `agent`, nenhuma outra regra o pega.
    expect(detectarVazamentoInterno("seu perfil atual e agent").termos).toContain("agent");
  });

  it("CAIXA: código de negócio é MAIÚSCULO, identificador técnico é minúsculo", () => {
    expect(detectarVazamentoInterno("Seu pedido PED_2024_001 saiu").termos).toEqual([]);
    expect(detectarVazamentoInterno("Usa o cupom CUPOM_VERAO10").termos).toEqual([]);
    // o mesmo formato, minúsculo, continua sendo pego — é o que separa os dois mundos.
    expect(detectarVazamentoInterno("status em_separacao").termos).toEqual(["em_separacao"]);
    expect(detectarVazamentoInterno("chamei crm_list_leads").termos).toEqual(["crm_list_leads"]);
  });

  it("nenhum nome de tool tem maiúscula — a premissa da regra da CAIXA, verificada", () => {
    // Exigir minúsculas no snake_case só é seguro porque TODO identificador desta base é
    // lowercase. Se nascer uma tool `crmListLeads` ou `CRM_X`, esta regra a solta em
    // silêncio — e é aqui que isso reprova, não em produção.
    const comMaiuscula = [
      ...TOOL_CATALOG.map((t) => t.name),
      ...Object.keys(AGENT_TOOL_DEFS),
    ].filter((n) => n !== n.toLowerCase());
    expect(comMaiuscula).toEqual([]);
  });

  it("403: contexto de erro barra, 'código' e preço passam", () => {
    expect(detectarVazamentoInterno("Seu codigo e 403").termos).toEqual([]);
    expect(detectarVazamentoInterno("R$ 403,00").termos).toEqual([]);
    expect(detectarVazamentoInterno("recebi erro 403 ao tentar").termos).toContain("403");
    expect(detectarVazamentoInterno("status 403 forbidden").termos).toContain("403");
  });

  it("arquivo de código: precisa de caminho ou de erro por perto", () => {
    expect(detectarVazamentoInterno("Seu arquivo gravacao.ts nao abriu").termos).toEqual([]);
    expect(detectarVazamentoInterno("baixa o script banco.sql").termos).toEqual([]);
    expect(detectarVazamentoInterno("falhou em lib/guardrails/before-send.ts").achou).toBe(true);
    expect(detectarVazamentoInterno("deu erro em gravacao.ts").achou).toBe(true);
  });

  it("as palavras de arquitetura que saíram — copy de quem VENDE tecnologia", () => {
    for (const body of [
      "o curso e sobre backend com Node",
      "o curso ensina Supabase e Postgres do zero",
      "tem um SDK pronto junto com o curso",
      "o curso cobre JSON e integracoes",
    ]) {
      expect({ body, termos: detectarVazamentoInterno(body).termos }).toEqual({ body, termos: [] });
    }
    // as que FICARAM, e por quê: `webhook` tem vazamento medido; as demais não têm
    // tradução de negócio nenhuma em pt-BR.
    expect(detectarVazamentoInterno("o webhook nao esta configurado").termos).toContain("webhook");
    expect(detectarVazamentoInterno("o payload veio vazio").termos).toContain("payload");
  });
});

describe("falso-positivo ACEITO — congelado, não escondido", () => {
  it.each(FALSO_POSITIVO_ACEITO)("ainda barra (resíduo documentado): %s", (body) => {
    // Se um destes PASSAR, ótimo — mas mova a frase para FALA_LEGITIMA e escreva por quê.
    // Um resíduo que some sem alguém decidir é uma regra que morreu sem ninguém notar.
    expect(detectarVazamentoInterno(body).achou).toBe(true);
  });
});

describe("detectarVazamentoInterno — os vazamentos medidos", () => {
  it.each(VAZAMENTO_MEDIDO)("BARRA (medido com LLM real): %s", (body) => {
    expect(detectarVazamentoInterno(body).achou).toBe(true);
  });

  it("nomeia o termo culpado — o veto precisa dele para ensinar", () => {
    expect(detectarVazamentoInterno("nenhuma entrada automática de contatos (webhook) configurada").termos)
      .toEqual(["webhook"]);
    expect(detectarVazamentoInterno("chamei crm_list_webhook_sources e não achei nada").termos)
      .toEqual(["crm_list_webhook_sources"]);
  });

  it("'agent' sozinho não basta — mas 'perfil ... agent' sim", () => {
    // A ressalva documentada: `\bagent\b` está a uma letra de "agente", a palavra mais
    // comum do domínio. Fora de contexto de papel ela cala mensagem legítima.
    expect(detectarVazamentoInterno("o nome do plano é agent").achou).toBe(false);
    expect(detectarVazamentoInterno("seu perfil atual e agent").termos).toContain("agent");
  });

  it("403 só em contexto de status — preço com 403 passa", () => {
    expect(detectarVazamentoInterno("o total ficou R$ 403,00").achou).toBe(false);
    expect(detectarVazamentoInterno("recebi erro 403 ao tentar").termos).toContain("403");
  });

  it("erro cru e nome de arquivo de código", () => {
    expect(detectarVazamentoInterno("Error: duplicate key value viola a unicidade").achou).toBe(true);
    expect(detectarVazamentoInterno("falhou em lib/guardrails/before-send.ts").achou).toBe(true);
    expect(detectarVazamentoInterno("null value in column organization_id").achou).toBe(true);
  });

  it("tabela.coluna vaza — o ponto do meio não é e-mail nem arquivo", () => {
    expect(detectarVazamentoInterno("não achei crm_leads.organization_id").termos)
      .toEqual(["crm_leads", "organization_id"]);
  });

  it("'role' precisa do contexto de papel — o verbo rolar não é vazamento", () => {
    expect(detectarVazamentoInterno("role a pagina ate o fim").achou).toBe(false);
    expect(detectarVazamentoInterno("Role 'agent'").termos).toContain("role");
    expect(detectarVazamentoInterno("a role exigida e manager").termos).toContain("role");
  });

  it("é robusto a caixa e acento (normaliza antes de casar)", () => {
    expect(detectarVazamentoInterno("ROLE INSUFFICIENT").achou).toBe(true);
    expect(detectarVazamentoInterno("o WEBHOOK não está configurado").achou).toBe(true);
  });

  it("no-op em string vazia", () => {
    expect(detectarVazamentoInterno("")).toEqual({ achou: false, termos: [], categorias: [] });
  });
});

/**
 * A regra (B) manda DERIVAR os nomes de tool em runtime, "para tool nova entrar sozinha".
 * O detector deriva do `TOOL_CATALOG` (client-safe) mas NÃO importa `AGENT_TOOL_DEFS`
 * (ciclo + arrastaria o motor inteiro para dentro de um módulo puro — ver o cabeçalho de
 * `vazamento-interno.ts`). O que segura a ponta solta é este bloco: se uma tool nova
 * escapar do detector, ele reprova aqui, no gate rápido.
 */
describe("toda tool declarada é detectável — a regra (B) sem lista copiada", () => {
  it.each(TOOL_CATALOG.map((t) => t.name))("catálogo MCP: %s", (name) => {
    expect(detectarVazamentoInterno(`usei ${name} para isso`).termos).toContain(name);
  });

  it.each(Object.keys(AGENT_TOOL_DEFS))("tool nativa do agente: %s", (name) => {
    expect(detectarVazamentoInterno(`usei ${name} para isso`).termos).toContain(name);
  });

  it("nenhuma tool é palavra única — banir palavra solta é o erro que a regra central proíbe", () => {
    // Se esta reprovar, nasceu uma tool sem `_` (ex.: `handoff`). A regra (A) não a pega,
    // e fazer o detector caçá-la baniria essa palavra da conversa com o cliente. É uma
    // decisão humana, não um ajuste de regex — daí o teste, e não um "conserto" silencioso.
    const semUnderscore = [
      ...TOOL_CATALOG.map((t) => t.name),
      ...Object.keys(AGENT_TOOL_DEFS),
    ].filter((n) => !n.includes("_"));
    expect(semUnderscore).toEqual([]);
  });
});

describe("renderVetoDeVazamento — o veto ensina a SAÍDA, não só o problema", () => {
  it("nomeia o termo detectado", () => {
    expect(renderVetoDeVazamento(["webhook"])).toContain('"webhook"');
  });

  it("quando o termo é uma tool, oferece o rótulo em português do catálogo", () => {
    const texto = renderVetoDeVazamento(["crm_list_webhook_sources"]);
    expect(texto).toContain("crm_list_webhook_sources");
    expect(texto.toLowerCase()).toContain("entradas automáticas");
  });

  it("manda REESCREVER — um veto que só nega faz o modelo tentar de novo igual", () => {
    const texto = renderVetoDeVazamento(["webhook"]);
    expect(texto).toMatch(/REESCREVA/);
    expect(texto).toMatch(/em português de gente/);
  });

  it("NÃO empurra para 'a equipe verifica' — isso cairia no casePromiseGate", () => {
    // Veto que empurra o modelo para o veto seguinte não ensina, só adia o silêncio.
    expect(renderVetoDeVazamento(["webhook"])).not.toMatch(/equipe|time vai|acionar/i);
  });
});
