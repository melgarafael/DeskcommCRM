# Gianna na VPS

Cada clínica usa uma VPS e uma instalação com Gianna, WAHA e Supabase self-hosted. A instalação e o botão **Atualizar** usam as releases publicadas no fork.

## Instalar em uma VPS Ubuntu

Aponte o domínio da clínica para a VPS. Depois de publicar a primeira release, execute na VPS com acesso administrativo:

```bash
repo=https://github.com/jadsonlsouza/DeskcommCRM
tag="$(curl -fsSL https://api.github.com/repos/jadsonlsouza/DeskcommCRM/releases/latest | jq -er .tag_name)"
git clone --branch "$tag" "$repo.git" deskcommcrm
cd deskcommcrm
bash ubuntu-production-installer.sh --domain crm.sua-clinica.com.br
```

O comando usa `git`, `curl` e `jq`. Se faltarem, instale-os com `sudo apt-get install git curl jq`. O instalador confere o checkout e as imagens da release antes de preparar o Supabase. O primeiro acesso é gerado em `.runtime/admin-credentials`. O token da Amigo API é cadastrado na aplicação.

## Incorporar uma versão do Deskcomm

Em uma cópia de desenvolvimento, busque a versão oficial e abra uma branch de integração:

```bash
git fetch --no-tags upstream main
git fetch origin codex/amigo-api
git switch -c codex/gianna-integrar origin/codex/amigo-api
git merge upstream/main
```

Revise os conflitos e o schema antes de juntar a branch de integração à `codex/amigo-api`. Confira a agenda nativa, a agenda Amigo e as permissões dos agentes. Confira também os identificadores das migrações do Amigo contra as do Deskcomm e aplique o baseline em uma instalação de teste com Supabase self-hosted. Adicione as notas da nova versão no topo de `CHANGELOG.gianna.md`, no formato `## [0.1.1]`.

## Publicar para o botão Atualizar

Depois da revisão, envie `codex/amigo-api` ao fork e crie a tag de publicação no topo dessa branch. Por exemplo, para publicar a primeira versão:

```bash
git switch codex/amigo-api
git push origin codex/amigo-api
git tag gianna-release-v0.1.0
git push origin refs/tags/gianna-release-v0.1.0
```

O workflow `gianna-release.yml` executa os testes do kit, constrói app, worker, scheduler e telefonia para AMD64 e ARM64 e confere os quatro pacotes por acesso anônimo. Só então cria a release `v0.1.0`. Na primeira publicação, se o GHCR criar pacotes privados, torne os quatro pacotes públicos nas configurações do GitHub Packages e execute novamente todos os jobs da publicação.

O agente instalado na VPS identifica a release no `origin` e disponibiliza a atualização para um administrador. Valide em uma VPS de teste com uma versão anterior antes de aplicar em clínicas. Na validação, confira login, marca, versão do app, execução do worker, sincronização do Amigo e os dados existentes após a atualização.
