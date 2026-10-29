#!/usr/bin/env bash
# Compartilhado pelos dois preparos do E2E. Nunca roda apt fora do timeout
# que pertence ao chamador, nem altera a fonte de um executor próprio.

trocar_espelho_apt_e2e() {
  if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
    echo '::error title=Troca APT recusada::somente o runner descartável do GitHub pode alterar suas fontes.'
    return 1
  fi
  sudo python3 - /etc/apt <<'PY'
from pathlib import Path
import re
import sys

raiz = Path(sys.argv[1])
azure = re.compile(r"https?://azure\.archive\.ubuntu\.com/ubuntu/?\Z")
lista = raiz / "apt-mirrors.txt"
lista_conhecida = lista.is_file() and any(
    azure.fullmatch(linha.split()[0])
    for linha in lista.read_text().splitlines()
    if linha.strip() and not linha.lstrip().startswith("#")
)


def uri_oficial(uri):
    if azure.fullmatch(uri):
        return uri.replace("azure.archive.ubuntu.com", "archive.ubuntu.com")
    if uri == "mirror+file:/etc/apt/apt-mirrors.txt" and lista_conhecida:
        return "https://archive.ubuntu.com/ubuntu/"
    return uri


def deb822(bloco):
    if re.search(r"(?im)^Enabled:\s*no\s*$", bloco):
        return bloco
    linhas = []
    em_uris = False
    for linha in bloco.splitlines(keepends=True):
        if linha.lstrip().startswith("#"):
            linhas.append(linha)
            continue
        campo = re.match(r"^([A-Za-z][A-Za-z0-9-]*):", linha)
        if campo:
            em_uris = campo[1].lower() == "uris"
        if em_uris and (campo or linha[:1] in (" ", "\t")):
            linha = re.sub(r"\S+", lambda token: uri_oficial(token[0]), linha)
        linhas.append(linha)
    return "".join(linhas)


arquivos = [raiz / "sources.list"]
arquivos += sorted((raiz / "sources.list.d").glob("*.list"))
arquivos += sorted((raiz / "sources.list.d").glob("*.sources"))
alterados = 0
for arquivo in arquivos:
    if not arquivo.is_file():
        continue
    texto = arquivo.read_bytes().decode("utf-8")
    if arquivo.suffix == ".sources":
        blocos = re.split(r"(\r?\n[ \t]*\r?\n)", texto)
        novo = "".join(deb822(bloco) for bloco in blocos)
    else:
        novo = re.sub(
            r"(?m)^(\s*deb(?:-src)?[ \t]+(?:\[[^\]\r\n]*\][ \t]+)?)(\S+)",
            lambda linha: linha[1] + uri_oficial(linha[2]),
            texto,
        )
    if novo != texto:
        arquivo.write_bytes(novo.encode("utf-8"))
        alterados += 1
print(f"APT: {alterados} arquivo(s) de fonte passaram do Azure ao arquivo oficial Ubuntu")
PY
}

recuperar_apt_e2e() {
  local codigo="$1" log="$2" tentativa="$3"
  # A troca de transporte não corrige integridade, pacote inexistente ou dpkg.
  if grep -Eqi 'NO_PUBKEY|EXPKEYSIG|BADSIG|not signed|signatures couldn.t be verified|Hash Sum mismatch|Unable to locate package|has no installation candidate|dpkg: error|Sub-process.*dpkg.*error|held broken packages|unmet dependencies' "$log"; then
    echo '::error title=Falha fatal no preparo APT::assinatura, hash, pacote ou dpkg recusou a instalação; sem repetir nem trocar a fonte.'
    return 1
  fi
  # Um timeout depois de começar o download do browser é do CDN, não do APT
  # que já terminou. Não troca fonte nem mata processo para esse caso.
  if grep -Eqi 'Downloading.*(Chrome|Chromium|FFMPEG|ffmpeg|Headless Shell).*https?://|Failed to download' "$log" ||
     ! grep -Eq '^(Get|Hit|Ign|Err):[0-9]+ |^E: (Failed to fetch|Unable to fetch)' "$log"; then
    echo '::error title=Preparo falhou fora do transporte APT::não há falha APT medida nesta tentativa; sem repetir nem trocar a fonte.'
    return 1
  fi
  if [ "$codigo" -ne 124 ] && [ "$codigo" -ne 137 ] &&
     ! grep -Eq 'Failed to fetch (https?://(azure\.)?archive\.ubuntu\.com/ubuntu/|mirror\+file:/etc/apt/apt-mirrors\.txt)' "$log"; then
    echo '::error title=Preparo falhou fora do transporte APT::o erro permanece vermelho, sem nova tentativa.'
    return 1
  fi
  if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
    echo '::error title=Recuperação APT recusada::não mata processos nem altera fontes fora do runner descartável do GitHub.'
    return 1
  fi
  # O último erro será reportado pelo próprio laço; não deixa trabalho novo após ele.
  if [ "$tentativa" -eq 3 ]; then return 0; fi
  sudo pkill -KILL -x apt-get || :
  sudo dpkg --configure -a
  if [ "$tentativa" -eq 1 ] &&
     grep -Eq '(https?://azure\.archive\.ubuntu\.com/ubuntu/|file:/etc/apt/apt-mirrors\.txt)' "$log"; then
    trocar_espelho_apt_e2e
  fi
}
