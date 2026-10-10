# DeskcommCRM single-server atrás do Coolify, numa VPS HostGator: medição de 06–07/10/2026

**Tipo: HISTÓRICA** (ver `evidence/README.md`). A VPS de teste será destruída: nada aqui
pode ser regenerado. Uma medição nova vira pasta nova; esta não se sobrescreve.

**Quando a regra começa a valer:** a partir do merge do PR 4. Antes da primeira publicação
(sem push), a pasta foi corrigida UMA vez, em commit novo (não amend), em 2026-10-07 ~19:10Z:
achados dos revisores das Fases F, G e H e a remedição sem swap (`60-*`…`66-*`, `r60/`).
Arquivos gravados na medição não foram reescritos, com duas exceções marcadas no próprio
arquivo (a legenda no fim de `47-g3-remocao.txt` e as linhas acrescentadas ao fim de
`43-g5b-gate.txt`); arquivos novos gravados na correção, cada um com cabeçalho de origem:
`24-r2-gate.txt`, `43-g5-gate.txt`, `46b-permissoes-do-backup.txt` e
`52-h2-varredura-de-segredos.txt`. Este README foi reescrito nas partes que os achados tocam.

Esta pasta é a fonte dos números e das afirmações de `docs/saas/coolify.md`. O IP e o
hostname da VPS foram trocados por `<ip-da-vps>` e `<host-da-vps>` em todos os arquivos;
o domínio de teste é `<ip-da-vps>.sslip.io`.

## 1. Contra o quê

| Peça | Versão / identidade | Arquivo |
|---|---|---|
| Datas (UTC) | Coolify: 2026-10-06 20:26–21:03Z; CRM + banco: 2026-10-07 13:58–17:49Z; remedição sem swap: 2026-10-07 18:16–18:55Z; esta pasta: 2026-10-07 ~18:00Z, corrigida ~19:10Z | ledger do PR 4; `61-janelas-log.txt` |
| Instalação medida na remedição sem swap | a da G5 Passo 2 (kit `44c5df541`, subida 17:47–17:48Z), com o onboarding refeito pela tela às 18:16Z (`60-onboarding-banco.txt` = `1 1 0`: organizações, agentes, canais); imagens iguais antes e depois (`63-versoes-antes-depois.txt`, arquivo inteiro, sha256 iguais) | `r60/versoes-antes.txt` |
| Instalador ATUAL (a falha da C2) | `main@8f220470b31f3c5ce02a1494361fa244f16061d1` | `16-c-kit-sha.txt`, `17-c-como-esta.txt` |
| Kit com o conserto, rodada 1 (D4) | `docs/saas-guia-coolify@456c052599f806ee76d84ebca69dc25fb9e22dc7` sobre `main@8f220470b` — **sem** o conserto da saída do `setup.sh` | `20-r1-kit-sha.txt` |
| Kit com o conserto, rodada 2 (G3), G5 e U1 Passo 3 | `docs/saas-guia-coolify@44c5df54161a6e0c527c9fdfbaaf570ec24be9c3` (o anterior + a saída do `setup.sh` em `.runtime/supabase-setup.log`, 600) | `24-r2-kit-sha.txt`, `43-g5-kit-sha.txt` |
| Depois da medição | a branch recebeu a `main` `ce5b87a3c` (merge `2c7fc2426`); a `main` não tocou nenhum arquivo do kit do PR desde `8f220470b`; testes de shell refeitos sobre o merge | `50-h1-testes-shell.txt` |
| Imagens do CRM | tag `1.76.0` (release `v1.76.0`, `^{commit}` = `3101682cdc9d1448304f6c613349281b2db6857d`, conferido no rótulo `revision` das três); digest `deskcommcrm` `sha256:52e1a5d3381e…`, `deskcomm-worker` `sha256:73dfbcaedbbd…`, `deskcomm-scheduler` `sha256:3596737e0371…` | `versoes-antes.txt`, `20-r1-versoes.txt` |
| Supabase self-hosted | ref `self-hosted/v0.8.1` (tag `690080884040…` → commit `8c7a4d9dbbaf…`); `setup.sh` sha256 `848973911bd5fa03…bc813c`, igual ao do GitHub nessa tag | `51-h3-supabase-ref.txt` |
| As 11 imagens do Supabase | `supabase/postgres:17.6.1.136` `f371b5f3f2ac…`, `supabase/gotrue:v2.196.0` `c0c25187a6b8…`, `postgrest/postgrest:v14.17` `c9dc201e555f…`, `supabase/realtime:v2.134.10` `cbcc6a7986fc…`, `supabase/storage-api:v1.74.0` `f1546fac6d1c…`, `darthsim/imgproxy:v3.31.4` `73c5dda13199…`, `supabase/postgres-meta:v0.99.0` `9a079ac1c94d…`, `supabase/edge-runtime:v1.76.2` `edd22bef4477…`, `supabase/studio:2026.09.07-sha-7996410` `94a2a9d2906e…`, `supabase/supavisor:2.9.12` `464b93a60ba8…`, `envoyproxy/envoy:v1.39.1` `57e14a549d7b…` (todos `sha256:`) | `versoes-antes.txt` |
| WAHA | `devlikeapro/waha:latest-2026.7.2` `sha256:65e593e30bb7…` | `versoes-antes.txt` |
| Coolify | `coollabsio/coolify:4.3.23` (de `docker.io`, não `ghcr.io`) `sha256:79d5c0443696…`; helper `1.0.17` `sha256:c7a7748b233d…`; realtime `1.0.19` `sha256:087c9d263ab0…` (o `versions.json` do CDN dizia 1.0.18); `postgres:15-alpine` `f7d23353e1b1…`; `redis:7-alpine` `858f009f9709…`; instalador `install.sh` sha256 `8ef02dce49339208…e314e0f2cd`, rodado com `AUTOUPDATE=false` | `10-coolify-versao.txt` |
| Proxy do Coolify | `traefik:v3.6` `sha256:31267173a15b…`, rede `coolify` (bridge, attachable) | `12-proxy.txt`, `versoes-antes.txt` |
| `coolify-sentinel` | em execução `coollabsio/sentinel:1.0.2` `sha256:9355fc746d5c…`, ligado de fábrica; no disco também a imagem `1.0.1` (havia duas versões apesar de `AUTOUPDATE=false`; o mecanismo da troca não foi medido) | `versoes-antes.txt`, `40-antes-da-faxina.txt` |
| Docker | Engine `29.8.2`, compose `5.6.0` | `10-coolify-versao.txt`, `versoes-antes.txt` (F4 Passo 2) |

## 2. Onde

VPS HostGator, ficha medida ANTES de qualquer instalação (`01-ficha-da-vps.txt`):
Ubuntu 22.04.5 LTS, kernel `6.8.0-138-generic`, x86_64, 4 vCPU AMD EPYC 9J45, virtualização
`kvm`, 7940 MiB de RAM (258 MiB usados pelo SO cru), **sem swap na linha de base**, disco
196 GB (4,8 GB usados), `cgroup2fs`, sem Docker, sem IPv6 global, sshd na porta 22022.

**A VPS era uma bancada COMPARTILHADA** com outras sessões de teste (contêineres
`deskcomm-test-db-*`, `typecheck`). Consequências:

- toda janela de medição rodou dentro do `flock /root/.vps-teste.lock` das sessões, e em
  todas as amostras não havia contêiner de terceiro (`TOTAL-terceiros` nunca aparece);
- **um `/swapfile` de 4 GiB, persistente no `/etc/fstab`, existia desde 13:46:10Z de 07/10**
  (mtime em `swap-e-oom.txt`), antes da rodada 1. Ele é da sessão `deskcommcrm-07`, que o
  criou depois de 14 OOMs no typecheck dela (confirmado pela dona por mensagem ao controlador
  às ~16:5xZ; registrado nas notas do controlador do PR 4 — fonte é a mensagem, não um
  arquivo desta pasta). Os 14 `Out of memory` em processos `node` de `swap-e-oom.txt` (13:32–13:44Z)
  batem com essa contagem.
- **O swap nunca foi lido DURANTE as janelas da Fase F.** A primeira leitura é das 16:22:46Z
  (`swapon --show` com 2 linhas, F4 Passo 2, `versoes-antes.txt`) e a segunda das 16:26:59Z
  (`swap-e-oom.txt`: 1,7 GiB em uso, 1611 MiB deles páginas dos nossos contêineres) — as duas
  DEPOIS do fim da F3 (16:12:30Z). Quanto estava em swap dentro das janelas: NÃO MEDIDO.
- Por isso as janelas F1 e F3 foram **remedidas com o swap desligado** (18:35:18–18:50:03Z,
  dentro de um `flock` só, com o ok da dona; `swapoff`/`swapon` e o `fstab` intocado em
  `61-janelas-log.txt`, `60-swap-religado.txt`; swap lido em CADA amostra:
  `swap_used=0` em 10/10 e 48/48, `66-swap-durante-as-janelas.txt`). Os números publicados são
  os da remedição; os da Fase F, com swap, ficam como nota (seção 4).

## 3. Como

### Instrumentos (transcritos; rodam na VPS como root)

`amostrar.sh` (uma linha por contêiner por amostra, mais a linha da máquina):

```bash
#!/usr/bin/env bash
# amostrar.sh <arquivo> <quantas> <intervalo_s>: uma linha por contêiner por amostra
# <instante UTC> \t <nome> \t <MEM USAGE / LIMIT> \t <CPU%>
set -eu
arq=$1; n=$2; iv=$3
: > "$arq"; : > "$arq.host"
for i in $(seq 1 "$n"); do
  t=$(date -u +%FT%TZ)
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | sed "s/^/$t\t/" >> "$arq"
  # total da MÁQUINA no mesmo instante (inclui dockerd, containerd e docker-proxy, que o docker stats não vê)
  free -m | awk -v t="$t" '/^Mem:/{print t"\tused="$3"\tavailable="$7}' >> "$arq.host"
  [ "$i" = "$n" ] || sleep "$iv"
done
echo "amostras=$n linhas=$(wc -l < "$arq") host=$(wc -l < "$arq.host")"
```

`picos.sh` (`memory.peak` do cgroup, desde que o contêiner subiu):

```bash
#!/usr/bin/env bash
# picos.sh: memory.peak (desde que o contêiner subiu) de cada contêiner vivo, em MiB.
set -eu
for id in $(docker ps -q --no-trunc); do
  n=$(docker inspect -f '{{.Name}}' "$id")
  f=/sys/fs/cgroup/system.slice/docker-$id.scope/memory.peak
  [ -r "$f" ] || f=$(find /sys/fs/cgroup -path "*$id*" -name memory.peak 2>/dev/null | head -1)
  if [ -n "$f" ] && [ -r "$f" ]; then printf '%s\t%s MiB\n' "${n#/}" "$(( $(cat "$f") / 1048576 ))"
  else printf '%s\tindisponivel\n' "${n#/}"; fi
done | sort
```

`resumir.awk` (roda na máquina local, **sempre com `LC_ALL=C`**: em `pt_BR.UTF-8` o `awk`
lê `1.1GiB` como `1` e a vírgula decimal estraga a CPU — medido no controle da Fase A). Quatro
grupos: `coolify*`, `deskcommcrm-supabase-*`, `deskcommcrm-*` (CRM) e o resto (`terceiros`,
fora de todo total):

```awk
function mib(s,  v,u){ v=s; sub(/[A-Za-z]+$/,"",v); u=s; sub(/^[0-9.]+/,"",u)
  if(u=="GiB")return v*1024; if(u=="MiB")return v+0; if(u=="KiB")return v/1024; if(u=="B")return v/1048576; return -1 }
BEGIN{FS="\t"}
{ split($3,m," / "); mem=mib(m[1]); cpu=$4; sub(/%/,"",cpu)
  g=($2 ~ /^coolify/) ? "coolify" : (($2 ~ /^deskcommcrm-supabase-/) ? "supabase" : (($2 ~ /^deskcommcrm-/) ? "crm" : "terceiros"))
  c[$2]++; sm[$2]+=mem; if(mem>mx[$2])mx[$2]=mem; if(cpu+0>cx[$2])cx[$2]=cpu+0; sc[$2]+=cpu
  soma[$1 "|" g]+=mem; nomes[$2]=1 }
END{ for(n in nomes) printf "%s\tn=%d\tmem_med=%.0f MiB\tmem_max=%.0f MiB\tcpu_med=%.1f%%\tcpu_max=%.1f%%\n", n, c[n], sm[n]/c[n], mx[n], sc[n]/c[n], cx[n]
     for(k in soma){split(k,a,"|"); if(soma[k]>pk[a[2]])pk[a[2]]=soma[k]}
     for(g in pk) printf "TOTAL-%s\t%.0f MiB\t(maior soma num mesmo instante)\n", g, pk[g] }
```

Controle positivo do resumidor com dados de mentira: `28-f0-controle-resumidor.txt`.

`vazamento.sh` (a sonda de segredo de todo log de instalador, update e backup, e desta pasta):
conta, para cada segredo dos `.env` do CRM e do Supabase, do `admin-credentials` e das cópias
guardadas antes de cada remoção, quantas vezes o VALOR aparece no arquivo. Imprime só
`ARQUIVO:NOME=contagem`; o valor nunca vai a argumento de comando.

```bash
#!/usr/bin/env bash
set -u
log=$1; arv=${2:-/root/pr4/deskcommcrm}
conta() { grep -cFf <(printf '%s\n' "$1") "$log"; }
for arq in "$arv/.env" "$arv/.runtime/supabase/.env" "$arv/.runtime/admin-credentials" /root/deskcomm-guardado-*/env /root/deskcomm-guardado-*/env-supabase /root/deskcomm-guardado-*/admin-credentials; do
  [ -r "$arq" ] || continue
  case $arq in /root/deskcomm-guardado-*) r=${arq#/root/};; *) r=$(basename "$arq");; esac
  grep -E '^[A-Z0-9_]*(PASS|SECRET|KEY|TOKEN|DB_URL|ENC|JWKS?)[A-Z0-9_]*=' "$arq" | while IFS= read -r l; do
    k=${l%%=*}; v=${l#*=}; v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
    [ "${#v}" -ge 12 ] || continue
    printf '%s:%s=%s\n' "$r" "$k" "$(conta "$v")"
    printf '%s\n' "$v" | grep -oE '"(d|k)":"[^"]{12,}"' | while IFS= read -r p; do
      c=${p:1:1}; x=${p#*\":\"}; x=${x%\"}
      printf '%s:%s.%s=%s\n' "$r" "$k" "$c" "$(conta "$x")"
    done
  done
done
printf 'padroes=%s\n' "$(grep -cE 'eyJ[A-Za-z0-9_-]{20,}|sb_secret_|sk-or-|sk-ant-|postgres(ql)?://[^ ]*:[^ @]+@' "$log")"
```

`gate.sh` (a bancada está livre? só lê):

```bash
#!/usr/bin/env bash
t=$(docker ps --format '{{.Names}}' | grep -vcE '^(coolify|deskcommcrm-)')
a=$(free -m | awk 'NR==2{print $7}')
l=$(flock -n /root/.vps-teste.lock true 2>/dev/null && echo livre || echo ocupado)
x=$(docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project.working_dir"}}' | awk '$1 ~ /^deskcommcrm-/ && $2 !~ /^\/root\/pr4\/deskcommcrm/' | wc -l)
echo "$(date -u +%FT%TZ) terceiros=$t available=$a lock=$l alheio=$x"
```

Leitura do gate: rodado DENTRO do `flock`, ele sempre diz `lock=ocupado` (o lock é o nosso);
por isso o `lock=` vale só para a linha de fora, e a de dentro vale para `terceiros` e RAM.

### Instrumentos da remedição sem swap (18:28–18:50Z)

`amostrar-r60.sh` = o `amostrar.sh` acima e mais duas coisas: o `.host` ganha `swap_used` e
`swap_total` de cada amostra, e um terceiro arquivo `.free` guarda o `free -m` inteiro:

```bash
#!/usr/bin/env bash
# amostrar-r60.sh <arquivo> <quantas> <intervalo_s>: igual ao amostrar.sh, e mais:
# .host ganha swap_used/swap_total; .free guarda o free -m inteiro de cada amostra.
set -eu
arq=$1; n=$2; iv=$3
: > "$arq"; : > "$arq.host"; : > "$arq.free"
for i in $(seq 1 "$n"); do
  t=$(date -u +%FT%TZ)
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | sed "s/^/$t\t/" >> "$arq"
  f=$(free -m)
  printf '%s\n' "$f" | awk -v t="$t" '/^Mem:/{u=$3;a=$7} /^Swap:/{s=$3;st=$2} END{print t"\tused="u"\tavailable="a"\tswap_used="s"\tswap_total="st}' >> "$arq.host"
  { echo "== $t"; printf '%s\n' "$f"; } >> "$arq.free"
  [ "$i" = "$n" ] || sleep "$iv"
done
echo "amostras=$n linhas=$(wc -l < "$arq") host=$(wc -l < "$arq.host")"
```

O runner (`rodar.sh`, condição da dona do swap): um `flock -w 3600 /root/.vps-teste.lock`
só, com `trap "swapon /swapfile; …; swapon --show" EXIT` (o swap volta mesmo com falha;
`fstab` intocado); dentro, `pre.sh` confere RAM (`available > swap usado + 1024 MiB`), depois
`swapoff /swapfile` e as janelas: F1 60 s depois do `swapoff`; F3 com 30 s de descarte depois
do `docker run` do `psql` que lê o token, e o próximo `docker run` (desfecho) só depois da
última amostra; cada `docker run` do runner com hora no log (`61-janelas-log.txt`,
`62-f3-conversa.txt`). Antes do flock, o onboarding do CRM foi refeito pela tela.

| Janela (remedição) | Fora do lock | Dentro do lock (início → fim) | Amostras |
|---|---|---|---|
| F1 repouso sem canal | 18:28:27Z `terceiros=0 available=4161` (swap ligado, 1,7 GiB) | 18:36:20Z `terceiros=0 available=4646` → 18:41:12Z `available=4615` | 10 × 30 s |
| F3 conversa | (mesmo flock) | 1ª amostra 18:43:23Z → fim 18:50:03Z `available=4520` | 48 × 5 s |

O gate dentro do lock antes do `swapoff` (18:35:06Z) dizia `available=6241`; depois do
`swapoff` as páginas voltam à RAM (`used` 2577 às 18:35:18Z). A F2 (repouso com canal) NÃO foi
remedida.

### As janelas (Fase F; linhas do gate em `29-f-janelas.txt`)

| Janela | Fora do lock, antes | Dentro do lock (início → fim) | Amostras |
|---|---|---|---|
| F1 repouso sem canal | 15:25:18Z `terceiros=1 available=5396` | 15:31:00Z `terceiros=0 available=5996` → 15:35:52Z `terceiros=0 available=5971` | 10 × 30 s |
| F2 repouso com canal | 15:37:59Z `terceiros=1 available=5826` | 15:45:07Z `terceiros=0 available=6216` → 15:49:58Z `terceiros=0 available=6117` | 10 × 30 s |
| F3 conversa | 15:50:31Z `terceiros=0 available=2372` | 16:05:51Z `terceiros=0 available=5713` → 16:12:30Z `terceiros=0 available=6094` | 48 × 5 s |

A F1 começou depois de 10 min sem toque. Na F2 a sessão do WhatsApp já estava em `FAILED`
no início e no fim da janela (`29-f-janelas.txt`): o "repouso com canal" medido é com a sessão
em `FAILED`, não aguardando QR. Que ela passou por `SCAN_QR_CODE` às 15:37:49Z e expirou durante
a fila do lock está só no ledger (saída de terminal, sem arquivo nesta pasta).

O roteiro de tela `crm-qr` sai com `exit=0` mesmo quando o seletor do QR
(`img[src*="/whatsapp/qr"]`) não casa ("QR não apareceu em 60s"): foi o que aconteceu nas duas
vezes (F2 às 15:36–15:37Z e remedição às 18:41–18:42Z). Nas duas, a foto do modal mostra o QR e
o estado da sessão foi lido no banco/WAHA, não no `exit` do roteiro.

**Conversa da F3**, pelo caminho de produção (o webhook do WAHA do canal), sem número real e
com a IA desligada. Cinco POSTs, um a cada 30 s, com o token do canal lido do banco (aqui
`<token>`) e um remetente de DDD `00`, que não existe:

```bash
corpo=$(printf '{"event":"message","session":"medicao","payload":{"id":"medicao-%s-%s","from":"5500900000001@c.us","fromMe":false,"body":"Teste %s: quais horarios voces atendem?","timestamp":%s,"_data":{"notifyName":"Cliente Medicao"}}}' "$ts" "$i" "$i" "$ts")
curl -s -o /dev/null -w "msg $i -> %{http_code}\n" -H 'content-type: application/json' -d "$corpo" "https://${DOMINIO}/api/v1/webhooks/waha/<token>"
```

Durante a conversa, a linha `:drain` do crontab do HOST ficou fora (16:05:51Z–16:12:30Z),
para que a drenagem do `event_log` só pudesse vir do `scheduler`. Resultado
(`conversa-envios.txt`, `conversa-desfecho.txt`): `msg 1..5 -> 200`, `inbound 5`,
`llm_calls 0`, e desde o início da conversa `event_log` `done 12` (`message.received 5`,
`ai_agent.dispatch_requested 5`, `lead.created 1`, `conversation.routing_requested 1`),
nenhum `pending`: **o scheduler drenou** (prova pelo dado). Depois a fila foi limpa e o
contato bloqueado (`30-f3b-limpeza.txt`). Na remedição, a mesma conversa (sessão em
`SCAN_QR_CODE`, dreno do host fora de 18:42:52Z a 18:50:01Z): `msg 1..5 -> 200`, `inbound 5`,
`llm_calls 0`, `event_log` desde o início `done 14` (os mesmos 12 e mais
`channel_session.status_changed 1` e `central.aviso_criado 1`), nenhum `pending`
(`62-f3-conversa.txt`); limpeza `fila 0`, `bloqueado 1`, e de novo 5 min depois
(`62b-f3b-limpeza.txt`; a repetição de 18:51:08Z saiu ~1 min depois e está marcada como não
válida no arquivo).

**Instante suspeito da F3 com swap:** o `docker run` do `psql` que lê o token roda no mesmo
segundo em que a amostragem começa (16:05:51Z; `janela-f3.sh`, não versionado). A 1ª amostra
da máquina é `used=1688`; a 2ª `1496`; as outras 46, `1370–1466` (`conversa.tsv.host`). Medida é a
coincidência no tempo; que o pico venha do `docker run`, não. A remedição separou os dois por 30 s.

### As três réguas de memória

1. `MEM USAGE` do `docker stats` (sem cache inativo) — `*.tsv`, resumido em `resumo.txt`;
2. `memory.peak` do cgroup (com cache, desde a subida do contêiner) — `*-picos.txt`;
3. `used` do `free -m` da máquina inteira (inclui `dockerd`, `containerd`, `docker-proxy`)
   — `*.tsv.host`.

CPU% é por núcleo: 100% = um núcleo inteiro (a VPS tem 4).

## 4. O que foi medido, e o que não foi

**Medido:**

- **O instalador ATUAL falha atrás do Coolify** (C2, `17-c-como-esta.txt`): `exit=1` em 45 s
  (incluindo baixar as 11 imagens do Supabase, ~9,1 GB descompactadas), com
  `Bind for 0.0.0.0:8000 failed: port is already allocated` no gateway do Supabase — a 8000 é
  do painel do Coolify. E o `setup.sh` do Supabase imprimia na tela cada segredo gerado.
- **O conserto** (D1/D2/(a)): `API_GW_HTTP_PORT` validada e gravada, o terceiro arquivo de
  compose que põe o gateway na rede do proxy, a saída do `setup.sh` para arquivo 600. Testes
  de shell na VPS: vermelho antes, verde depois, sabotagem reprovando (`18-d-*.txt`); refeitos
  sobre o merge da `main` (`50-h1-testes-shell.txt`: 36 de 38 verdes; os 2 vermelhos —
  `guarda-arm-so-considera-instalacao-real` e `extensao-nao-instala` — também falham, na mesma
  prova, na árvore da `main` `ce5b87a3c`; a causa NÃO foi medida).
- **Rodada 1** (D4, kit `456c05259`, banco virgem): `exit=0` em 2 min 44 s com as imagens
  baixadas. A sonda achou 23 segredos no log do instalador (o `setup.sh` ainda imprimia;
  `20-r1-vazamento.txt`). A tentativa anterior (r1a) falhou por causa do INSTRUMENTO: o
  `umask 077` do runner era herdado e o Postgres não lia os init-scripts
  (`20-r1a-o-conserto-pegou.txt`, `20-r1a-supabase-logs-mascarado.txt`). Daí em diante,
  `umask 022` só antes do instalador.
- **Rodada 2** (G3, kit `44c5df541`, banco virgem, certificado já emitido): `exit=0` em
  1 min 23 s com as imagens em cache; a sonda achou só a senha do dono, onde ela deve estar
  (`24-r2-vazamento.txt`). O conserto da saída do `setup.sh` está provado numa instalação real.
- **Único desvio do comando do guia**, além do clone da branch: o `admin-credentials` foi
  pré-semeado em `.runtime/` (para a senha do dono nascer de um arquivo 600 local).
- Redes, rótulos, portas e `.env` gravados (`20-r1-env-redes-rotulos.txt`,
  `24-r2-env-redes-rotulos.txt`); certificado do Let's Encrypt no sslip.io, sem limite de taxa
  (`21-certificado.txt`; o crt.sh estava fora do ar, `21-crtsh-sslip.txt`).
- Conferências pela rede (`21c`, `21d`, `22`, `23-e5`, `24-e6`, `26`, `27`): 307 até o login,
  WAHA global fechado (403), rotas do Supabase pelo Envoy (401 sem `x-request-id`), cron do
  host pelo Traefik, crons do scheduler, o CRM falando com o banco por cinco caminhos,
  incluindo o retorno do app ao próprio domínio pelo IP público (hairpin, `app->supabase 200`).
- **O painel do banco é alcançável de qualquer contêiner da rede `coolify`**, protegido só pela
  senha do painel (`27-e8-portas.txt`, E8 Passo 2: `401`).
- Atrás do Coolify, "subiu com a lista errada de `-f`" e "CRM removido" respondem **503
  `no available server` no https** (e 404 no http), por causa do roteador `catchall` que o
  Coolify grava (`21b-coolify-503-catchall.txt`, `21b-404-lista-de-f.txt`, `47-g3-remocao.txt`).
- Sabotagem da rede do proxy (`44-g4-sabotagem-da-rede.txt`): sem a rede, a rota do banco
  trava (timeout ≥ 60 s, nunca 502/504) e o CRM inteiro cai junto; reconectar à mão pode não
  bastar. O mecanismo da queda de ~6–7 min da primeira rodada **não foi provado**.
- **Restart Proxy pela tela do Coolify** (G4): o proxy é recriado e a rota do banco sobrevive,
  sem comando nosso (`44-g4-single-server-atras-do-coolify.txt`).
- **Quem roda o instalador SEM as variáveis** (G5): falha em 13 s com o mesmo `Bind … 8000`;
  rodar o comando certo por cima, sem apagar nada, recupera tudo em 1 min 12 s
  (`43-g5-*`, `43-g5b-*`).
- Rede extra pendurada no proxy (G2): sem `TRAEFIK_NETWORK`, a descoberta escolheria a rede
  errada; com a variável, a exportada vence (`42-rede-errada.txt`, `24-r2-env-redes-rotulos.txt`).
- **`update.sh`**: no caminho do guia, recusa (`exit=3`, "versão ANTERIOR à instalada",
  `23-r1-update-recusa.txt`); com `--to v1.76.0 --force`, rebaixa o kit para a release com as
  MESMAS imagens e preserva porta e rede (`23-r1-update-forcado.txt`, `23-r1-depois-do-update-*`).
  G1 e G2 rodaram sobre esse estado (kit da branch por cima do schema da `v1.76.0`).
- Backup antes de cada remoção (`46-g3-backup.txt`, `48-g5-backup.txt`) e remoção completa
  (`47-g3-remocao.txt`, `49-g5-remocao.txt`; a legenda dos números está no fim do `47`).
- **Permissões do backup** (`46b-permissoes-do-backup.txt`): o dump do banco e a pasta
  `backups/` seguem o umask de quem roda (`022` → `db-…-134008.sql.gz` `644` e `backups/` `755`;
  `077` → `600`/`700`); `waha-*.tgz` e `storage-*.tgz` saem `644` nos dois casos, porque são
  escritos pelo `tar` DENTRO do contêiner `alpine:3.20` (`hostgator-setup-kit/backup.sh:48-49` e
  `:66-67`), que não herda o umask do host. Quem lê o dump `644` depende também das pastas acima
  dele (não medido). Candidato a achado de kit (K5); não consertado aqui.
- **O que o leigo vê depois de "Restart Proxy"** (G4, captura `ui-coolify-proxy-restart-6.png`,
  fora desta pasta): o modal "Proxy Startup Logs" com "Waiting for the process to start…" e a
  nota de que a conexão pode cair durante o restart, e por cima o aviso vermelho **"Cannot connect
  to real-time service"** (com "Acknowledge & Disable") e "No notifications enabled". A rota do
  banco voltou sozinha mesmo assim (`44-g4-single-server-atras-do-coolify.txt`).

### Memória — o número publicado é o SEM swap (remedição); o com swap (Fase F) é nota

Régua: `MEM USAGE` do `docker stats`, maior soma num mesmo instante por grupo; máquina = `used`
do `free -m`. Sem swap: `64-resumo-sem-swap.txt` (bruto em `r60/`); com swap: `resumo.txt`.

| Janela | Sem swap (18:36–18:49Z) | Com swap ligado (15:31–16:12Z) | Diferença (sem − com) |
|---|---|---|---|
| Repouso sem canal: coolify / supabase / crm | 506 / 1203 / 793 MiB | 203 / 629 / 364 MiB | +303 / +574 / +429 |
| Repouso sem canal: máquina `used_max` | 2615 MiB (1ª amostra; as outras 9: 2585–2605) | 1531 MiB (1ª amostra; as outras 9: 1498–1520) | +1084 |
| Conversa: coolify / supabase / crm | 590 / 1331 / 862 MiB | 368 / 569 / 446 MiB | +222 / +762 / +416 |
| Conversa: soma dos três no mesmo instante | 2741 MiB (18:43:58Z) | 1362 MiB (`resumo.txt`, régua 2) | +1379 |
| Conversa: máquina `used_max` (o **mínimo** da regra) | **2815 MiB** (18:45:59Z; faixa 2696–2815) | 1688 MiB — a 1ª amostra, no segundo do `docker run` do runner; a 2ª 1496; as outras 46 1370–1466 | +1127 (contra a 2ª amostra, 1496: +1319; contra a faixa das outras 46, 1370–1466: +1349 a +1445) |
| Conversa: máquina `available_min` | 4430 MiB | 5836 MiB | −1406 |
| `memory.peak` (com cache, desde a subida): supabase / coolify | 2106 / 997 MiB | 1828 / 1019 MiB | +278 / −22 |
| Repouso com canal | NÃO MEDIDO sem swap | 225 / 532 / 379 MiB, máquina 1360 (sessão em `FAILED`) | — |

A diferença mistura o swap com o que mais mudou entre as duas medições: outra instalação (a da
G5, em vez da U1, com o onboarding refeito) e a sessão do WhatsApp em `SCAN_QR_CODE` (na F,
`FAILED`). Quanto dela é do swap: NÃO MEDIDO. OOM do kernel nas janelas: 0 nas duas medições
(remedição: desde o `swapoff`, `64`); contêineres nossos com OOM ou reinício: 0; `Restarting`: 0.
Disco (F4 Passo 2 da F, `versoes-antes.txt`): imagens 19,84 GB no Docker (todas, inclui
Coolify e terceiros), banco + anexos 105 MiB.

**Decisão 8 GB × 16 GB: 8 GB** (`67-decisao-corrigida-8gb.txt`). A regra do plano somava o
`memory.peak` INTEIRO do Supabase e do Coolify por cima de um mínimo que já contém o residente
deles — a mesma memória duas vezes (erro da regra, do controlador; não da medição). Sem a dupla
contagem: 2815 + 1774 + (2106 − 1322) + (997 − 509) = **5861 MiB ≤ 6348 MiB → 8 GB**, com folga
de 487 MiB até o limiar e ressalvas que puxam o número para cima (processos de outras sessões no
`used`, `memory.peak` desde a subida, folga até o teto do `mem_limit`).

Resultado literal da regra como estava escrita (`65-decisao-8gb-16gb.txt`), mantido para registro:
recomendado = mínimo + folga até os `mem_limit` do CRM + `memory.peak` do Supabase e do Coolify
= 2815 + 1774 + 2106 + 997 = **7692 MiB (7,51 GiB) > 6348 MiB** (80% de 7,8 GiB) → **16 GB**;
8 GB ficou no limite. A mesma regra sobre os números com swap também dá 16 GB:
1688 + 2124 + 2847 = 6659 MiB, ou 6467 MiB trocando o 1688 (o segundo do `docker run`) pela 2ª amostra (1496).
A "leitura A" de `resumo.txt` (somar só a folga até o peak, → 8 GB) não é a regra do plano e
não vale. Máquina inteira sem swap: medida (acima). VPS de 4 GB: NÃO MEDIDA.

**Correções de leitura** a arquivos desta pasta (o arquivo fica como foi gravado):

- `21b-*`: a observação do 503 foi repetida em t≈5/25/65/125 s (~2 min), não "4× em 60 s".
- **Fase E, fora do plano:** além da recriação com um `-f` só que a E2b pede, houve uma 2ª
  recriação com um `-f` só às 14:53:59Z, que deixou o CRM sem a rede do Supabase até 14:56:31Z
  (horas da correção do controlador no ledger; no arquivo: `FALHOU` a partir de 14:53 e
  `app StartedAt=…14:56:33Z`, `24-e6-scheduler.txt`).
- `24-e6-scheduler.txt`: o `8` da linha 3 está errado; a soma por minuto da mesma página dá
  **63** `FALHOU` na Fase E, todos causados pelas sabotagens da própria fase: **8 na E2b**
  (14:53–14:56Z: 1+5+1+1, incluindo o acidente das 14:53:59Z acima) e **55 na E7 Passo 6**
  (15:00–15:08Z: 8+7+6+6+6+13+7+2). O `0` vale para as janelas limpas `14:38–14:52Z` e
  `15:09:30–15:15:22Z`. As 6 de "14:57:30–15:00:30Z" são das 15:00:0x, já dentro da sabotagem.
- `resumo.txt`, F4 Passo 3: (1) o mínimo `1688` é a 1ª amostra da conversa, no segundo do
  `docker run` do runner (ver seção 3); (2) a "régua 3" (`1688 + 1611 = 3299`) soma números de
  instantes diferentes (16:05:51Z e 16:26:59Z, este depois da janela) e não é um limite superior
  medido; (3) a decisão "NÃO TOMADA" foi tomada depois: 8 GB (acima, `67-*`); (4) a linha 97
  ("Durante as janelas o swap tinha ~1,6 GiB em uso") é falsa como está: a 1ª leitura do swap é de
  16:22:46Z e a gravada de 16:26:59Z, as duas depois da F3 (que terminou 16:12:30Z).
- `40-antes-da-faxina.txt`: são 4 volumes e **28 imagens** (32 linhas de nomes ao todo), mais
  dois números (arquivos em `volumes/` e KB de `db/data`).
- `versoes-depois.txt` (U1) é filtrado: 44 linhas contra as 45 de `versoes-antes.txt` antes do
  bloco "F4 Passo 2"; as 23 linhas de contêiner (nome, imagem, revision, id) são iguais,
  e na lista de digests falta a linha de `postgres:15-alpine`. O "IGUAL" da U1 vale para as
  linhas de contêiner. A remedição comparou o arquivo inteiro (`63`).
- **Crontab do host depois do `update.sh` (U1):** o mesmo conjunto de linhas que antes
  (comparado com `sort`), em outra ordem (achado do revisor da Fase F; o mecanismo da troca de
  ordem não foi medido); a frase "igual ao de antes" do ledger vale para o conjunto, não para a
  ordem. Aquela instalação foi removida na G3;
  não remedido. Na instalação atual (G5), o crontab é igual byte a byte ao `crontab.antes` da
  remedição (`diff` exit 0, 19:0xZ).

**Afirmações SEM arquivo nesta pasta** (só no ledger do PR 4, saídas de terminal não gravadas):
a sessão em `SCAN_QR_CODE` às 15:37:49Z (F2); `event_log:done 3` na checagem de ~15:40Z, antes
da conversa da F3; o status do GitHub nas Fases F–H (o lido na correção está em
`52-h2-varredura-de-segredos.txt`); os avisos de início e fim de janela às outras sessões. A
dona do `/swapfile` (seção 2) vem de mensagem ao controlador.

**NÃO MEDIDO nesta versão:**

- Repouso com canal sem swap (F2 não remedida); VPS de 4 GB.
- WhatsApp com número real (F5): não medido. A IA ficou **desligada** (o single-server instala
  sem chave): a conversa mede ingestão, banco e scheduler pelo `event_log`, não o agente.
- Faxina do Coolify pela tela (G1 Passo 2): **medida depois** — ver "G1 Passo 2 e G6" abaixo.
- Reboot e fechamento persistente do painel (G6): **medidos depois** — ver "G1 Passo 2 e G6"
  abaixo. O fechamento por IPv6 foi aplicado, mas segue NÃO MEDIDO de fora (sem IPv6 público).
  Nesta VPS essas portas chegaram PÚBLICAS (`11-portas-antes-do-proxy.txt`); até a G6 ficaram
  fechadas por uma regra `DOCKER-USER` temporária (IPv4), que não sobrevive a reboot.
- Atualizar para uma versão MAIS NOVA pelo caminho do guia e atualizar pela tela: não medidos.
- Restaurar um backup: não medido. Levar o backup para fora da VPS: não medido.
- Os avisos "Attention required" do servidor e do item "Proxy" no painel do Coolify, e o selo
  "Update available": vistos, não investigados.
- Supabase Cloud com Coolify (o guia cita como alternativa) e Caddy puro: não medidos aqui.
- As causas dos 2 vermelhos do `test:shell` (falham também na `main`).

## 5. O que NÃO está nesta pasta

Os logs completos dos instaladores (mesmo mascarados), a ficha crua da VPS (`00-*`: hostname,
MAC, chaves autorizadas), os scripts de janela e de SQL, e as capturas de tela. As capturas que
o guia usa estão em `docs/saas/`.

**Varredura de segredo desta pasta** — rodada na Fase H2 (~18:00Z) e de novo depois da
correção (~19:1xZ); a segunda, com o status do GitHub lido na hora, está em
`52-h2-varredura-de-segredos.txt`.

- NA VPS: a sonda `vazamento.sh` rodou sobre a concatenação de todos os arquivos, contra os
  segredos da instalação viva e das duas cópias guardadas: todas as contagens de VALOR `=0`
  (136 na H2). Controle positivo no mesmo minuto: a linha `OWNER_PASSWORD` do `.env` plantada
  num arquivo temporário `600` (triturado depois) dá `=1` nas fontes que guardam essa senha.
- **A sonda acha o próprio texto deste README:** a linha `padroes=` da sonda NA VPS dá `1`, e
  esse 1 é a regex dela transcrita na seção 3 (casa o prefixo da chave secreta do Supabase
  escrito na própria regex), não um valor. Vale também
  para a busca ampla local (`eyJ…`, `sk-…`, `postgres://`, `service_role`, `Bearer`, `_KEY=`,
  `SECRET=`, `password`): 53 na H2 antes do README, 57 depois dele, 62 depois desta correção e 63
  depois de gravar o `52` (a linha do controle positivo cita o nome da senha do dono); os acertos são NOMES de
  segredo nas linhas `NOME=contagem` das saídas da sonda (`OWNER_PASSWORD=0`,
  `SUPABASE_SERVICE_ROLE_KEY=1`…), a palavra `password` em mensagens de erro
  (`Permission denied (publickey,password)`, `password authentication failed`) e o texto deste
  README; nos padrões de VALOR (`eyJ…`, `sk-…`, prefixo da chave secreta do Supabase, `postgres://`,
  `Bearer `), só as
  linhas deste README que os citam (4 depois desta correção: a regex da seção 3 e as que listam
  os padrões nesta seção). Os números da correção estão no `52`.
- O "Esperado `0`" do plano para a busca ampla era inatingível nesta pasta (ela guarda, por
  desenho, as linhas `NOME=contagem` da sonda). **RATIFICADO** pelo controlador do PR 4: vale a
  distinção sem imprimir valor (zero nos padrões de valor fora do README, sonda de valor `=0`
  NA VPS, controle positivo `=1`).
- O 32-hex (o `webhook_path_token`) deu `0` (controle positivo `1`); as senhas locais
  (`coolify-admin.pass`, `owner.pass`), `0`.
- Ressalva: os segredos da C2 e da r1a não existem mais na VPS (as árvores foram removidas),
  então os arquivos dessas duas tentativas foram conferidos só na hora da gravação, quando a
  sonda deu `0` na cópia mascarada.

## G1 Passo 2 e G6 (2026-10-07, 19:54Z–20:03Z)

Medidos pelo controlador, segurando o `flock` da bancada do começo ao fim (lock às 19:54:12Z),
com zero processo de teste e zero contêiner de outra sessão conferidos imediatamente antes.

- **Faxina pela tela** (`71`, `72`, `73`): roteiro `coolify-cleanup` com *Unused volumes* e
  *Unused networks* em **Keep**. Execução registrada pelo próprio Coolify às 19:55:40Z
  (`success`). Volumes: iguais (4). Banco: iguais (194 tabelas em `public`, 1 usuário,
  1 empresa, 5 mensagens). Saíram só imagens paradas: `alpine:3.20` (que o `backup.sh` usa e
  baixa de novo), `nginx:alpine`, `pgvector/pgvector:pg15` e `postgres:17-alpine` (estas duas
  de outras sessões da bancada, com o ok delas). Depois: raiz `307`, banco pelo domínio `200`.
- **A faxina automática já existe:** a mesma tela mostra *Cleanup frequency* `0 0 * * *` e uma
  execução às 00:00:03Z de 07/10, ou seja, o Coolify faz essa faxina sozinho todo dia, com as
  opções que estiverem escolhidas.
- **Fechamento persistente** (`74`): o bloco do guia deu `ipv4=3 ipv6=3` e o serviço `active`.
- **Reboot** (`75`): disparado às 19:57:17Z, boot às 19:57:44Z, ssh de volta às 19:58:24Z. Três
  minutos depois: `ipv4=3 ipv6=3`, serviço `active`, 23 contêineres (os mesmos de antes), 0 fora
  de `Up`; de fora, 8000/6001/6002 **fechadas** e 80/443 abertas; raiz `307`; banco pelo domínio
  `200`; banco com as mesmas contagens; painel pelo túnel `200`.
- **Ressalva:** foi o **primeiro** reboot da VPS desde 30/09 (antes de tudo ser instalado). "Volta
  sozinho" está medido **uma vez**, numa máquina recém-montada.
