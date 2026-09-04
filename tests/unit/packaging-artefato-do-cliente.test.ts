import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O gate mecânico da doutrina de packaging (docs/doctrine/packaging.md).
 *
 * Existe porque a regra estava escrita e era falsa há dois meses: `CLAUDE.md`
 * afirmava que "o caminho normal não constrói nada na VPS", enquanto o serviço
 * `worker` do compose de produção não tinha `image:` — só `build:`. Ele era
 * construído na VPS de cada cliente pelo `up -d` do install, e NENHUM update.sh
 * jamais o reconstruía: `docker compose pull` pula serviço build-only ("Skipped
 * - No image to be pulled") e `up -d` sem `--build` recria o contêiner sobre a
 * imagem velha. O runtime do agente de IA — a feature-título do produto —
 * congelava no código do dia da instalação.
 *
 * Duas varreduras manuais e uma consultoria externa de packaging não pegaram
 * isso. Por isso a regra virou teste: prosa que nenhum gate lê é prosa que
 * diverge.
 *
 * ESCOPO: `docker-compose.prod.yml` — o compose que o self-hoster roda. O
 * `docker-compose.yml` (dev) e o `docker-compose.build.yml` (override de build
 * opcional) estão de fora de propósito: construir localmente é justamente o que
 * eles existem para fazer.
 */

const RAIZ = process.cwd();
const COMPOSE_PROD = path.join(RAIZ, "docker-compose.prod.yml");

const compose = fs.readFileSync(COMPOSE_PROD, "utf8");

/**
 * Parser deliberadamente pequeno: lê os blocos de serviço de 4 espaços de
 * indentação sob `services:`. Não é um parser de YAML — é o suficiente para
 * responder "este serviço declara image?" sem trazer uma dependência nova só
 * para um gate. Se o compose mudar de forma a ponto de isto errar, os testes
 * abaixo falham alto (nome de serviço faltando), não em silêncio.
 */
function lerServicos(yaml: string): Map<string, string> {
  const linhas = yaml.split("\n");
  const servicos = new Map<string, string>();
  let dentroDeServices = false;
  let atual: string | null = null;
  let buffer: string[] = [];

  const fechar = () => {
    if (atual) servicos.set(atual, buffer.join("\n"));
    atual = null;
    buffer = [];
  };

  for (const linha of linhas) {
    if (/^services:\s*$/.test(linha)) {
      dentroDeServices = true;
      continue;
    }
    if (!dentroDeServices) continue;
    // Qualquer chave de topo (coluna 0) encerra a seção de serviços.
    if (/^\S/.test(linha) && linha.trim() !== "") {
      fechar();
      dentroDeServices = false;
      continue;
    }
    const cabecalho = linha.match(/^ {2}([a-z0-9_-]+):\s*$/i);
    if (cabecalho) {
      fechar();
      atual = cabecalho[1] ?? null;
      continue;
    }
    if (atual) buffer.push(linha);
  }
  fechar();
  return servicos;
}

const servicos = lerServicos(compose);

/** Só as imagens que NÓS publicamos. Upstream tem regra própria, mais abaixo. */
const NOSSOS = ["app", "worker", "scheduler"] as const;

describe("packaging — o artefato que o cliente instala", () => {
  it("o parser enxerga os 7 serviços de produção", () => {
    // Guarda do próprio instrumento: se o parser parar de enxergar os serviços,
    // todos os testes abaixo passariam vazios — verde por não ter medido nada.
    expect([...servicos.keys()].sort()).toEqual(
      ["app", "caddy", "redis", "scheduler", "srh", "waha", "worker"].sort(),
    );
  });

  it.each(NOSSOS)("o serviço '%s' declara image: — nunca só build:", (nome) => {
    const bloco = servicos.get(nome);
    expect(bloco, `serviço '${nome}' sumiu do compose de produção`).toBeDefined();

    const temImage = /^\s{4}image:\s*\S/m.test(bloco!);
    expect(
      temImage,
      `'${nome}' não declara image:. Serviço build-only é pulado por 'docker compose pull' ` +
        `e imune a 'up -d' sem --build: ele é construído na VPS do cliente e NUNCA é ` +
        `atualizado. Publique a imagem e declare image: (o build: pode ficar ao lado, ` +
        `como escape). Ver docs/doctrine/packaging.md, invariante 1.`,
    ).toBe(true);
  });

  it("nenhum serviço de produção é build-only", () => {
    const buildOnly = [...servicos.entries()]
      .filter(([, bloco]) => /^\s{4}build:/m.test(bloco) && !/^\s{4}image:\s*\S/m.test(bloco))
      .map(([nome]) => nome);

    expect(
      buildOnly,
      `serviço(s) build-only em produção: ${buildOnly.join(", ")}. ` +
        `É o defeito do 'worker' voltando: build na VPS do cliente que nenhum update alcança.`,
    ).toEqual([]);
  });

  it("toda imagem upstream está pinada — nunca :latest nem tag implícita", () => {
    const soltas: string[] = [];

    for (const [nome, bloco] of servicos) {
      if ((NOSSOS as readonly string[]).includes(nome)) continue;
      const m = bloco.match(/^\s{4}image:\s*(\S+)/m);
      if (!m) continue;

      // Tira a interpolação ${VAR:-default} e fica com o default, que é o que
      // vale para quem não configurou nada — ou seja, para todo mundo.
      const ref = (m[1] ?? "").replace(/^\$\{[A-Z_]+:-(.+)\}$/, "$1");

      if (ref.includes("@sha256:")) continue; // pin por digest: o mais forte que existe

      const depoisDoHost = ref.split("/").pop() ?? "";
      const temTag = depoisDoHost.includes(":");
      const tag = temTag ? depoisDoHost.split(":").pop() : null;

      if (!temTag || tag === "latest") {
        soltas.push(`${nome} -> ${ref}`);
      }
    }

    expect(
      soltas,
      `imagem upstream sem pin: ${soltas.join(", ")}. Sem tag = ':latest', e o 'dc pull' do ` +
        `update.sh entrega ao cliente qualquer versão que o upstream tenha publicado, ` +
        `inclusive uma nunca testada por nós — no meio de uma atualização. ` +
        `Ver docs/doctrine/packaging.md, invariante 4.`,
    ).toEqual([]);
  });

  it("o pull_policy acompanha a mutabilidade da tag, nos dois sentidos", () => {
    // Medido, e é a razão de a regra existir: com pull_policy 'always' e o
    // registry sem responder para aquela referência, o `up -d` FALHA e o
    // contêiner não sobe — mesmo com a imagem já no disco. Com tag imutável isso
    // não protege de nada e só amarra a disponibilidade do CRM do cliente à do
    // GHCR. No sentido oposto, tag móvel com 'missing' puxa uma vez e congela:
    // é o defeito do worker voltando por outra porta.
    let avaliados = 0;

    for (const nome of NOSSOS) {
      const bloco = servicos.get(nome)!;
      const politica = bloco.match(/^\s{4}pull_policy:\s*(\S+)/m)?.[1];
      expect(politica, `'${nome}' não declara pull_policy`).toBeDefined();

      const defaultDaPolitica = politica!.replace(/^\$\{[A-Z_]+:-(.+)\}$/, "$1");
      const imagem = bloco.match(/^\s{4}image:\s*(\S+)/m)?.[1] ?? "";
      const tagDaImagem = imagem.replace(/^\$\{[A-Z_]+:-(.+)\}$/, "$1").split(":").pop();
      const tagEhMovel = ["latest", "main", "stable"].includes(tagDaImagem ?? "");
      avaliados += 1;

      const esperado = tagEhMovel ? "always" : "missing";
      expect(
        defaultDaPolitica,
        `'${nome}' aponta para a tag ${tagEhMovel ? "MÓVEL" : "IMUTÁVEL"} '${tagDaImagem}' ` +
          `com pull_policy '${defaultDaPolitica}'. Tag móvel usa 'always' (senão a versão ` +
          `nunca chega); tag imutável usa 'missing' (senão o CRM só sobe se o GHCR estiver ` +
          `de pé). Ver docs/doctrine/packaging.md, invariante 5.`,
      ).toBe(esperado);
    }

    // Guarda do instrumento: a primeira versão deste teste só cobrava o caso da
    // tag imutável e, como os três serviços apontam para tag móvel, ele passava
    // sem avaliar um único serviço — verde por não ter medido nada.
    expect(avaliados, "o teste de pull_policy não avaliou nenhum serviço").toBe(NOSSOS.length);
  });

  it("nenhum serviço nosso cai em `latest` quando o .env não tem a chave", () => {
    // Ponto cego que este teste tinha e uma sabotagem revelou: ele cobrava
    // "tag móvel usa always", e `latest` e `stable` são AMBOS móveis — trocar um
    // pelo outro passava verde. A distinção importa porque quem cai no default é
    // quem NÃO tem a chave no .env, e o caso real disso é uma instalação legada
    // atualizando: o update.sh antigo (o que está no disco dela) só grava
    // APP_IMAGE, então worker e scheduler pegam o default DESTE arquivo. Com
    // `latest` — que aqui é o topo da `main` — o parque rodaria o runtime do
    // agente de IA em código não lançado, pareado com um app de release.
    const proibidos: string[] = [];

    for (const nome of NOSSOS) {
      const bloco = servicos.get(nome)!;
      const imagem = bloco.match(/^\s{4}image:\s*(\S+)/m)?.[1] ?? "";
      const padrao = imagem.replace(/^\$\{[A-Z_]+:-(.+)\}$/, "$1");
      const tag = padrao.split(":").pop();
      if (tag === "latest" || tag === "main") proibidos.push(`${nome} -> ${padrao}`);
    }

    expect(
      proibidos,
      `default para canal de desenvolvimento: ${proibidos.join(", ")}. Em produção o mínimo é ` +
        `\`:stable\` (a última release). Ver docs/doctrine/packaging.md, invariante 3.`,
    ).toEqual([]);
  });

  it("cada Dockerfile publicado declara procedência OCI e ARG APP_VERSION", () => {
    // O CI injeta os labels via docker/metadata-action, mas o build local do
    // docker-compose.build.yml não passa por ele. Sem LABEL no arquivo, essa
    // imagem sai sem origem nenhuma — e é justamente a que vira dívida numa VPS.
    for (const arquivo of ["Dockerfile", "Dockerfile.worker", "Dockerfile.scheduler"]) {
      const conteudo = fs.readFileSync(path.join(RAIZ, arquivo), "utf8");
      expect(conteudo, `${arquivo} sem org.opencontainers.image.source`).toContain(
        "org.opencontainers.image.source",
      );
      expect(conteudo, `${arquivo} sem ARG APP_VERSION`).toMatch(/^ARG APP_VERSION/m);
    }
  });

  it("o workflow publica as três imagens e injeta APP_VERSION", () => {
    const wf = fs.readFileSync(path.join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
    for (const imagem of ["deskcommcrm", "deskcomm-worker", "deskcomm-scheduler"]) {
      expect(wf, `publish-image.yml não publica '${imagem}'`).toContain(`name: ${imagem}`);
    }
    expect(wf, "publish-image.yml não passa APP_VERSION como build-arg").toContain(
      "APP_VERSION=",
    );
    // A sonda prende o EFEITO (o canal `stable` passa a existir), não a forma.
    // Ela já mudou uma vez: `stable` saiu da lista de tags da matriz — onde cada
    // imagem o movia sozinha — para o job `promover-stable`, que só roda com as
    // três publicadas (issue #488). Prender `value=stable` fazia esta guarda
    // reprovar justamente o conserto.
    expect(wf, "publish-image.yml não cria o canal 'stable'").toMatch(/:stable\b/);
  });

  it("nenhum gatilho reconstrói uma tag já publicada", () => {
    // Medido na v1.3.0: com `release: types: [published]` ligado ao lado de
    // `push: tags`, `gh release create` disparou DOIS runs para o mesmo commit
    // (19:53 push, 19:58 release). O segundo moveu `1.3.0` e `1.3` para um build
    // novo e deixou `stable` no antigo — digests divergentes para o mesmo
    // `revision`, e uma tag de VERSÃO movida depois de publicada, que é
    // exatamente o que o invariante 3 da doutrina proíbe.
    //
    // Este teste guarda o COMPORTAMENTO (o que dispara um build que publica),
    // não a ausência de uma string: qualquer gatilho novo que re-publique sobre
    // uma tag existente reprova aqui, não só o `release`.
    const wf = fs.readFileSync(path.join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
    const gatilhos = wf.split(/^jobs:/m)[0] ?? "";
    const semComentarios = gatilhos
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

    for (const proibido of ["release:", "workflow_run:", "schedule:", "repository_dispatch:"]) {
      expect(
        semComentarios,
        `publish-image.yml reagiria a '${proibido}' — esse gatilho pode reconstruir e MOVER uma tag de versão já publicada`,
      ).not.toContain(proibido);
    }

    // E o gatilho que precisa existir continua existindo — sem esta linha o
    // teste passaria num workflow que não publica coisa nenhuma.
    expect(semComentarios, "publish-image.yml deixou de reagir a push de tag").toMatch(
      /tags:\s*\["?v\*/,
    );
  });
});

describe("packaging — a versão que roda é observável de fora", () => {
  it("o /api/v1/health lê APP_VERSION, e não npm_package_version", () => {
    // npm_package_version é `undefined` sob `CMD ["node","server.js"]` — só
    // existe quando o processo nasce de um `npm`/`pnpm run`. Com o fallback
    // "0.1.0" que havia antes, TODA instalação do mundo reportava a mesma
    // versão inventada, e o campo desligava a pergunta em vez de respondê-la.
    const rota = fs.readFileSync(path.join(RAIZ, "app/api/v1/health/route.ts"), "utf8");

    expect(rota, "o health voltou a ler npm_package_version").not.toMatch(
      /version:\s*process\.env\.npm_package_version/,
    );
    expect(rota, "o health não lê process.env.APP_VERSION").toMatch(
      /version:\s*process\.env\.APP_VERSION/,
    );
  });
});
