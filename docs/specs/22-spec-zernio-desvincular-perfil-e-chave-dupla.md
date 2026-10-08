# Spec 22 — Desvincular perfil social e chave dupla

Troca de conta no provedor (Zernio) medida em produção (VPS 1.74.0, 06/10/2026,
provado por API e tela): removeram a conta no provedor e recriaram — `accountId`
novo. A linha velha de `channel_sessions` ficou órfã (`FAILED` eterno, chave
velha) e a linha nova `WORKING`. A faixa do topo lia a velha, o cartão mostrava
a nova. Alívio aplicado na mão: DELETE da linha velha.

## Decisões do dono (fechadas, não reabrir)

| # | Tema | Decisão |
|---|---|---|
| D1 | Duas chaves | Manter as 2 chaves e sincronizar. NÃO unificar a leitura; envio/mídia/vigia intocados. |
| D2 | Desvincular | EXIGE zero canais sociais ativos (arquivar/excluir antes); nunca arquiva sozinho. |
| D3 | Sentido dos botões | "Desconectar conta" (`remove_account: true`) apaga a conta NO provedor; "Remover do atendimento" (`false`) só arquiva o canal. Não trocar o sentido. |

## Desenho das 2 chaves (CONFIRMADO por código)

- Perfil (`channel_integrations.credential_encrypted`) = gerenciar: ler contas,
  autorizar, webhooks, saúde. Lido por `readSocialIntegration`
  (`lib/channels/social/store.ts`).
- Cópia por canal (`channel_sessions.zernio_token_encrypted`) = fundos:
  sessão-primeiro com fallback ao env (`lib/channels/zernio/credentials.ts`,
  `resolveZernioCreds`; cópia do envio em `store.ts` de `connectSocialInbox`).
- `configureSocialIntegration` SEMPRE reescreve `zernio_token_encrypted` de TODOS
  os canais sociais da organização — **inclusive os arquivados**. Decisão: o
  arquivado pode voltar (ressurreição por reconexão) e uma cópia velha nele é a
  divergência que prende a faixa. Quando as cópias divergem da chave do perfil,
  o vigia marca FAILED para sempre; reconfigurar com a chave certa ressincroniza.
- Regressão travada em `lib/channels/social/sincronia.test.ts`: chave trocada no
  provedor → reconfigurar → nenhuma sessão velha prende a faixa.

## Superfície

### `GET /api/v1/channels/social` — órfã visível

Devolve `orphaned_channels`: canais sociais não arquivados cujo `account_id` não
está mais entre as contas do perfil (conta removida e recriada no provedor, ou
perfil trocado por fora). Item em snake_case:

```json
{ "channel_id": "uuid", "account_id": "hex24", "display_name": "...", "status": "FAILED" }
```

A tela mostra a seção "Canais sem conta no perfil" com **Excluir**, que chama a
ação `disconnect` (`remove_account: false`): apaga a assinatura no provedor pelo
id ou pela URL, como no #2412, arquiva e fecha os avisos. NÃO usa o
`DELETE /api/v1/channel-sessions/[id]`: ele não apaga a assinatura, que é por
chave e não por conta — ficaria viva entregando numa URL que vira 404. Se o
provedor já tiver apagado a assinatura com a conta, o 404 dele conta como
sucesso. Sem isso a faixa é eterna e a linha é inalcançável.
Quando não há integração configurada, a lista vem vazia (nada a comparar).

### `POST /api/v1/channels/social` — ação `unlink`

```json
{ "action": "unlink" }
```

- Apaga a linha de `channel_integrations` da organização. Nunca arquiva canal
  sozinho: se existir canal social ativo (não arquivado), recusa com 409 e a
  mensagem nomeia a saída — "Há canais sociais ativos. Arquive ou exclua os
  canais antes de desvincular o perfil." (INFERIDO o texto exato; o contrato é
  o 409 + o verbo arquivar/excluir).
- Fecha os avisos de saúde das sessões sociais da organização (best-effort, via
  `resolverSaudeDaConexaoRemovida`, mesmo contrato de `channel-sessions/[id]`).
- RBAC `admin` + `requireSupportWrite` + MFA em dívida, como as ações irmãs
  (`configure`, `inbox`, `disconnect`). `audit()` com
  `action: "channel.social_desvinculado"`, sem credencial no metadata.
- Sem migration: `channel_integrations` já tem `organization_id` como PK
  (migration 0368); o delete filtra pela org da sessão. RLS segue exclusiva de
  `service_role` (invariante `tests/invariants/social-native.test.ts`).

### Aba "Provedor parceiro" — erro que orienta

`validatePartnerCredentials` (`lib/channels/connect.ts`) lista `GET /v1/accounts`
SEM `profileId` (o caminho social usa `?profileId=` e funciona). Medido contra o
provedor com chave válida: sem perfil a lista vem `{"accounts":[]}`. Três saídas,
só com o que a resposta prova — sem adivinhar a forma do provedor (nesta ordem
no código: perfil primeiro, depois lista vazia):

| Resposta | Mensagem |
|---|---|
| o id colado é um perfil (confere em `GET /v1/profiles`, best-effort) | "Este id é de um PERFIL. Aqui vai o id da CONTA." |
| lista vazia | "A chave não lista nenhuma conta. Confira o perfil e a conta no painel do provedor." |
| lista com contas, sem a pedida | "Conta fora do alcance desta chave. Confira se a conta pertence ao perfil desta chave." |

## Fora do escopo (limite de produto, não bug)

Unificar a leitura das chaves; inbox de Google Business e redes sem `inbox: true`.

## Sistema vivo

Entrada: perfil vinculado, canais, chave do operador. Saída: faixa verdadeira,
perfil trocável, erro que diz o que corrigir. Porta: aba Redes sociais + aba
Provedor parceiro. Registro: auditoria de `unlink`/`disconnect`, sem segredo.
Recuperação: órfã excluível, reconfiguração ressincroniza, `disconnect` mantém o
canal intacto se o provedor recusar. Retorno: 409 com saída quando há canal ativo.

## Fontes verificadas

- `lib/channels/social/store.ts` (`configureSocialIntegration`, `socialChannels`, `disconnectSocialAccount`)
- `lib/channels/connect.ts` (`validatePartnerCredentials`)
- `lib/channels/zernio/credentials.ts` (`resolveZernioCreds`)
- `app/api/v1/channels/social/route.ts`, `app/api/v1/channel-sessions/[id]/route.ts`
- https://docs.zernio.com/accounts/list-accounts
