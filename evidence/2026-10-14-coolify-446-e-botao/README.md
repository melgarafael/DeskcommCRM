# Coolify 4.4.6 e o botão "Atualizar agora" atrás do Coolify (14/10/2026)

Medição feita numa VPS de teste da HostGator (4 vCPU, 8 GB), com um domínio de teste do
tipo sslip.io. O IP e o domínio foram trocados por `<dominio-de-teste>` nos arquivos de texto.
Ela completa a de 07/10 ([`../2026-10-07-coolify-consumo/`](../2026-10-07-coolify-consumo/README.md)),
feita com o Coolify 4.3.23 e o CRM 1.76.0.

## 1. O comando fixado em 4.3.23 quebrou

- O `versions.json` do Coolify dizia `v4 = 4.4.6`. O `install.sh` entregue pelo site é
  sempre o mais novo e baixa os arquivos de configuração da 4.4. Nessa versão, o tempo real
  roda dentro do contêiner `coolify`, e o healthcheck consulta `127.0.0.1:6001/up`.
- `AUTOUPDATE=false bash coolify-install.sh 4.3.23` subiu a imagem 4.3.23 com essa
  configuração. O resultado foi
  `ERROR: Coolify container is not healthy after 60s. Status: starting`, o contêiner
  `coolify` (unhealthy), nenhum `coolify-realtime`, e o servidor `localhost` com
  `reachable=false`.
- Sem número de versão, o mesmo comando instalou a 4.4.6 em 41 s e terminou com
  `Coolify is ready!  Installed in 40.8s`.
- O Docker não foi reiniciado em nenhuma das duas instalações: o `daemon.json` já tinha o
  pool e a rotação de log que o instalador grava.

## 2. As telas da 4.4.6 (substituem `docs/saas/coolify-01` … `05`)

- Registro: os mesmos campos (Name, Email, Password, Password again), com um aviso novo,
  "Full instance access", e a regra de senha "at least 8 characters with uppercase,
  lowercase, number, and symbol".
- Assistente: Continue → This machine → caixa "Server is not reachable" com Port 22 →
  22022 e Check Again → Server e Connection marcados, tela "Project Setup" com
  Create "My First Project" e Skip setup.
- Skip setup leva ao painel, com o aviso "No notifications enabled"
  (`06-coolify-446-painel-depois-do-skip.png`).
- O `coolify-proxy` subiu sozinho cerca de 1 min 30 s depois do Check Again e ficou
  `(healthy)` 5 s depois.
- O bloco de fechamento do painel do guia deu `3` e `3`. De fora, as portas 8000, 6001 e
  6002 ficaram sem resposta.
- A 4.4.6 publica também a porta 8080 do proxy. De fora ela não respondeu (`000`), e o
  proxy roda com `--api.insecure=false`.
- Em repouso, numa única leitura, os contêineres do Coolify somaram cerca de 216 MiB.

## 3. Instalação do CRM (clone da tag v1.79.0, bloco do Passo 5)

- O kit instalou as imagens **1.80.0**, a última release, mesmo com o clone na v1.79.0.
- O primeiro pedido de certificado ao Let's Encrypt falhou com
  `acme: error … connection … Error getting validation data`. A porta 80 respondia de fora
  logo depois.
- Como o health do app falhou com `tls_recusado`, o instalador terminou com
  "Quase lá — falta o app responder" e mandou procurar chave no `.env`, que estava certo.
  O bloco de "Credenciais iniciais" não apareceu, mas o arquivo `.runtime/admin-credentials`
  existia.
- Depois de um restart do `coolify-proxy`, o certificado saiu cerca de 3 min depois do
  primeiro pedido e o health passou a `healthy`. Não se sabe se o restart foi necessário.
- Rodar o mesmo bloco de novo, com o certificado já emitido, terminou em 21 s com
  "✓ app no ar e saudável" e as "Credenciais iniciais". O dono não foi duplicado: 1
  organização e 1 usuário antes e depois.

## 4. O botão "Atualizar agora" (1.79.0 → 1.80.0)

A instalação foi levada à 1.79.0 com `update.sh --to v1.79.0 --force` (101 s, saudável).
Depois disso:

| Hora (UTC) | O que aconteceu |
|---|---|
| 19:55:40 | O rodapé mostra "Nova versão · 1.80.0"; a tela mostra "Versão 1.80.0 disponível" (`01-versao-disponivel.png`) |
| 19:56:34 | Clique em **Atualizar agora**: "Pedido enviado — esperando o servidor pegar" (`02-pedido-enviado.png`) |
| 20:00:00 | O agente do kit (cron a cada 5 min) roda `update.sh --to v1.80.0` |
| 20:00:42 | A tela mostra "Atualizando para a versão 1.80.0", com os passos (`03-atualizando.png`) |
| 20:00:37–20:01:03 | `/api/v1/health` responde `503`: cerca de 30 s fora do ar (`vigia-health.log`, uma leitura a cada 5 s) |
| 20:01:08 | `healthy`, versão 1.80.0 |
| 20:01:13 | "A atualização para a versão 1.80.0 terminou", ainda sem a confirmação do servidor (`04-terminou.png`) |
| 20:05:14 | "Você está na versão 1.80.0" (`05-na-versao-nova.png`) |

Conferido depois:

- as três imagens ficaram em `:1.80.0`;
- `API_GW_HTTP_PORT=8001` no `.env` do Supabase;
- o `api-gw` ficou nas redes `coolify`, `<projeto>-supabase_default` e `<projeto>_supabase`;
- o app ficou com `traefik.docker.network=coolify`;
- 1 organização e 1 usuário, como antes;
- `api/v1/cron/cobranca` no crontab do scheduler: 1;
- um backup novo em `backups/`.

## 5. A raiz do domínio responde 200

Desde 07/10/2026 (commit `3d9274e31`), `/` é a página inicial pública e responde
`HTTP/2 200`. O sinal de que o CRM está no ar é `/app`, que responde `HTTP/2 307` para o
login. O guia e o instalador passaram a usar `/app`.

## 6. Reversão

A VPS de teste voltou à linha de base guardada antes da medição:

- `authorized_keys` com o mesmo sha;
- nenhuma regra `ctorigdstport` no `DOCKER-USER`;
- crontab igual;
- nenhum contêiner, rede ou volume do Coolify ou do CRM;
- só as imagens desta medição removidas, por lista;
- logs com senha de teste apagados com `shred`.
