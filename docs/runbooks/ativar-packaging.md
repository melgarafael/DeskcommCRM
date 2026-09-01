# Runbook — ativar a doutrina de packaging (uma vez só)

> **CONCLUÍDO em 2026-08-14. Este runbook é histórico** — guardado porque descreve o
> procedimento e as armadilhas de cada passo, não porque haja algo a fazer.
>
> | Passo | Estado | Prova |
> |---|---|---|
> | 1–2. Pacotes públicos | feito | `docker pull` anônimo resolve as três |
> | 3. `imagens-ok` obrigatório | feito | `protection` → `verify, build-and-size, invariants, e2e, imagens-ok` |
> | 4. Primeira release completa | feito | v1.3.0; `1.3.0` e `stable` nos três pacotes |
> | 5. Tag de ensaio apagada | feito | `docs-doutrina-packaging` → 404 nos três |
>
> Reconfira na fonte antes de confiar nesta tabela — foi por confiar numa nota de estado
> que a doutrina passou um dia inteiro afirmando que o `imagens-ok` não bloqueava, depois
> de ele já bloquear.

Este documento existe porque a entrega da [doutrina de packaging](../doctrine/packaging.md)
tem três passos que **não podem estar dentro do PR**: dois dependem de administração do
repositório e um depende de as imagens existirem. Enquanto eles não forem dados, parte da
doutrina é conselho, não gate — e o texto diz isso onde for o caso.

Faça na ordem. Cada passo tem a verificação que prova que ele funcionou.

---

## Antes de começar: a sonda

Cole no shell. `curl` cru no GHCR responde `401`, e um corpo de erro não contém a versão
procurada — o que faz qualquer checagem ingênua aprovar tudo.

```bash
ghcr_status() {   # $1=imagem  $2=tag  → 200 existe | 404 não existe | 403 privado
  local t
  t=$(curl -s "https://ghcr.io/token?scope=repository:melgarafael/$1:pull&service=ghcr.io" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $t" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    "https://ghcr.io/v2/melgarafael/$1/manifests/$2"
}
```

Estado no momento em que este runbook foi escrito (2026-08-13):

```console
$ ghcr_status deskcommcrm 1.2.1        → 200
$ ghcr_status deskcommcrm stable       → 404   (o canal ainda não existe)
$ ghcr_status deskcomm-worker latest   → 403   (o pacote ainda não existe)
```

---

## 1. Merge do PR na `main`

O push na `main` dispara `publish-image.yml`, que **cria** os dois pacotes novos
(`deskcomm-worker`, `deskcomm-scheduler`) publicando `main` e `latest` neles.

**Verificação:**

```bash
gh run list --workflow=publish-image.yml --limit 3    # o run da main ficou verde?
ghcr_status deskcomm-worker latest                    # esperado agora: 403 (existe, privado)
```

`403` aqui é **progresso**, não erro: significa que o pacote passou a existir. `404` significa
que o run não publicou — investigue o run antes de seguir.

## 2. Tornar os dois pacotes novos PÚBLICOS

**É o passo que mais trava na estreia de uma imagem, e ele é manual.** Todo pacote recém-criado
no GHCR nasce privado, e repositório público não muda isso. Enquanto for privado, o
`docker compose pull` de **toda VPS** é negado — e como `pull` de um serviço com `image:` falha
a operação inteira, a atualização de um cliente morre depois do `git checkout` e do banco.

Para cada um de `deskcomm-worker` e `deskcomm-scheduler`:

> github.com/users/melgarafael/packages/container/`<pacote>`/settings → Danger Zone →
> Change visibility → **Public**

Enquanto estiver aqui, ligue também **Inherit access from repository**, para o pacote seguir a
permissão do repositório em vez de uma lista própria.

**Verificação:**

```bash
for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
  echo "$i: $(ghcr_status $i latest)"
done
# esperado: 200 nos três
```

## 3. `imagens-ok` vira status check obrigatório

Só agora, e a ordem importa: um required check que não existe na base dos PRs já abertos
bloqueia **todos** eles até que cada um faça rebase. Depois do merge, `imagens-ok` existe na
`main` e todo PR novo já nasce com ele.

```bash
gh api -X PATCH repos/melgarafael/DeskcommCRM/branches/main/protection/required_status_checks \
  -f 'checks[][context]=verify' \
  -f 'checks[][context]=build-and-size' \
  -f 'checks[][context]=invariants' \
  -f 'checks[][context]=e2e' \
  -f 'checks[][context]=imagens-ok'
```

> Use **`imagens-ok`**, não `build-and-push`. O job de build virou matriz de três imagens, e o
> nome do check passou a ser `build-and-push (deskcommcrm, …)` — exigir cada um pelo nome faria
> uma quarta imagem, um dia, escapar do gate em silêncio. `imagens-ok` é o job de fachada que
> existe exatamente para dar um nome estável.

**Verificação:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
  --jq '.required_status_checks.contexts|join(", ")'
# esperado: verify, build-and-size, invariants, e2e, imagens-ok
```

Feito isso, **remova a "Pendência de ativação"** do invariante 2 em
[`../doctrine/packaging.md`](../doctrine/packaging.md) e as ressalvas correspondentes em
`CLAUDE.md` e `CONTRIBUTING.md`. Deixar a ressalva de pé depois de a pendência ter sido
resolvida transforma a doutrina em documento que subestima a si mesmo — o defeito espelhado
do que ela veio consertar.

## 4. Primeira release completa

Só uma tag `v*` publica os números de versão e o canal `stable`. Até ela existir, o default
`:stable` do compose não resolve, e o caminho de avaliação (clonar e rodar `up -d` sem `.env`)
não sobe. Siga o §Checklist de release da doutrina.

**Verificação:**

```bash
for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
  echo "$i X.Y.Z: $(ghcr_status $i X.Y.Z)  stable: $(ghcr_status $i stable)"
done
# esperado: 200 em todos

docker run --rm ghcr.io/melgarafael/deskcommcrm:X.Y.Z \
  node -e 'console.log(process.env.APP_VERSION)'
# esperado: X.Y.Z   (antes desta release, `undefined` — nenhuma imagem publicada a carrega)
```

## 5. Ensaio numa VPS real

O item 11 do checklist de release, e o único que o CI não exercita. Numa instalação **não
fresca**, a partir da versão anterior:

```bash
bash self-host-kit/update.sh
curl -s https://<DOMAIN>/api/v1/health | jq -r '.data.version'   # esperado: X.Y.Z
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/       # esperado: 307
grep -E '^(APP|WORKER|SCHEDULER)_IMAGE=' .env                    # esperado: as três em X.Y.Z
docker compose -f docker-compose.prod.yml ps                     # esperado: tudo healthy
```

O que este ensaio prova e nenhum teste do CI prova: que uma VPS **saiu do estado A e chegou ao
estado B**. O CI prova que os scripts fazem o que dizem — não que a máquina de alguém mudou.
É o caso U6 de [`../testing/user-journey-map.md`](../testing/user-journey-map.md), declarado
como não coberto de propósito.

---

## Enquanto os passos 1–4 não acontecem

Nada quebra, e isso é por construção:

| Quem | O que acontece |
|---|---|
| Parque instalado | segue igual — o compose novo só chega a uma VPS pelo `git checkout` de uma tag `v*` nova |
| Instalação nova | o `install.sh` sonda o registry, vê que o trio não está publicado, **avisa** e constrói worker/scheduler localmente (lento, funciona) |
| Avaliação (`up -d` sem `.env`) | o app não sobe até o `stable` existir — o passo 4 resolve |
| PR de contribuidor | `imagens-ok` roda e informa; não bloqueia até o passo 3 |
