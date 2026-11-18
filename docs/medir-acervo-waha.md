# Medição do acervo do WhatsApp (memória e disco) — issue #3377

## O que é

Quando uma conexão do WhatsApp tem "Guardar o histórico anterior à vinculação"
ligado (`noweb.store.enabled = true`, `fullSync = true`), o motor NOWEB do WAHA
guarda as conversas antigas do número dentro do contêiner do WAHA
(`/app/.sessions`, volume `waha-data`). O CRM importa esse acervo em lotes
(#3194). Ninguém sabia quanto isso custa num servidor com histórico grande —
este doc traz a régua e o que ela significa para os limites do compose.

O programa `scripts/medir-acervo-waha.ts` só lê: faz GET no WAHA, lê o disco
e, se houver `docker` onde ele roda, chama `docker ps`/`docker stats`.

## Como medir numa VPS do kit

O host do kit não tem Node, e o WAHA só é alcançável dentro da rede do
compose. A receita roda o programa num contêiner `node` descartável que
**compartilha a rede do WAHA** (`--network container:`) e **monta o volume do
store só-leitura** (`--volumes-from ...:ro`). Rode como root, na pasta onde o kit
instalou (`/opt/deskcommcrm` por padrão):

```bash
cd /opt/deskcommcrm
W=$(docker ps -q --filter label=com.docker.compose.service=waha)

# 1) memória do WAHA agora (uso / teto do mem_limit)
docker stats --no-stream --format '{{.Name}}: {{.MemUsage}}' "$W"

# 2) disco do store + sessões + mensagens
( eval "$(grep '^WAHA_API_KEY=' .env)"; export WAHA_API_KEY
  docker run --rm --network "container:$W" --volumes-from "$W:ro" \
    -v "$PWD/scripts:/medir:ro" \
    -e WAHA_API_BASE_URL=http://localhost:3000 -e WAHA_API_KEY \
    node:22-alpine npx -y tsx@4.23.15 /medir/medir-acervo-waha.ts ) > acervo-waha.json
echo "exit=$?"
```

O passo 2 avisa `docker indisponível aqui: memória do WAHA NÃO medida` — é
esperado: dentro do contêiner `node` não há Docker, e a memória vem do passo 1.
A chave é lida do `.env` e passada por variável de ambiente; ela não aparece na
saída.

**Exit 1 quer dizer que a medição está incompleta**, e o stderr diz o quê. O
programa não transforma consulta que falhou em contagem zero. Exemplo real,
provado na VPS de aulas com uma sessão caída:

```text
FALHA: GET /api/<sessão>/chats: HTTP 422: {"error":"Session status is not as expected. ...","status":"FAILED","expected":["WORKING"]}
store: 4 arquivo(s), 201769 bytes | waha 2026.7.2: 1 sessão(ões) · 0 mensagem(ns) | memória: NÃO medida
contagem INCOMPLETA: 1 consulta(s) falharam
```

Esse `0 mensagem(ns)` não é medida: a sessão precisa estar `WORKING`.

A contagem pagina **todos** os chats e mensagens de cada sessão, de 100 em 100.
Num acervo grande isso é carga de leitura no WAHA de produção; rode fora do
horário de atendimento. `--max-chats N` e `--max-msgs-por-chat N` limitam a
varredura, e quando o teto é atingido o programa avisa que a contagem é um piso.

### Fora do kit

Com Node no lugar, o programa roda direto (e acha sozinho o contêiner do WAHA
pelo rótulo do compose, se houver Docker):

```bash
WAHA_API_BASE_URL=http://localhost:3000 WAHA_API_KEY=... WAHA_STORE_DIR=/caminho/do/store \
  pnpm medir:acervo-waha
```

Variáveis: `WAHA_API_BASE_URL` (sem ela o modo é só-disco, e isso é dito),
`WAHA_API_KEY`, `WAHA_STORE_DIR` (padrão `/app/.sessions`; também aceita a pasta
como argumento), `WAHA_CONTAINER` (quando há mais de um WAHA) e `WAHA_PID` (mede
um processo por `/proc/<pid>/statm` em vez do contêiner).

## O que sai

Um JSON em stdout: `completa` e `falhas`, `store.{arquivos,bytes}`,
`memoria.{bytes,limiteBytes,origem}`, `waha.{versao,sessoes,mensagens,porSessao}`
e `crescimentoPor1000Mensagens.bytes` (= `store.bytes / mensagens * 1000`).

## Medido

Nenhuma medição de acervo grande foi feita ainda: a VPS de aulas onde a receita
foi provada tem uma sessão sem histórico e caída. A tabela fica vazia —
**não inventar número**. Preencha rodando a receita numa instalação real com
histórico ligado e a sessão `WORKING`, com exit 0.

| Grandeza                            | Valor medido | Comando que produziu |
| ----------------------------------- | ------------ | -------------------- |
| Memória do contêiner WAHA           | (vazio)      | passo 1 |
| Tamanho do diretório do store       | (vazio)      | passo 2, `store.bytes` |
| Número de sessões (números)         | (vazio)      | passo 2, `waha.sessoes` |
| Número de mensagens guardadas       | (vazio)      | passo 2, `waha.mensagens` |
| Crescimento por 1000 mensagens      | (vazio)      | passo 2, `crescimentoPor1000Mensagens.bytes` |

## O que isso significa para os limites do compose

Os `mem_limit` vêm de `docker-compose.prod.yml` (confira na fonte:
`grep -n mem_limit docker-compose.prod.yml`): `waha` 1280 MiB, `app` 768 MiB,
`worker` 512 MiB.

- O acervo mora no contêiner do **WAHA** (disco em `/app/.sessions` e memória
  do processo NOWEB). A memória do passo 1 se compara com os 1280 MiB do `waha`.
- O importe do histórico em lotes (#3194) roda no **`app`** (768 MiB), não no
  `worker`: é a rota `api/v1/cron/historico-import`, que o `scheduler` chama a
  cada minuto em `http://app:3000` (`docker/scheduler/entrypoint.sh`). Lotes
  grandes pressionam o `app`.
- O disco do store cresce com o histórico e não tem teto no compose (só o
  volume `waha-data`); `crescimentoPor1000Mensagens.bytes * (mensagens/1000)`
  é a régua para dimensionar o espaço livre.

Sem o número, mantém-se a decisão atual: histórico **desligado por padrão** por
conexão, e quem ligar assume o custo acima.
