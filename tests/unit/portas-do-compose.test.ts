import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O QUE ESTA INSTALAÇÃO PUBLICA NA INTERNET — vigiado por máquina.
 *
 * ─── Por que este arquivo existe ─────────────────────────────────────────────
 *
 * O compose de produção sobe serviços que NÃO podem ser alcançados de fora, e a
 * única coisa que os protegia era ninguém ter escrito `ports:` no bloco errado.
 * Não havia gate nenhum: `git grep -nE "ports:" origin/main -- tests/ scripts/`
 * voltava VAZIO (controle positivo, na mesma varredura: `readFileSync.*docker-
 * compose` acha dois testes — logo a sonda enxergava o repo).
 *
 * O caso que forçou a régua foi a chamada de voz. A versão anterior daquele
 * serviço rodava um build cujo README dizia, textualmente: *"The API has no
 * authentication — anyone with HTTP access can create accounts, place calls,
 * and read history. Run it only on a trusted LAN."* Uma linha `ports:` num
 * arquivo YAML transformava isso em "qualquer um na internet pareia o WhatsApp
 * da empresa e lê o histórico de chamadas". O serviço hoje é o upstream
 * autenticado, o que é a defesa de verdade — mas a lição não é sobre um
 * serviço: é que a fronteira de rede do produto estava presa a ninguém errar
 * uma linha, e nada media isso.
 *
 * ─── As três formas de furar a fronteira, e por que as três estão aqui ───────
 *
 * `ports:` publica no host; `network_mode: host` dispensa o mapeamento e expõe
 * TUDO que o processo escutar (uma guarda só sobre `ports:` daria a sensação de
 * classe fechada com a porta dos fundos aberta — o erro que a varredura de
 * controle decorativo já pagou); e uma label `traefik.enable` fora do `app`
 * publica pelo proxy da hospedagem, sem passar por porta nenhuma.
 *
 * ─── ESCOPO ──────────────────────────────────────────────────────────────────
 *
 * `docker-compose.prod.yml` e `docker-compose.traefik.yml` — os que rodam na
 * VPS do cliente. O `docker-compose.yml` (dev) está FORA de propósito: publicar
 * portas na máquina de quem desenvolve é justamente o que ele existe para
 * fazer.
 */

const RAIZ = process.cwd();

/** Os únicos serviços que podem publicar porta TCP: são o proxy reverso. */
const PROXY = ["caddy"] as const;

/**
 * Serviço que pode publicar porta **UDP**, e só UDP — a exceção tem um nome e
 * uma razão, senão vira allowlist muda.
 *
 * O áudio do WebRTC não fala HTTP. O Caddy é L7 e não repassa UDP, então não há
 * proxy que carregue a mídia: ou a porta é publicada, ou o som não sai da
 * máquina. É o único caso do produto em que isso vale.
 *
 * O que esta exceção NÃO abre: a interface HTTP de administração do serviço
 * continua só na rede interna, alcançável apenas pelo `app` e pelo `worker`.
 * Por isso a regra abaixo exige `/udp` em TODA linha e reprova qualquer TCP —
 * uma linha `"8080:8080"` colada ao lado, por hábito, exporia o painel do
 * serviço à internet, e foi exatamente esse o risco que este arquivo nasceu
 * para vigiar.
 */
const PODE_PUBLICAR_UDP = ["wacalls"] as const;

/**
 * Serviço que pode ganhar label de roteamento. Só o `app` — é o único com uma
 * superfície HTTP feita para o público.
 */
const ROTEAVEL = ["app"] as const;

/**
 * Parser dos blocos de serviço, no molde de
 * `tests/unit/packaging-artefato-do-cliente.test.ts`. Não é um parser de YAML:
 * é o suficiente para responder "este serviço declara X?" sem trazer uma
 * dependência nova para um gate.
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

/**
 * O compose CITA portas em comentário para explicá-las ("porta interna 3000",
 * "7881:7881/udp"). Sem esta limpeza o regex acusaria a prosa — e um gate que
 * acusa o inocente é desligado por quem o herdar.
 */
function semComentarios(bloco: string): string {
  return bloco
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

const ARQUIVOS = ["docker-compose.prod.yml", "docker-compose.traefik.yml"] as const;

const SERVICOS = new Map<string, Map<string, string>>(
  ARQUIVOS.map((f) => [f, lerServicos(fs.readFileSync(path.join(RAIZ, f), "utf8"))]),
);

describe("a fronteira de rede do que o cliente instala", () => {
  it("o parser enxerga os serviços dos dois compose", () => {
    // GUARDA DO INSTRUMENTO. Sem esta asserção, um parser quebrado deixaria
    // todos os casos abaixo verdes por não terem medido nada — que é a forma
    // mais silenciosa de um gate morrer.
    expect([...SERVICOS.get("docker-compose.prod.yml")!.keys()].sort()).toEqual(
      ["app", "caddy", "redis", "scheduler", "srh", "wacalls", "waha", "worker"].sort(),
    );
    // O override do proxy externo declara um subconjunto (só o que ele muda).
    const traefik = [...SERVICOS.get("docker-compose.traefik.yml")!.keys()];
    expect(traefik, "o override do Traefik parou de declarar serviços").toContain("app");
    expect(traefik).toContain("caddy");
  });

  it("só o proxy reverso publica porta no host", () => {
    const publicando: string[] = [];

    for (const [arquivo, servicos] of SERVICOS) {
      for (const [nome, bloco] of servicos) {
        if ((PROXY as readonly string[]).includes(nome)) continue;
        const limpo = semComentarios(bloco);
        // `ports:` na indentação do serviço (4 espaços). A forma longa
        // (`- target: 8080`) mora sob a mesma chave, então basta achar a chave.
        if (!/^\s{4}ports:/m.test(limpo)) continue;

        if ((PODE_PUBLICAR_UDP as readonly string[]).includes(nome)) {
          // A exceção não é "pode publicar": é "pode publicar UDP". Cada linha
          // da lista precisa terminar em `/udp`, e o mapeamento precisa ser
          // host == contêiner — o número entra no candidato SDP que o navegador
          // recebe, e um remap faria a mídia ir para uma porta que o host não
          // escuta, com tudo parecendo certo nos logs.
          // Só as linhas DENTRO do bloco `ports:` — sem este recorte o parser
          // pegava `- wacalls-data:/data` do `volumes:` e acusava o volume de
          // não ser UDP. E `${VAR:-7881}` precisa virar `7881` antes da
          // comparação, senão host e contêiner nunca batem por causa do `:-`.
          const trecho = /^\s{4}ports:\s*$\n((?:\s{6}-.*\n)+)/m.exec(limpo)?.[1] ?? "";
          const linhas = [...trecho.matchAll(/^\s{6}-\s*"?([^"\n]+)"?\s*$/gm)]
            .map((m) => m[1]!.trim())
            .map((l) => l.replace(/\$\{[^}]*:-([^}]*)\}/g, "$1"));
          for (const linha of linhas) {
            if (!linha.endsWith("/udp")) {
              publicando.push(`${arquivo} → ${nome}: "${linha}" não é /udp`);
              continue;
            }
            const [host, resto] = linha.split(":");
            const contentor = (resto ?? "").replace("/udp", "");
            if (host !== contentor) {
              publicando.push(`${arquivo} → ${nome}: "${linha}" remapeia (host ≠ contêiner)`);
            }
          }
          continue;
        }

        publicando.push(`${arquivo} → ${nome}`);
      }
    }

    expect(
      publicando,
      `serviço publicando porta no host: ${publicando.join(", ")}.\n` +
        `Só o proxy reverso (${PROXY.join(", ")}) pode. Todo o resto — transporte de\n` +
        `mensagens, chamada de voz, Redis, o próprio app — é alcançável apenas pela rede\n` +
        `interna do compose; publicar uma porta entrega esse serviço à internet do dia\n` +
        `para a noite, e nenhum deles foi desenhado para receber tráfego de fora.\n` +
        `Se um serviço precisar MESMO de UDP (mídia WebRTC), publique só o UDP e ponha\n` +
        `o motivo aqui, com o nome do serviço — nunca o TCP da API.`,
    ).toEqual([]);
  });

  it("nenhum serviço usa network_mode: host", () => {
    // A porta dos fundos da regra acima: sem `ports:` nenhum, `network_mode:
    // host` expõe TUDO que o processo escutar, e o teste anterior fica verde.
    const emHost: string[] = [];

    for (const [arquivo, servicos] of SERVICOS) {
      for (const [nome, bloco] of servicos) {
        if (/^\s{4}network_mode:\s*["']?host/m.test(semComentarios(bloco))) {
          emHost.push(`${arquivo} → ${nome}`);
        }
      }
    }

    expect(
      emHost,
      `serviço em network_mode: host: ${emHost.join(", ")}. Ele dispensa o mapeamento de\n` +
        `portas e expõe no host TUDO que o processo escutar — inclusive o que ninguém\n` +
        `lembrou de listar. É a mesma exposição do caso acima, por uma porta que aquele\n` +
        `teste não olha.`,
    ).toEqual([]);
  });

  it("só o app recebe label de roteamento do proxy externo", () => {
    const roteados: string[] = [];

    for (const [arquivo, servicos] of SERVICOS) {
      for (const [nome, bloco] of servicos) {
        if ((ROTEAVEL as readonly string[]).includes(nome)) continue;
        if (/traefik\.enable/.test(semComentarios(bloco))) {
          roteados.push(`${arquivo} → ${nome}`);
        }
      }
    }

    expect(
      roteados,
      `serviço com label de roteamento: ${roteados.join(", ")}. O Traefik da hospedagem\n` +
        `publica por LABEL, sem porta nenhuma — é exposição à internet que o teste de\n` +
        `\`ports:\` não enxerga. Só o \`app\` tem superfície feita para o público.`,
    ).toEqual([]);
  });

  it("o serviço de chamada de voz nasce num profile desligado", () => {
    // Não é sobre porta, e é a razão de o serviço ser seguro por padrão: sem
    // profile ativo o compose NEM CRIA o contêiner. Medido com o compose
    // v2.38.2 — `config --services` sem COMPOSE_PROFILES não lista `wacalls`;
    // com `COMPOSE_PROFILES=voz`, lista.
    //
    // Sem esta asserção, alguém que apagasse a linha `profiles:` passaria nos
    // quatro casos acima (o serviço continua sem `ports:`) e teria devolvido ao
    // parque um contêiner a mais em toda instalação, ligado por padrão.
    const bloco = SERVICOS.get("docker-compose.prod.yml")!.get("wacalls");
    expect(bloco, "o serviço 'wacalls' sumiu do compose de produção").toBeDefined();
    expect(
      semComentarios(bloco!),
      `'wacalls' perdeu o \`profiles:\`. Sem ele o serviço sobe em TODA instalação — e a\n` +
        `chamada de voz vincula um segundo aparelho ao número que já atende, com risco de\n` +
        `bloqueio da CONTA. Ninguém ganha essa capacidade por atualizar.`,
    ).toMatch(/^\s{4}profiles:\s*\[?["']?voz/m);
  });

  it("app e worker não dependem de um serviço que vive em profile", () => {
    // Armadilha medida do Compose: `depends_on` de um serviço cujo profile está
    // inativo impede o dependente de subir. Um `depends_on: wacalls` no `app`
    // não quebraria a chamada de voz — quebraria o CRM INTEIRO de toda
    // instalação que não a usa, e o sintoma não aponta para a voz.
    const servicos = SERVICOS.get("docker-compose.prod.yml")!;
    const emProfile = [...servicos.entries()]
      .filter(([, b]) => /^\s{4}profiles:/m.test(semComentarios(b)))
      .map(([nome]) => nome);

    expect(emProfile, "nenhum serviço em profile — a régua deste caso está vazia").toContain(
      "wacalls",
    );

    const quebrados: string[] = [];
    for (const [nome, bloco] of servicos) {
      if (emProfile.includes(nome)) continue;
      const limpo = semComentarios(bloco);
      const dependeDe = limpo.match(/^\s{4}depends_on:[\s\S]*?(?=^\s{4}\S|\s*$)/m)?.[0] ?? "";
      for (const alvo of emProfile) {
        if (new RegExp(`^\\s+${alvo}:`, "m").test(dependeDe)) {
          quebrados.push(`${nome} → ${alvo}`);
        }
      }
    }

    expect(
      quebrados,
      `depends_on apontando para serviço em profile: ${quebrados.join(", ")}. Com o profile\n` +
        `inativo o dependente NÃO SOBE — e o dependente aqui é o produto inteiro.`,
    ).toEqual([]);
  });
});
