# Conectar a prospecção ao SearXNG self-hosted

O CRM pode usar o SearXNG da instalação sem publicar a busca para a internet. A integração usa uma rede Docker privada e dedicada que liga apenas o contêiner `app` ao serviço SearXNG.

## Requisitos

- O SearXNG já deve estar instalado em uma stack Docker independente.
- A rede Docker dedicada usa por padrão `dreamland-search-crm`, `172.31.253.0/29` e o IPv4 `172.31.253.2` para SearXNG. Escolha outro bloco privado se essa faixa já estiver ocupada e mantenha as variáveis iguais nas duas stacks.
- A porta 8080 do SearXNG não precisa ser publicada no host. O contêiner pode manter a rede de saída que usa para consultar motores de busca.

## 1. Conectar a stack SearXNG

Copie `deploy/searxng/docker-compose.crm-integration.yml` para a máquina que hospeda a stack. Na pasta que contém o `docker-compose.yml` atual do SearXNG, aplique ambos os arquivos:

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.crm-integration.yml \
  up -d searxng
```

Esse overlay acrescenta a rede privada `dreamland-search-crm` e o alias interno `searxng-search`. Ele não altera portas publicadas nem remove as redes existentes do SearXNG.

## 2. Conectar o app CRM

Na pasta de produção do DeskcommCRM, acrescente `docker-compose.searxng.yml` à invocação que já usa para iniciar ou atualizar o app. Por exemplo, numa instalação atrás do Tailscale:

```sh
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.tailscale.yml \
  -f docker-compose.searxng.yml \
  --env-file .env \
  up -d app
```

O arquivo `docker-compose.tailscale.yml` é específico da instalação. Preserve o override que a instalação já utiliza e acrescente somente o arquivo SearXNG.
Esse overlay seleciona a rota privada e zera `SEARXNG_BASE_URL` dentro do app. Assim, um endereço público antigo que ainda esteja no `.env` não conflita com a conexão Docker interna.

## Segurança da conexão interna

O provedor interno aceita somente `http://searxng-search:8080/` e exige que esse alias resolva exatamente para `SEARXNG_INTERNAL_IP`, que deve ser IPv4 privado. O `fetch` não segue redirecionamentos. A exceção não permite informar outro host, porta ou protocolo, não serve para URLs escolhidas por organizações e não muda a política das conexões externas. Se a validação de IP falhar, a busca é recusada.

Na stack CRM, o override define os valores padrão compartilhados pelas duas redes. Se o bloco padrão conflitar, defina `SEARXNG_DOCKER_SUBNET`, `SEARXNG_INTERNAL_IP` e `SEARXNG_DOCKER_NETWORK` de modo consistente antes de subir os dois overrides. Não reutilize um endereço que não pertença à sub-rede selecionada.

Para uma instância SearXNG externa, use apenas `SEARXNG_BASE_URL` em HTTPS e não carregue os dois overlays internos.
