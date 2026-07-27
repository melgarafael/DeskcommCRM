/**
 * Nenhum documento versionado aponta para imagem que o repositório não entrega.
 *
 * Regra: **imagem citada num documento é lastro de afirmação; imagem não citada é
 * artefato de build.** A primeira entra no repositório, a segunda fica fora — num
 * projeto aberto `git` não esquece, e todo clone pagaria para sempre o peso de
 * imagem que ninguém cita.
 *
 * É um check que **DECIDE**, não que relata. E ele já pegou, nesta ordem: seis
 * referências mortas do handoff; depois quatro documentos inteiros, quando parou
 * de casar só `evidence/*.png`; e depois os quatro buracos abaixo, achados pelo
 * `@MaestroConexoes` numa revisão pedida.
 *
 * > *"Todo guarda novo começa com a cobertura que o autor enxergava no momento, e
 * > o teste do dia seguinte é sempre 'o que EU não estava olhando quando escrevi
 * > isto'."*
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** Subpastas reais de `evidence/` — o discriminador do caminho relativo. */
const SUBPASTAS = new Set(
  fs
    .readdirSync(path.join(RAIZ, "evidence"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name),
);

/** Tudo que o git ENTREGA — não o que o disco tem. */
function versionados(padrao: string): string[] {
  return execFileSync("git", ["ls-files", padrao], { cwd: RAIZ, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/**
 * Extensões que valem como prova. `.png` sozinho deixaria passar gravação de tela
 * (`gif`/`webm`), que o `§7` pede no cenário 23.
 */
const EXT = /\.(?:png|jpe?g|gif|webp|webm|svg)$/i;

/**
 * O texto sem os blocos de código cercados.
 *
 * Achado do `@MaestroConexoes`: o extrator anterior casava QUALQUER token
 * terminado em extensão de imagem, em qualquer lugar — e por isso contava como
 * "referência morta" pedaço de URL (`3030/api/files/abc.jpg`), rota em exemplo
 * (`/api/files/gone.jpg`), chave de storage (`org1/conv1/msg1.jpg`) e até
 * **elisão**, com os três pontos do texto virando caminho.
 *
 * **Ele não distinguia CITAÇÃO de MENÇÃO** — a mesma família do guard que travou
 * o time ao ler a palavra proibida dentro do texto de uma mensagem: instrumento
 * que casa por substring não separa *usar* de *mencionar*.
 */
function semCodigo(texto: string): string {
  return texto.replace(/```[\s\S]*?```/g, "");
}

/**
 * Só o que é SINTATICAMENTE citação: `![alt](caminho)`, `[texto](caminho)` ou
 * caminho entre crases. URL é descartada — quem cita prova aponta para arquivo do
 * repositório, não para host.
 */
function referenciasBrutas(texto: string): string[] {
  const limpo = semCodigo(texto);
  const achados: string[] = [];
  // Sintaxe de link/imagem: a intenção de CITAR é explícita, então vale para
  // qualquer caminho.
  for (const m of limpo.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) achados.push(m[1]!);

  // Crase é AMBÍGUA NA ORIGEM: o time a usa para citar prova E para escrever
  // exemplo literal. Documentar os quatro ruídos deste extrator (`/api/files/gone.jpg`
  // e companhia) fez o próprio handoff "citar" quatro provas inexistentes —
  // documentar o falso positivo CRIOU falso positivo.
  //
  // Nenhum ajuste de regex resolve enquanto os dois usos forem indistinguíveis,
  // então o sinal ambíguo é trocado por um inequívoco: em crase, só conta o que
  // mora em `evidence/`. Medido pelo @MaestroConexoes antes de propor — TODAS as
  // citações reais dos documentos desta entrega vivem lá, sem exceção.
  //
  // Ganho de brinde: exemplo de caminho ruim pode ser escrito à vontade em
  // qualquer documento sem contaminar o check. E documentar ruído virou parte do
  // handoff.
  for (const m of limpo.matchAll(/`([^`\n]+)`/g)) {
    const r = m[1]!;
    // O discriminador NÃO é o prefixo `evidence/` — é a presença de CAMINHO.
    // Nome puro (`wave-1-card.png`) é nome de arquivo: as narrativas e os
    // handoffs citam assim. Caminho escrito (`org1/conv1/msg1.jpg`,
    // `/api/files/gone.jpg`) é exemplo, e foram exatamente esses quatro que
    // fizeram o handoff "citar" provas inexistentes ao documentá-los.
    //
    // Exigir o prefixo derrubaria a cobertura dos documentos desta entrega, que
    // citam por nome puro — trocaria capturar demais por capturar de menos.
    // Terceira forma: caminho relativo para SUBPASTA real de `evidence/`.
    // `evidence/wave3-pulso/` nasceu nesta wave, e sem esta linha uma citação
    // como `wave3-pulso/pulso-claro-2-durante.png` teria barra, não começaria
    // com `evidence/`, e o guarda a trataria como MENÇÃO — ignorando em
    // silêncio. Prova em subpasta era o único lugar onde a citação podia morrer
    // sem ninguém ver.
    //
    // O primeiro segmento tem que ser subpasta REAL: é o que separa
    // `wave3-pulso/x.png` de `org1/conv1/msg1.jpg`, que estruturalmente são
    // idênticos.
    if (r.startsWith("evidence/") || !r.includes("/") || SUBPASTAS.has(r.split("/")[0]!))
      achados.push(r);
  }
  return achados.filter(
    (r) =>
      EXT.test(r) &&
      !r.includes("://") &&
      // Nem template nem glob: `evidence/wave-<n>-<cenario>.png` e
      // `.../onda1-*.png` nomeiam um PADRÃO, não um arquivo. Citação de padrão
      // não é citação de prova — é o achado do @MaestroConexoes um nível mais
      // fundo: o extrator já lia sintaxe, e ainda assim tratava `<n>` e `*`
      // como nome literal.
      !/[<>*?{}]/.test(r),
  );
}

const DOCS = versionados("*.md").filter(
  (d) => referenciasBrutas(fs.readFileSync(path.join(RAIZ, d), "utf8")).length > 0,
);


/**
 * DÍVIDA PRÉ-EXISTENTE, enumerada — não escondida.
 *
 * Ao passar a descobrir os documentos em vez de listá-los, o check revelou que a
 * doença é do REPOSITÓRIO, não desta entrega: 15 documentos de outras épicas
 * citam evidência que nunca foi versionada. Nenhum deles é do CRM Vivo — o único
 * que era (`HANDOFF-wave1-devvivo.md`) citava três imagens pelos nomes errados,
 * sem o prefixo `devvivo-`, e foi corrigido.
 *
 * Publicar o portão duro contra todos quebraria a suíte de todo mundo por dívida
 * que não é de quem está entregando. Excluí-los em silêncio seria a lista
 * arbitrária que esta wave já reprovou. A saída é **quarentena enumerada**: o
 * portão fica duro para tudo o que nasce daqui em diante, e o passivo fica
 * VISÍVEL e CONTÁVEL.
 *
 * E ela NÃO APODRECE: o teste abaixo exige que documento em quarentena AINDA
 * tenha referência morta. Consertou? Sai da lista, ou o vermelho aparece. Lista
 * de exceção que ninguém revisa vira permissão permanente — esta se cobra
 * sozinha.
 */
const LEGADO = new Set([
  "docs/handoffs/HANDOFF-inbox-multimodal.md",
  "HANDOFF-operacao-visivel.md",
  "HANDOFF.md",
  "docs/superpowers/plans/2026-07-21-onda0-fundacao-midia.md",
  "docs/superpowers/plans/2026-07-24-harness-fase2-skills.md",
  "loop/checkpoints/G2-report.md",
  "loop/checkpoints/G4-report.md",
  "loop/checkpoints/G5-report.md",
]);

/**
 * Referências normalizadas para o caminho do repositório.
 *
 * **Só normaliza quem NÃO tem diretório próprio.** A versão anterior jogava toda
 * referência sem prefixo para `evidence/<basename>` — inofensivo enquanto a lista
 * era curta, e uma máquina de falso positivo assim que ela crescesse: há
 * documentos citando imagens que vivem fora de `evidence/`, e o teste as
 * reescreveria, não as acharia, e reprovaria documentos corretos **por um caminho
 * que ele mesmo inventou**. Reprovar por motivo errado é tão ruim quanto passar
 * por motivo errado.
 */
function refsNormalizadas(doc: string): string[] {
  const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");
  const dir = path.posix.dirname(doc);
  const refs = referenciasBrutas(texto);
  return [
    ...new Set(
      refs.map((ref) => {
        const limpa = ref.replace(/^\.\//, "");
        // `docs/handoffs/` conta como raiz: são handoffs ARQUIVADOS que nasceram
        // na raiz do repo e citam evidência sem prefixo, como todo doc de raiz.
        // Arquivar o documento não move as imagens — elas seguem em `evidence/`.
        // Sem este caso o guarda procuraria as imagens dentro de `docs/handoffs/`
        // e reprovaria documento correto por um caminho que ele mesmo inventou —
        // exatamente o defeito que o comentário acima já mandou não repetir.
        const base = dir === "." || dir === "docs/handoffs" ? "evidence" : dir;
        // Sem diretório → resolve contra a pasta do documento.
        if (!limpa.includes("/")) return path.posix.join(base, limpa);
        // Subpasta REAL de evidence/ → também resolve. Aceitar a referência sem
        // normalizá-la deixaria `wave3-pulso/x.png` procurando na raiz do repo:
        // o guarda aceitaria a citação e depois não acharia o arquivo — mudei um
        // lado e o outro não acompanhou, que é o defeito desta wave inteira.
        if (SUBPASTAS.has(limpa.split("/")[0]!)) return path.posix.join("evidence", limpa);
        // Caminho próprio (fora de evidence/): respeita como está.
        return limpa;
      }),
    ),
  ];
}

describe("evidência citada", () => {
  it("a quarentena não guarda documento que saiu da cobertura", () => {
    // O anti-apodrecimento só dispara para documento que o teste ALCANÇA. Se um
    // item da quarentena deixa de ter citação nenhuma (ou some do repo), ele
    // nunca mais é verificado e a exceção fica lá para sempre — apodrecendo pelo
    // outro lado. Foi o que aconteceu ao corrigir o extrator: sete itens viraram
    // peso morto porque o que os segurava era artefato de medição.
    const fantasmas = [...LEGADO].filter((d) => !DOCS.includes(d));
    expect(
      fantasmas,
      `estes estão em LEGADO e não são mais alcançados pelo teste — REMOVA-OS:\n` +
        fantasmas.map((f) => `  ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("nenhuma imagem versionada fica sem documento que a justifique", () => {
    // O SEGUNDO LADO DA REGRA. Achado 7 do @MaestroConexoes: o guarda cobrava
    // "citada → versionada" e não o inverso, embora a regra tenha os dois lados
    // ("imagem citada é lastro; imagem não citada é artefato de build").
    //
    // Sem esta asserção, imagem podia entrar antes do documento que a justifica
    // e ficar lá para sempre — corroendo por dentro o argumento de peso que
    // sustentou a decisão de manter o `evidence/` inteiro fora do repositório.
    const citadas = new Set(DOCS.flatMap((d) => refsNormalizadas(d)));
    const orfas = versionados("evidence/")
      .filter((f) => EXT.test(f))
      .filter((f) => !citadas.has(f));
    expect(
      orfas,
      "estas imagens estão versionadas e nenhum documento as cita — ou cite, ou não versione:\n" +
        orfas.map((o) => `  ${o}`).join("\n"),
    ).toEqual([]);
  });

  it("a descoberta de documentos não pode vir vazia", () => {
    // Sem esta guarda, um erro no `git ls-files` ou no filtro faria a suíte
    // inteira passar sem verificar nada — verde vácuo no nível do arquivo.
    expect(DOCS.length, "nenhum documento versionado citando imagem foi encontrado").toBeGreaterThan(
      0,
    );
  });

  for (const doc of DOCS) {
    it(`${doc} não cita imagem fora do versionamento`, () => {
      // Documento da lista que não existe é erro da LISTA, e alguém precisa
      // saber. A versão anterior fazia `return` em silêncio: renomear um handoff
      // evaporava a cobertura dele sem nada ficar vermelho.
      const caminho = path.join(RAIZ, doc);
      expect(fs.existsSync(caminho), `${doc} está em git ls-files e não existe no disco`).toBe(true);

      const entregues = new Set(versionados("."));
      const mortas = refsNormalizadas(doc).filter((ref) => !entregues.has(ref));

      if (LEGADO.has(doc)) {
        // Quarentena auto-limpante: se este documento ficou limpo, ele PRECISA
        // sair da lista — senão a exceção sobrevive ao motivo que a criou.
        expect(
          mortas.length,
          `${doc} está em LEGADO e já não tem referência morta — REMOVA-O da lista`,
        ).toBeGreaterThan(0);
        return;
      }

      expect(
        mortas,
        `${doc} aponta para arquivo que não está em git ls-files — quem clonar acha o vazio:\n` +
          mortas.map((m) => `  ${m}`).join("\n"),
      ).toEqual([]);
    });
  }
});
