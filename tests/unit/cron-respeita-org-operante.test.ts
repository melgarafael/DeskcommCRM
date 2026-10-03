/**
 * TODO CRON RESPEITA A ORGANIZAÇÃO PARADA — OU DIZ, POR ESCRITO, POR QUE NÃO PRECISA.
 *
 * Organização parada (suspensa, redigida, arquivada — `lib/organizacao/operante.ts`)
 * não gasta nem fala. Rota nova em `app/api/v1/cron/` nasce sem saber disso, e o
 * modo de falha é mudo: nada quebra, a org suspensa só continua custando.
 *
 * A rota passa se ELA ou um módulo alcançável pelos seus imports `@/` (até
 * PROFUNDIDADE_MAXIMA saltos) USA um símbolo de FILTRO da régua — chama
 * `idsDeOrgsParadas`/`ehOperante`, ou escreve `fn_org_operante(` no SQL. O filtro
 * de várias rotas mora em `lib/`, às vezes dois níveis abaixo (followup-flow-worker
 * → silence-sweep → gate). Importar não basta, e `OrgNaoOperanteError`/
 * `assertOrgOperante` não contam: recusar na saída não é filtro. Import só de TIPO
 * não conta nem é aresta — tipo não filtra nada. E a porta de saída
 * (`app/api/v1/messages/_handler.ts`) não é aresta: ela recusa o envio, mas quem a
 * chama já abriu conversa, gastou a varredura e vai retentar na próxima rodada.
 *
 * Teto conhecido: a granularidade é o MÓDULO. Um import de qualquer função de um
 * módulo que filtra conta, ainda que a função importada não passe pelo filtro.
 *
 * As demais constam de `SEM_FILTRO` com o motivo. A lista só encolhe: entrada de
 * rota que sumiu, ou que passou a usar a régua, reprova até ser tirada.
 *
 * A rota da cobrança (PR 3a) importa a régua para o filtro da §3.2 e não entra
 * na lista.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const DIR_CRON = join(RAIZ, "app", "api", "v1", "cron");
const MODULO_DA_REGUA = "@/lib/organizacao/operante";
const FUNCAO_SQL_DA_REGUA = "fn_org_operante(";
/** Só estes FILTRAM. `OrgNaoOperanteError`/`assertOrgOperante` recusam na saída e não contam. */
const SIMBOLOS_DE_FILTRO = new Set(["idsDeOrgsParadas", "ehOperante"]);
/**
 * Saltos de import a partir da rota: no followup-flow-worker, o símbolo mais perto mora a 2
 * (silence-sweep → gate). Esse gate filtra só a VARREDURA de silêncio; o tick do motor é
 * filtrado no SQL do claim (`fn_claim_due_followup_enrollments`, migration 0501), que esta
 * cerca não enxerga — quem o prova é tests/invariants/followup-org-suspensa.test.ts.
 */
const PROFUNDIDADE_MAXIMA = 4;
/** Importar isto não faz a rota respeitar a org parada: assert na saída não é filtro. */
const NAO_E_FILTRO = new Set([join(RAIZ, "app", "api", "v1", "messages", "_handler.ts")]);

const SEM_FILTRO: Record<string, string> = {
  "agenda-expira-pendentes": "só libera o horário de pedido pendente vencido; escrita interna, sem custo nem saída",
  "agenda-google-push": "sincronia com o Google Agenda: deliberadamente não gatilhada (spec §4)",
  "agenda-google-refresh": "renova token do Google Agenda: deliberadamente não gatilhado (spec §4)",
  "agenda-google-sync": "sincronia com o Google Agenda: deliberadamente não gatilhada (spec §4)",
  "agent-dispatcher": "no-op permanente desde a convergência; não há o que filtrar",
  "canal-mudo-watcher": "só abre aviso na Central da própria org; sem custo nem saída",
  "case-stale-watcher": "só reabre aviso de caso na Central; sem custo nem saída",
  "channel-health": "só pergunta ao transporte se a sessão está de pé; nenhuma mensagem ao cliente",
  "contact-avatars": "baixa a foto de perfil: deliberadamente não gatilhado (spec §4)",
  "contact-birthdays": "só emite contact.birthday; o consumidor (automationRulesHandler) é 'pula'",
  "contact-phones": "só consulta o transporte para achar o telefone; nenhuma mensagem ao cliente",
  "contact-proposals-watcher": "só expira propostas de dado vencidas; escrita interna",
  "data-retention": "retenção e expurgo: obrigação, nunca bloqueada (spec §1.3)",
  "followup-sem-agente": "só abre aviso na Central sobre fluxo sem agente; sem custo nem saída",
  "handoff-devolucao": "devolve a conversa à IA; a IA só fala por evento, barrado pelo gate e pelo dispatcher",
  "lead-date-field-due": "só emite lead.date_field_due; o consumidor (automationRulesHandler) é 'pula'",
  "lead-time-triggers": "só emite lead.silent_for/stage_stale; o consumidor (automationRulesHandler) é 'pula'",
  "lgpd-sla-watcher": "LGPD nunca é bloqueada (spec §1.3)",
  "media-retention": "retenção de mídia: apagar é obrigação, não custo",
  "proposal-acceptance-rate": "só calcula a taxa e abre aviso interno; sem custo nem saída",
  "proposal-expiry": "só vence proposta e abre aviso interno; sem custo nem saída",
  "proposal-promised-not-created": "só abre aviso interno de promessa vencida; sem custo nem saída",
  "proposta-travada": "só destrava proposta presa em 'enviando'; escrita interna",
  "recover-stuck-messages": "marca failed e avisa, nunca reenvia: deliberadamente não gatilhado (spec §4)",
  "recurring-entries": "só gera lançamento financeiro pendente; escrita interna",
  "risk-watcher": "só classifica risco e registra a proposta de reativação; nada sai",
  "routing-worker": "só distribui o dono da conversa; sem custo nem saída",
  "snooze-watcher": "só reabre conversa adiada; sem custo nem saída",
  "storage-redaction": "LGPD e retenção nunca são bloqueadas (spec §1.3)",
  "sync-model-catalog": "catálogo da instalação inteira; não pertence a organização nenhuma",
  "webhook-log-retention": "retenção do arquivo de webhook: obrigação, nunca bloqueada",
  "webhook-replay": "reprocessa ENTRADA do WAHA; mensagem que chega continua gravada (spec §1.3)",
};

function rotasDeCron(): string[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(DIR_CRON, e.name, "route.ts")))
    .map((e) => e.name)
    .sort();
}

/** Todo especificador só de tipo equivale a `import type`: tipo não executa filtro nenhum. */
function soDeTipo(no: ts.ImportDeclaration): boolean {
  const clausula = no.importClause;
  if (!clausula) return false;
  if (clausula.isTypeOnly) return true;
  const nomeados = clausula.namedBindings;
  return (
    !clausula.name &&
    nomeados !== undefined &&
    ts.isNamedImports(nomeados) &&
    nomeados.elements.length > 0 &&
    nomeados.elements.every((el) => el.isTypeOnly)
  );
}

/** O módulo CHAMA um símbolo de filtro da régua, ou escreve `fn_org_operante(` num literal SQL. */
function usaAReguaNaFonte(fonte: string, nome: string): boolean {
  const arquivo = ts.createSourceFile(nome, fonte, ts.ScriptTarget.Latest, true);
  const nomesLocais = new Set<string>();
  for (const st of arquivo.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== MODULO_DA_REGUA || soDeTipo(st)) continue;
    const nomeados = st.importClause?.namedBindings;
    if (!nomeados || !ts.isNamedImports(nomeados)) continue;
    for (const el of nomeados.elements) {
      if (!el.isTypeOnly && SIMBOLOS_DE_FILTRO.has((el.propertyName ?? el.name).text)) nomesLocais.add(el.name.text);
    }
  }
  let usa = false;
  const visitar = (no: ts.Node): void => {
    if (usa || ts.isImportDeclaration(no)) return;
    if (ts.isIdentifier(no) && nomesLocais.has(no.text)) {
      usa = true;
      return;
    }
    if (
      (ts.isStringLiteral(no) ||
        ts.isNoSubstitutionTemplateLiteral(no) ||
        ts.isTemplateHead(no) ||
        ts.isTemplateMiddle(no) ||
        ts.isTemplateTail(no)) &&
      no.text.includes(FUNCAO_SQL_DA_REGUA)
    ) {
      usa = true;
      return;
    }
    ts.forEachChild(no, visitar);
  };
  visitar(arquivo);
  return usa;
}

function resolverNoDisco(especificador: string): string | null {
  const base = join(RAIZ, especificador.slice(2));
  for (const candidato of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidato)) return candidato;
  }
  return null;
}

type Ler = (caminho: string) => string;
type Resolver = (especificador: string) => string | null;

function importsDe(caminho: string, ler: Ler, resolver: Resolver): string[] {
  const arquivo = ts.createSourceFile(caminho, ler(caminho), ts.ScriptTarget.Latest, true);
  const saida: string[] = [];
  for (const st of arquivo.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (soDeTipo(st) || !st.moduleSpecifier.text.startsWith("@/")) continue;
    const alvo = resolver(st.moduleSpecifier.text);
    if (alvo && !NAO_E_FILTRO.has(alvo)) saida.push(alvo);
  }
  return saida;
}

/**
 * Busca em largura pelos imports `@/` a partir da rota, até PROFUNDIDADE_MAXIMA
 * saltos. Devolve a cadeia rota → … → módulo que usa o filtro, ou null.
 */
function caminhoAteOFiltro(entrada: string, ler: Ler, resolver: Resolver): string[] | null {
  const visitados = new Set([entrada]);
  let fronteira = [{ atual: entrada, cadeia: [entrada] }];
  for (let nivel = 0; nivel <= PROFUNDIDADE_MAXIMA && fronteira.length > 0; nivel++) {
    const proxima: typeof fronteira = [];
    for (const { atual, cadeia } of fronteira) {
      if (usaAReguaNaFonte(ler(atual), atual)) return cadeia;
      for (const alvo of importsDe(atual, ler, resolver)) {
        if (visitados.has(alvo)) continue;
        visitados.add(alvo);
        proxima.push({ atual: alvo, cadeia: [...cadeia, alvo] });
      }
    }
    fronteira = proxima;
  }
  return null;
}

const lerDoDisco: Ler = (caminho) => readFileSync(caminho, "utf8");

function rotaRespeita(rota: string): boolean {
  return caminhoAteOFiltro(join(DIR_CRON, rota, "route.ts"), lerDoDisco, resolverNoDisco) !== null;
}

describe("a sonda", () => {
  it("reconhece a chamada da régua e a função SQL (controles positivos)", () => {
    expect(usaAReguaNaFonte(`import { idsDeOrgsParadas } from "@/lib/organizacao/operante";\nawait idsDeOrgsParadas(admin);`, "a.ts")).toBe(true);
    expect(
      usaAReguaNaFonte("await pool.query(`select public.fn_org_operante($1) as operante`, [id]);", "b.ts"),
    ).toBe(true);
  });

  it("a porta de saída existe e é a que não conta como filtro (controle do NAO_E_FILTRO)", () => {
    for (const caminho of NAO_E_FILTRO) expect(existsSync(caminho), caminho).toBe(true);
  });

  it("importar a régua não basta: só USAR um símbolo de filtro conta (controles negativos)", () => {
    // Tratamento de recusa na saída não é filtro.
    expect(
      usaAReguaNaFonte(
        `import { OrgNaoOperanteError } from "@/lib/organizacao/operante";\nif (e instanceof OrgNaoOperanteError) x();`,
        "e.ts",
      ),
    ).toBe(false);
    expect(
      usaAReguaNaFonte(`import { assertOrgOperante } from "@/lib/organizacao/operante";\nawait assertOrgOperante(db, id);`, "f.ts"),
    ).toBe(false);
    // Importar o símbolo de filtro sem chamá-lo não filtra nada.
    expect(usaAReguaNaFonte(`import { ehOperante } from "@/lib/organizacao/operante";\nexport const x = 1;`, "g.ts")).toBe(false);
    // Todos os especificadores só de tipo equivalem a `import type`.
    expect(
      usaAReguaNaFonte(`import { type TipoDeSuspensao } from "@/lib/organizacao/operante";\nlet t: TipoDeSuspensao;`, "h.ts"),
    ).toBe(false);
  });

  it("usar um símbolo de filtro conta, inclusive com alias (controles positivos)", () => {
    expect(
      usaAReguaNaFonte(`import { ehOperante as op } from "@/lib/organizacao/operante";\nif (!op(s)) return;`, "i.ts"),
    ).toBe(true);
    expect(
      usaAReguaNaFonte(
        `import { type TipoDeSuspensao, idsDeOrgsParadas } from "@/lib/organizacao/operante";\nawait idsDeOrgsParadas(admin);`,
        "j.ts",
      ),
    ).toBe(true);
  });

  it("segue os imports @/ transitivamente até o módulo que usa o filtro (controles da árvore)", () => {
    const arvore = (folha: string, importDaRota = `import { a } from "@/lib/a";`): Record<string, string> => ({
      [join(RAIZ, "rota.ts")]: `${importDaRota}\na();`,
      [join(RAIZ, "lib", "a.ts")]: `import { b } from "@/lib/b";\nimport { rota } from "@/rota";\nexport const a = () => b();`,
      [join(RAIZ, "lib", "b.ts")]: folha,
    });
    const respeitaNa = (arquivos: Record<string, string>) =>
      caminhoAteOFiltro(
        join(RAIZ, "rota.ts"),
        (c) => arquivos[c] ?? "",
        (esp) => {
          const alvo = join(RAIZ, `${esp.slice(2)}.ts`);
          return alvo in arquivos ? alvo : null;
        },
      );
    const usaDoisNiveisAbaixo = `import { idsDeOrgsParadas } from "@/lib/organizacao/operante";\nexport const b = () => idsDeOrgsParadas(admin);`;
    expect(respeitaNa(arvore(usaDoisNiveisAbaixo))).toEqual([
      join(RAIZ, "rota.ts"),
      join(RAIZ, "lib", "a.ts"),
      join(RAIZ, "lib", "b.ts"),
    ]);
    const soAClasseDeErro = `import { OrgNaoOperanteError } from "@/lib/organizacao/operante";\nexport const b = () => { throw new OrgNaoOperanteError("o", null); };`;
    expect(respeitaNa(arvore(soAClasseDeErro))).toBeNull();
    // Import só de tipo não é aresta: tipo não executa o filtro de ninguém.
    expect(respeitaNa(arvore(usaDoisNiveisAbaixo, `import { type a } from "@/lib/a";`))).toBeNull();
  });

  it("não se engana com comentário nem com import só de tipo (controles negativos)", () => {
    expect(usaAReguaNaFonte("// não chama fn_org_operante( aqui\nexport const x = 1;", "c.ts")).toBe(false);
    expect(usaAReguaNaFonte(`import type { TipoDeSuspensao } from "@/lib/organizacao/operante";`, "d.ts")).toBe(false);
  });
});

describe("crons × organização parada", () => {
  const rotas = rotasDeCron();

  it("o diretório de crons foi lido (instrumento vivo)", () => {
    expect(rotas).toContain("event-log-drain");
    expect(rotas).toContain("kb-conversations-batch");
  });

  // A cerca vê o followup-flow-worker pela aresta silence-sweep → gate, e o gate filtra só
  // a varredura. O tick (claim) é filtrado no SQL: tests/invariants/followup-org-suspensa.test.ts.
  it("followup-flow-worker alcança a régua PELO silence-sweep → gate, e sem o filtro do gate fica vermelho", () => {
    const rota = join(DIR_CRON, "followup-flow-worker", "route.ts");
    const gate = join(RAIZ, "lib", "ai", "elegibilidade", "gate.ts");
    const envio = join(RAIZ, "lib", "followup", "enviar-texto-fixo.ts");
    // Sem a aresta do envio (que também chega ao gate), a varredura sozinha sustenta o verde.
    const semOEnvio: Ler = (c) => (c === envio ? "" : lerDoDisco(c));
    expect(caminhoAteOFiltro(rota, semOEnvio, resolverNoDisco)).toEqual([
      rota,
      join(RAIZ, "lib", "followup", "silence-sweep.ts"),
      gate,
    ]);
    // Sabotagem em memória: o gate deixa de chamar ehOperante (o import fica, sem uso). O envio
    // segue importando OrgNaoOperanteError — e isso, sozinho, não mantém a rota verde.
    expect(lerDoDisco(gate)).toContain("ehOperante(");
    expect(lerDoDisco(envio)).toContain("OrgNaoOperanteError");
    const gateSemFiltro: Ler = (c) => (c === gate ? lerDoDisco(c).replaceAll("ehOperante(", "Boolean(") : lerDoDisco(c));
    expect(caminhoAteOFiltro(rota, gateSemFiltro, resolverNoDisco)).toBeNull();
  });

  it.each(rotas)("%s usa a régua ou consta de SEM_FILTRO com motivo", (rota) => {
    expect(
      rotaRespeita(rota) || rota in SEM_FILTRO,
      `app/api/v1/cron/${rota} não filtra organização parada. Chame idsDeOrgsParadas/ehOperante ` +
        `de ${MODULO_DA_REGUA} (ou fn_org_operante no SQL) — ou, se ela não custa nem sai para fora, ` +
        "acrescente-a a SEM_FILTRO com o motivo.",
    ).toBe(true);
  });

  it("a lista só encolhe: toda entrada existe e ainda não usa a régua", () => {
    for (const rota of Object.keys(SEM_FILTRO)) {
      expect(existsSync(join(DIR_CRON, rota, "route.ts")), `${rota} não existe mais — tire de SEM_FILTRO`).toBe(true);
      expect(rotaRespeita(rota), `${rota} já usa a régua — tire de SEM_FILTRO`).toBe(false);
    }
  });

  it("todo motivo tem ao menos 20 caracteres", () => {
    for (const [rota, motivo] of Object.entries(SEM_FILTRO)) {
      expect(motivo.trim().length, `${rota}: motivo curto demais`).toBeGreaterThanOrEqual(20);
    }
  });

  it("a rota da cobrança não entra na lista — ela filtra pela régua (PR 3a)", () => {
    expect(Object.keys(SEM_FILTRO)).not.toContain("cobranca");
  });
});
