import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PLAYBOOK SEMEADO E `description` DE FERRAMENTA FALAM COM O MESMO MODELO, NA MESMA JANELA.
 *
 * ## O defeito que fez este teste existir
 *
 * O playbook `agendamento` (`supabase/baseline.sql`) manda, ao remarcar, "cancele/substitua
 * o anterior explicitamente". A `description` de `crm_reschedule_appointment` manda o
 * oposto: remarcar é o MESMO compromisso mudando de hora, e cancelar+marcar faz o cliente
 * receber dois avisos contraditórios.
 *
 * Os dois textos chegam ao modelo **juntos** — `serializeStablePrefix`
 * (`lib/agent-engine/edge/llm/stable-prefix.ts:92`) serializa `tools` E `system`, e o
 * `system` é o corpo do playbook. Não dá para prever qual vence.
 *
 * E o gatilho que injeta esse playbook é a própria palavra "remarcar": a frase
 * "preciso remarcar minha consulta" é o gatilho literal.
 *
 * ## ⚠️ O QUE ESTE GATE **NÃO** PROVA — e sem esta ressalva o verde mente
 *
 * Ele cobra que o corpo do playbook **CITE** o nome da ferramenta. Isso prova que o
 * playbook **conhece** a ferramenta; **não prova que ele concorda com ela**. Um corpo pode
 * citar `crm_reschedule_appointment` e mandar cancelar-e-remarcar na linha seguinte, e este
 * teste fica verde.
 *
 * Conhecer é pré-condição de concordar, e a omissão é a parte mecanizável — por isso o gate
 * vale. Mas quem ler o verde como "não há contradição" está lendo mais do que está escrito.
 * A contradição continua sendo trabalho de revisão humana.
 *
 * ## E o limite de alcance
 *
 * Só alcança playbook **semeado** (que vive no `baseline.sql`, versionado). Playbook que o
 * cliente escreveu no banco dele é invisível para qualquer gate estático — para esse lado, o
 * caminho é checar na MONTAGEM do prompt, em runtime, onde o corpo real do tenant já está.
 */
const RAIZ = process.cwd();
const BASELINE = path.join(RAIZ, "supabase/baseline.sql");

/**
 * A declaração: playbook semeado → ferramentas que falam da MESMA ação.
 *
 * Quem escreve ferramenta nova declara aqui, e o gate cobra a citação. É o mesmo padrão de
 * `prova-em-tela`: endereço declarado tem de ser real.
 */
const PLAYBOOK_FALA_DE: Record<string, string[]> = {
  agendamento: [
    // O PRIMEIRO passo da cadeia (#1019): sem o `slug` que esta ferramenta devolve,
    // `crm_find_free_slots` não tem o `event_type_slug` que ela EXIGE — e o corpo que a
    // 0191 publicou não a nomeava em nenhuma linha (medido: zero ocorrências em
    // `supabase/`). Citar é pré-condição de ensinar a ordem; o caso logo abaixo é quem
    // cobra a ordem.
    "crm_list_event_types",
    "crm_find_free_slots",
    "crm_book_appointment",
    "crm_reschedule_appointment",
    "crm_cancel_appointment",
  ],
};

/** Extrai os corpos `$body$…$body$` do baseline, com o nome do playbook. */
function playbooksSemeados(): Map<string, string> {
  const sql = readFileSync(BASELINE, "utf8");
  const achados = new Map<string, string>();
  const re = /values\s*\(\s*null,\s*'([a-z_]+)',[\s\S]*?\$body\$([\s\S]*?)\$body\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) achados.set(m[1]!, m[2]!);
  return achados;
}

/**
 * ⚠️ A LISTA ESTÁ VAZIA, E ISSO É O ESTADO CERTO — não um esquecimento.
 *
 * Ela nasceu com `agendamento` dentro: o corpo do playbook era anterior às ferramentas de
 * agenda e a catraca teria nascido vermelha. A dívida foi PAGA na migration 0191, que
 * publicou o corpo novo e repontou `skill_pointers` — e o Arquiteto mediu, num pg17 efêmero, o que acontece
 * ao publicar NO FORMATO DA 0069: aplicar o corpo novo com `if not exists` sobre um banco
 * que já a tinha deixava **1 versão, ponteiro no corpo ANTIGO e NENHUM erro**. Um bloco que vira
 * no-op e não reclama é indistinguível de um que funcionou.
 *
 * ⚠️ E POR QUE A ENTRADA NÃO PODIA FICAR DEPOIS DE PAGA: enquanto ela existe, o `continue`
 * abaixo pula justamente o playbook que ela nomeia. Antes do pagamento isso era dívida
 * declarada; depois, viraria um DESLIGADOR PERMANENTE da vigilância sobre esse playbook —
 * verde e cego, no lugar exato onde o gate foi feito para olhar. (O argumento é do
 * Arquiteto, que provou que sem a entrada fica verde e mesmo assim não a removeu, porque
 * o arquivo vive noutra árvore.)
 *
 * Se alguma dívida nova entrar aqui, ela vem com motivo escrito — e o caso
 * "dívida congelada que JÁ FOI PAGA" abaixo a expulsa sozinho quando o playbook passar a
 * citar as ferramentas. Isso deixou de ser promessa e virou mecanismo.
 *
 * ⚠️ LIMITE, para não herdar frase otimista: aquele caso só alcança dívida de playbook
 * que esteja em `PLAYBOOK_FALA_DE`. Dívida congelada por OUTRO motivo continua sem
 * expiração automática e segue dependendo de alguém lembrar. Fecha a classe que temos
 * hoje, não a categoria.
 */
const DIVIDA_CONGELADA: Record<string, string> = {};

describe("playbook semeado cita a ferramenta que fala da mesma ação", () => {
  const corpos = playbooksSemeados();

  it("CONTROLE: a varredura acha os playbooks do baseline", () => {
    // Sem isto, uma mudança no formato do seed devolveria zero corpos e o teste abaixo
    // passaria varrendo o vazio — verde por instrumento morto.
    expect(corpos.size).toBeGreaterThan(0);
    expect([...corpos.keys()]).toContain("agendamento");
  });

  it("CONTROLE: os corpos têm conteúdo, não são casca vazia", () => {
    for (const [nome, corpo] of corpos) {
      expect(corpo.length, `corpo de ${nome} veio vazio`).toBeGreaterThan(200);
    }
  });

  it("toda dívida congelada explica o porquê, e o playbook dela existe", () => {
    // Allowlist sem razão vira depósito, e depósito não é exceção: é a regra desmontada.
    // E se o playbook sumir do baseline, a entrada aqui vira lixo que esconde o gate.
    for (const [playbook, motivo] of Object.entries(DIVIDA_CONGELADA)) {
      expect(motivo.length, `${playbook} está congelado sem motivo escrito`).toBeGreaterThan(40);
      expect(corpos.has(playbook), `${playbook} está congelado e não existe no baseline`).toBe(true);
      // E tem de estar DECLARADO: entrada que `PLAYBOOK_FALA_DE` não conhece é a única que
      // o caso de expiração abaixo não sabe avaliar — e, sem esta linha, ela ficava na lista
      // para sempre, porque o que a expulsaria é justamente o caso que a pula.
      expect(
        PLAYBOOK_FALA_DE[playbook] !== undefined,
        `${playbook} está congelado e não está em PLAYBOOK_FALA_DE — nada aqui pode expirá-lo`,
      ).toBe(true);
    }
  });

  it("dívida congelada que JÁ FOI PAGA não pode continuar aqui", () => {
    // Nasceu de um estado REAL, não de hipótese: a integração ficou com o corpo novo
    // publicado (`a86c0e9d`) E a entrada ainda na lista, porque o commit que a removia
    // (`47121eaa`) veio por outra branch. Medido pelo Arquiteto sabotando as quatro
    // citações no baseline: o gate da `integra/w0` passava 4/4 e o do `cal/w2-mcp`
    // reprovava — mesmo arquivo quebrado, um dos dois cego.
    //
    // O comentário do topo prometia "sai no dia em que for paga, não no dia em que alguém
    // lembrar". Isso era INTENÇÃO. Este caso é o mecanismo — e a diferença entre os dois é
    // a lição que o dia inteiro repetiu.
    const obsoletas: string[] = [];
    const naoSeiAvaliar: string[] = [];
    for (const playbook of Object.keys(DIVIDA_CONGELADA)) {
      const corpo = corpos.get(playbook);
      const ferramentas = PLAYBOOK_FALA_DE[playbook];
      if (corpo === undefined || ferramentas === undefined) {
        // ⚠️ TERCEIRA SAÍDA, e ela existe por medição: este `continue` era mudo, e mudo
        // significava que a entrada caía na classe "ainda não paga" — o valor certo não é
        // paga nem não-paga, é NÃO SEI, e não-sei tem de ter onde morar. O caso acima já
        // reprova as duas ausências; se a execução chegar aqui, foi ELE que parou de cobrir,
        // e o silêncio esconderia exatamente essa regressão. (Achado do Arquiteto, medido
        // no meu próprio instrumento: sonda de duas saídas despeja o incerto numa delas.)
        naoSeiAvaliar.push(playbook);
        continue;
      }
      if (ferramentas.every((f) => corpo.includes(f))) obsoletas.push(playbook);
    }
    expect(
      naoSeiAvaliar,
      "Entrada congelada que este caso não sabe avaliar (playbook ausente do baseline ou não " +
        "declarado em PLAYBOOK_FALA_DE). Ela não expira por nenhum caminho: a guarda que a " +
        "expulsaria é justamente esta. Corrija a lista — não ignore.",
    ).toEqual([]);
    expect(
      obsoletas,
      "A dívida foi PAGA — o playbook já cita todas as ferramentas declaradas — e a entrada " +
        "continua na lista. A partir de agora ela não adia nada: ela DESLIGA a vigilância " +
        "sobre esse playbook. Remova a entrada.",
    ).toEqual([]);
  });

  it("todo playbook declarado cita as ferramentas que falam da mesma ação", () => {
    const faltando: string[] = [];
    for (const [playbook, ferramentas] of Object.entries(PLAYBOOK_FALA_DE)) {
      if (DIVIDA_CONGELADA[playbook]) continue; // nomeada acima, com dono e endereço.
      const corpo = corpos.get(playbook);
      if (corpo === undefined) {
        faltando.push(`${playbook} → o playbook não existe no baseline`);
        continue;
      }
      for (const f of ferramentas) {
        if (!corpo.includes(f)) faltando.push(`${playbook} → não cita ${f}`);
      }
    }

    expect(
      faltando,
      "Playbook semeado fala de uma ação para a qual existe ferramenta, e não a nomeia. " +
        "Os dois textos chegam ao modelo na MESMA janela (tools + system em " +
        "`serializeStablePrefix`), e o playbook que não conhece a ferramenta manda o modelo " +
        "fazer à mão o que ele tem capacidade de fazer — ou, pior, manda o CONTRÁRIO. " +
        "⚠️ Citar não é concordar: este gate pega a OMISSÃO, não a contradição.",
    ).toEqual([]);
  });
});

/**
 * A ORDEM da cadeia (#1019) — citar não é ensinar a sequência.
 *
 * O gate acima cobra que o playbook NOMEIE a ferramenta. Este cobra o que a issue
 * mediu faltar: o corpo semeado pela 0191 começava o meio da cadeia — mandava
 * consultar `crm_find_free_slots` sem dizer de onde vem o `event_type_slug` que ela
 * EXIGE, e o passo 2 ainda mandava responder "vou confirmar e te retorno" com
 * handoff. Medido no relato: 7 chamadas de `crm_list_event_types` com sucesso e ZERO
 * de `crm_find_free_slots` no `api_audit_log`.
 *
 * A régua de CONDIÇÃO é a mesma dos blocos residentes (`blocosDeAgendaResidentes`):
 * todo nome de ferramenta novo tem de estar dentro de um "se você a tem". Este texto
 * é org-wide, servido por keyword, e não sabe quais capacidades o agente tem ligadas
 * — nomear ferramenta ausente faz o modelo tentar chamá-la.
 */
describe("o playbook da agenda ensina os DOIS passos da cadeia (#1019)", () => {
  const corpo = playbooksSemeados().get("agendamento") ?? "";

  it("CONTROLE: o playbook existe no baseline", () => {
    expect(corpo.length).toBeGreaterThan(200);
  });

  it("nomeia o primeiro passo e o `slug` que liga um ao outro", () => {
    expect(corpo).toContain("crm_list_event_types");
    expect(corpo).toContain("event_type_slug");
    expect(corpo).toContain("no MESMO TURNO");
    // o primeiro passo entra CONDICIONADO — ver a régua no docblock acima
    expect(corpo).toContain("Se `crm_list_event_types` também estiver na sua mão");
    // o passo 1 também: a condição é TER a ferramenta, não só faltar o `slug`
    expect(corpo).toContain("e `crm_list_event_types` está na sua mão");
  });

  it("manda chamar a consulta de horários ANTES de responder, não depois da lista", () => {
    expect(corpo).toContain("chame\n  `crm_find_free_slots` com o `event_type_slug` dele ANTES de responder");
  });

  it("a cadeia continua até a marcação, com o `starts_at` que a consulta devolveu", () => {
    expect(corpo).toContain("crm_book_appointment");
    expect(corpo).toContain("`starts_at` que `crm_find_free_slots` devolveu");
    // agente só de consulta não tem a marcação: a ordem de gravar vem condicionada
    expect(corpo).toContain("e `crm_book_appointment` está na sua mão");
  });

  it("o desfecho do handoff continua CONDICIONADO a não ter a ferramenta", () => {
    // Critério (c): nada aqui ativa ferramenta sem permissão. "Vou confirmar e te
    // retorno" + handoff continua sendo o caminho de quem NÃO tem a ferramenta — o
    // que mudou foi ele deixar de ser o caminho de quem tem.
    expect(corpo).toContain("- SE você não tem a ferramenta → não invente");
    expect(corpo).toContain("- Você não tem essa ferramenta → aí sim:");
  });
});
