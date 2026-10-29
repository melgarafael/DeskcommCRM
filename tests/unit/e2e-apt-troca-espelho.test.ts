/**
 * APT lento não fica rápido repetindo a mesma fonte. Executa os passos reais
 * do workflow; o apt-get dublê lê a fonte e só instala pelo arquivo Ubuntu.
 * Nenhum sudo, apt ou diretório /etc da máquina de teste é alcançado.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const WORKFLOW = path.join(RAIZ, ".github/workflows/e2e.yml");
const BROWSER = "Instalar o browser";
const FFMPEG = "Instalar o ffmpeg e sondar os encoders";
const AZURE = "http://azure.archive.ubuntu.com/ubuntu/";
const CANONICAL = "http://archive.ubuntu.com/ubuntu/";
const NORMALIZAR = "normalizar-fonte";
const DEB822 = `Types: deb\nURIs: ${AZURE}\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nSnapshot: 20261023T120000Z\n`;

function scriptDoPasso(nome: string): string {
  const linhas = readFileSync(WORKFLOW, "utf-8").split("\n");
  const inicio = linhas.findIndex((linha) => linha.includes(`- name: ${nome}`));
  if (inicio < 0) throw new Error(`Passo ausente: ${nome}`);
  const run = linhas.findIndex((linha, i) => i > inicio && /^\s+run: \|\s*$/.test(linha));
  const corpo: string[] = [];
  for (const linha of linhas.slice(run + 1)) {
    if (linha.trim() !== "" && !linha.startsWith(" ".repeat(10))) break;
    corpo.push(linha.slice(10));
  }
  return corpo.join("\n");
}

const temporarios: string[] = [];
afterEach(() => {
  for (const dir of temporarios.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rodar(passo: string, cenario = "azure_parado", fonte = DEB822, legado = false, ambiente = "github-hosted") {
  const raiz = mkdtempSync(path.join(tmpdir(), "e2e-apt-failover-"));
  temporarios.push(raiz);
  const bin = path.join(raiz, "bin");
  const apt = path.join(raiz, "apt");
  mkdirSync(bin);
  mkdirSync(path.join(apt, "sources.list.d"), { recursive: true });
  mkdirSync(path.join(apt, "preferences.d"));
  const arquivo = path.join(apt, legado ? "sources.list" : "sources.list.d/ubuntu.sources");
  writeFileSync(arquivo, fonte);
  writeFileSync(path.join(apt, "apt-mirrors.txt"), `${AZURE}\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n`);
  const pin = path.join(apt, "preferences.d/pino");
  writeFileSync(pin, "Package: *\nPin: release n=noble\nPin-Priority: 500\n");
  const pinAntes = { texto: readFileSync(pin, "utf-8"), mtime: statSync(pin).mtimeMs };
  const mtimeAntes = statSync(arquivo).mtimeMs;
  const log = path.join(raiz, "chamadas.log");
  writeFileSync(log, "");
  const executavel = (nome: string, corpo: string, interpretador = "/bin/sh") => {
    const arquivo = path.join(bin, nome);
    writeFileSync(arquivo, `#!${interpretador}\n${corpo}\n`);
    chmodSync(arquivo, 0o755);
  };
  executavel("timeout", 'echo "timeout $*" >> "$TEST_LOG"\nshift 3\nexec "$@"');
  executavel("sudo", `echo "sudo $*" >> "$TEST_LOG"
case "$1" in
  apt-get) exec "$@" ;;
  python3) shift; test "$1" = -; shift; test "$1" = /etc/apt; exec python3 - "$TEST_APT" ;;
  pkill|dpkg) exit 0 ;;
  *) echo "sudo não autorizado no teste: $1" >&2; exit 99 ;;
esac`);
  executavel("pnpm", `echo "pnpm $*" >> "$TEST_LOG"
sudo apt-get update -q || exit "$?"
sudo apt-get install -y browser-deps || exit "$?"
if [ "$TEST_SCENARIO" = browser_cdn_parado ]; then
  echo 'Downloading Chrome for Testing from https://cdn.playwright.dev/chrome.zip'
  exit 124
fi`);
  executavel("apt-get", `import os, pathlib, re, sys
root = pathlib.Path(os.environ["TEST_APT"])
text = pathlib.Path(os.environ["TEST_SOURCE"]).read_text()
m = re.search(r"^URIs:\\s*(\\S+)", text, re.M)
if not m:
    m = re.search(r"^deb(?:-src)?\\s+(?:\\[[^\\]]*\\]\\s+)?(\\S+)", text, re.M)
uri = m.group(1) if m else "desconhecida"
if uri == "mirror+file:/etc/apt/apt-mirrors.txt":
    uri = (root / "apt-mirrors.txt").read_text().split()[0]
with open(os.environ["TEST_LOG"], "a") as log:
    log.write("apt-get " + " ".join(sys.argv[1:]) + " | " + uri + "\\n")
print("Get:1 " + uri + " noble InRelease", flush=True)
scenario = os.environ["TEST_SCENARIO"]
fatal = {"assinatura": "NO_PUBKEY chave-inexistente", "hash": "Hash Sum mismatch", "pacote": "Unable to locate package ausente", "dpkg": "dpkg: error processing package quebrado (--unpack)"}
if scenario in fatal:
    if scenario in ("assinatura", "hash"):
        print("E: Failed to fetch " + uri + "pool/pacote.deb", flush=True)
    print("E: " + fatal[scenario], flush=True)
    sys.exit(100)
if scenario == "todos_parados" or (scenario not in ("saudavel", "browser_cdn_parado") and "azure.archive.ubuntu.com" in uri):
    sys.exit(124)
if scenario == "indice_invalido" and "update" in sys.argv:
    print("E: The repository is not signed.", flush=True)
    sys.exit(100)
if sys.argv[-1] == "ffmpeg":
    output = pathlib.Path(os.environ["TEST_BIN"]) / "ffmpeg"
    output.write_text('#!/bin/sh\\necho " A..... aac AAC"\\necho " A..... libopus Opus"\\n')
    output.chmod(0o755)
`, "/usr/bin/env python3");
  const script = passo === NORMALIZAR ? "source scripts/ci/apt-e2e-failover.sh; trocar_espelho_apt_e2e" : scriptDoPasso(passo);
  const resultado = spawnSync("bash", ["-e", "-c", script], {
    cwd: RAIZ,
    env: {
      ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: raiz,
      GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: ambiente, TEST_LOG: log, TEST_APT: apt,
      TEST_SOURCE: arquivo, TEST_SCENARIO: cenario, TEST_BIN: bin,
    },
    encoding: "utf-8",
    timeout: 10_000,
  });
  return {
    status: resultado.status, saida: resultado.stdout + resultado.stderr,
    chamadas: readFileSync(log, "utf-8").trim().split("\n"),
    fonte: readFileSync(arquivo, "utf-8"), mtime: statSync(arquivo).mtimeMs, mtimeAntes,
    pin: { texto: readFileSync(pin, "utf-8"), mtime: statSync(pin).mtimeMs }, pinAntes,
  };
}

describe("APT do E2E abandona a fonte Azure que não termina", () => {
  for (const passo of [BROWSER, FFMPEG]) {
    it(`${passo}: Azure para, o arquivo oficial instala, sem renovar o orçamento`, () => {
      const r = rodar(passo);
      expect(r.status, r.saida).toBe(0);
      expect(r.fonte).toBe(DEB822.replace(AZURE, CANONICAL));
      expect(r.pin).toEqual(r.pinAntes);
      expect(r.chamadas.filter((linha) => linha.startsWith("timeout"))).toHaveLength(2);
      for (const chamada of r.chamadas.filter((linha) => linha.startsWith("timeout"))) {
        expect(chamada).toMatch(/^timeout -k 20 180 /);
      }
      const indice = r.chamadas.findIndex((linha) => linha.startsWith("apt-get update") && linha.includes(CANONICAL));
      const instala = r.chamadas.findIndex((linha) => linha.startsWith("apt-get install") && linha.includes(CANONICAL));
      expect(indice).toBeGreaterThan(-1);
      expect(instala).toBeGreaterThan(indice);
      expect(r.chamadas[indice]).toContain("--error-on=any");
    });
  }

  it("alcança a lista local que o runner oficial usa, sem reescrever sua confiança", () => {
    const fonte = DEB822.replace(AZURE, "mirror+file:/etc/apt/apt-mirrors.txt");
    const r = rodar(FFMPEG, "azure_parado", fonte);
    expect(r.status, r.saida).toBe(0);
    expect(r.fonte).toBe(DEB822.replace(AZURE, "https://archive.ubuntu.com/ubuntu/"));
  });

  it("preserva as opções, suite e comentário de uma linha deb legada", () => {
    const fonte = `deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${AZURE} noble main # manter\n`;
    const r = rodar(FFMPEG, "azure_parado", fonte, true);
    expect(r.status, r.saida).toBe(0);
    expect(r.fonte).toBe(fonte.replace(AZURE, CANONICAL));
  });

  it("arquivo oficial também parado permanece vermelho após três tentativas limitadas", () => {
    const r = rodar(FFMPEG, "todos_parados");
    expect(r.status, r.saida).not.toBe(0);
    expect(r.chamadas.filter((linha) => linha.startsWith("timeout"))).toHaveLength(3);
  });

  for (const erro of ["assinatura", "hash", "pacote", "dpkg"]) {
    it(`${erro} fatal: uma tentativa, fonte e pino intactos`, () => {
      const r = rodar(FFMPEG, erro);
      expect(r.status, r.saida).not.toBe(0);
      expect(r.chamadas.filter((linha) => linha.startsWith("timeout"))).toHaveLength(1);
      expect(r.fonte).toBe(DEB822);
      expect(r.mtime).toBe(r.mtimeAntes);
      expect(r.pin).toEqual(r.pinAntes);
    });
  }

  it("fonte saudável termina sem trocar URI nem reescrever o arquivo", () => {
    const r = rodar(FFMPEG, "saudavel");
    expect(r.status, r.saida).toBe(0);
    expect(r.chamadas.filter((linha) => linha.startsWith("timeout"))).toHaveLength(1);
    expect(r.fonte).toBe(DEB822);
    expect(r.mtime).toBe(r.mtimeAntes);
  });

  it("um host parecido não é o Azure permitido", () => {
    const fonte = DEB822.replace("azure.archive.ubuntu.com", "azure.archive.ubuntu.com.invalido");
    const r = rodar(FFMPEG, "todos_parados", fonte);
    expect(r.status, r.saida).not.toBe(0);
    expect(r.fonte).toBe(fonte);
    expect(r.mtime).toBe(r.mtimeAntes);
  });

  it("timeout do CDN após APT saudável não troca espelho nem mata apt-get", () => {
    const r = rodar(BROWSER, "browser_cdn_parado");
    expect(r.status, r.saida).not.toBe(0);
    expect(r.chamadas.filter((linha) => linha.startsWith("timeout"))).toHaveLength(1);
    expect(r.chamadas.some((linha) => linha.startsWith("sudo pkill"))).toBe(false);
    expect(r.fonte).toBe(DEB822);
  });

  it("recusa recuperação em executor próprio antes de pkill, dpkg ou troca de fonte", () => {
    const r = rodar(FFMPEG, "azure_parado", DEB822, false, "self-hosted");
    expect(r.status, r.saida).not.toBe(0);
    expect(r.chamadas.filter((linha) => linha.startsWith("timeout"))).toHaveLength(1);
    expect(r.chamadas.some((linha) => /^sudo (pkill|dpkg|python3)/.test(linha))).toBe(false);
    expect(r.fonte).toBe(DEB822);
  });

  it("índice sem assinatura no destino impede a instalação", () => {
    const r = rodar(FFMPEG, "indice_invalido");
    expect(r.status, r.saida).not.toBe(0);
    expect(r.chamadas.some((linha) => linha.startsWith("apt-get install") && linha.includes(CANONICAL))).toBe(false);
    expect(r.chamadas.filter((linha) => linha.startsWith("timeout"))).toHaveLength(2);
  });

  it("Deb822 multilinha só muda URI, mantendo chave, snapshot e fonte de segurança", () => {
    const fonte = DEB822.replace(`URIs: ${AZURE}`, `URIs:\n ${AZURE}\n https://repo.invalido/ubuntu/`) +
      "\nTypes: deb\nURIs: https://security.ubuntu.com/ubuntu/\nSuites: noble-security\nComponents: main\n";
    const r = rodar(NORMALIZAR, "saudavel", fonte);
    expect(r.status, r.saida).toBe(0);
    expect(r.fonte).toBe(fonte.replace(AZURE, CANONICAL));
    expect(r.pin).toEqual(r.pinAntes);
  });

  it("fonte desabilitada e URI já canônica não são reescritas", () => {
    for (const fonte of [`Enabled: no\n${DEB822}`, DEB822.replace(AZURE, CANONICAL)]) {
      const r = rodar(NORMALIZAR, "saudavel", fonte);
      expect(r.status, r.saida).toBe(0);
      expect(r.fonte).toBe(fonte);
      expect(r.mtime).toBe(r.mtimeAntes);
    }
  });

  it("comentário entre URIs multilinha permanece comentário, com o endereço original", () => {
    const fonte = DEB822.replace(`URIs: ${AZURE}`, `URIs:\n ${AZURE}\n # exemplo antigo ${AZURE}`);
    const r = rodar(NORMALIZAR, "saudavel", fonte);
    expect(r.status, r.saida).toBe(0);
    expect(r.fonte).toBe(fonte.replace(AZURE, CANONICAL));
  });
});
