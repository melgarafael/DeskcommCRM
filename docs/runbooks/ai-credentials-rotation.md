# Runbook — Rotação da AES key (`AI_CRED_AES_KEY`)

Aplica-se a `ai_provider_credentials.api_key_encrypted` (cifragem AES-256-GCM).
Plaintext da key BYO **nunca** sai do DB cifrado depois do POST de criação;
o que rotacionamos aqui é a **master key** que cifra essas BYO keys.

## Quando rotacionar
- Suspeita de exposição da `AI_CRED_AES_KEY` (vazamento de env var, leak de logs).
- Política de rotação anual (default).
- Saída de engenheiro com acesso ao `.env` da instalação.

## Pré-requisitos
- Acesso ao `.env` da instalação e à possibilidade de recriar os contêineres do CRM.
- `psql` direto ou Supabase Studio com service role.
- Janela de manutenção curta (≤5 min) ou estratégia online (descrita abaixo).

## Estratégia online (zero-downtime)
A migration introduz `api_key_encrypted_v2`, `api_key_iv_v2`, `api_key_tag_v2` e
um campo `key_version smallint`. O runtime tenta a v2 primeiro; se nula cai pra
v1. Backfill é feito por job que decifra com a key antiga e recifra com a nova.

> Esta estrutura **ainda não está implementada** — quando precisarmos rotacionar
> abrimos a migration. Por ora a ferramenta abaixo cobre o caso emergencial.

## Estratégia offline (manutenção curta — usar em emergência)

1. Tire a app do ar durante a janela, parando os contêineres do CRM. **Não há chave de
   manutenção no código:** a página `app/503/page.tsx` existe e é pública
   (`lib/auth/public-paths.ts`), mas nada no repositório coloca a instalação nela.
2. Gere a nova key local: `openssl rand -base64 32` → `NEW_AES_KEY`.
3. Mantenha a antiga em mãos como `OLD_AES_KEY`.
4. Rode o script de rotação (a ser implementado em
   `scripts/rotate-ai-cred-aes-key.ts` — não existe ainda; ver follow-up):
   ```bash
   AI_CRED_AES_KEY_OLD=$OLD_AES_KEY \
   AI_CRED_AES_KEY=$NEW_AES_KEY \
   pnpm tsx scripts/rotate-ai-cred-aes-key.ts
   ```
   O script:
   - SELECT id, provider, label, api_key_encrypted, api_key_iv, api_key_tag
   - Decifra com `OLD`
   - Cifra com `NEW`
   - UPDATE ai_provider_credentials SET ... WHERE id = $1
5. Atualize `AI_CRED_AES_KEY` no `.env` da instalação e recrie os contêineres — env var
   é lida no boot, então editar o arquivo sozinho não troca chave nenhuma. Quem recria
   tudo é `bash hostgator-setup-kit/update.sh`, que roda o `up -d` sem nomear serviço;
   à mão, o comando (e a armadilha dos **dois** `-f` num host com proxy reverso próprio)
   está em [`deploy.md`](deploy.md).
6. Suba os contêineres do CRM de volta.
7. Apague `AI_CRED_AES_KEY_OLD` de qualquer lugar persistido.

## Smoke test pós-rotação
- `GET /api/v1/ai/credentials` retorna a lista normal (não toca em decrypt).
- `POST /api/v1/ai/credentials/<id>/revalidate` retorna 200 e `validated_at` recente.
- Runtime de agent (S-13.08) consegue executar 1 run completa.

## Hardening contínuo

- Sentry `beforeSend` deve strippar campos sensíveis: `api_key`, `Authorization`,
  `x-api-key`, `AI_CRED_AES_KEY`. Verifique o init do Sentry e adicione regex se
  faltarem (a remoção genérica por path em request body já está em prod).
- Code review reject pra qualquer `console.log` que possa receber `api_key` ou
  ciphertext. `loadCredential()` retorna o plaintext com escopo curto — não
  passe o objeto inteiro adiante.
- `last4` é o único discriminador exposto na UI; nunca exponha `api_key_iv`,
  `api_key_tag` ou `api_key_encrypted` via API.

## Emergência: revogar uma key BYO
Se um cliente reportar que a key BYO dele vazou (não a master key):
- `DELETE /api/v1/ai/credentials/:id` ou flip `is_active=false` via DBA.
- Cliente roda fluxo normal de criação com nova key.
- A versão de agent que usa a credential deletada para de rodar (FK ON DELETE
  RESTRICT garante consistência — endpoint DELETE bloqueia se publicada).
