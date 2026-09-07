# lib/waha/

> Placeholder. Cliente real virá da Spec 03 — WhatsApp via WAHA Plus.

Escopo previsto:

- `client.ts` — wrapper HTTP do WAHA (auth via `X-Api-Key` plaintext; nunca query string)
- `signature.ts` — verificação HMAC SHA512 dos webhooks com `crypto.timingSafeEqual`
- `throttle.ts` — anti-banimento (1 msg/1.2s + jitter ≤800ms; campanha 1 msg/5s)
- `stop-detection.ts` — regex `/STOP|PARAR|SAIR|UNSUBSCRIBE/i`
- `media.ts` — upload pro Supabase Storage primeiro, URL ao WAHA
- `types.ts` — tipos canônicos de payloads WAHA (Zod-validados)

## Regras críticas (Spec 03 — adiantadas aqui)

1. Auth: env do WAHA recebe **hash SHA512 hex**; client envia plaintext em `X-Api-Key`
2. Engine NOWEB default; subscrever `message.any` (não só `message`); tratar `fromMe=true` sem duplicar
3. Grupos: SKIP CRM binding se `chatId.endsWith("@g.us")`; sender é `p.author`
4. Idempotência: `unique (organization_id, external_id)` + captura `code === "23505"`
5. Cron `recover-stuck-messages`: `status='sending'` há >5min → `failed`

## Sessões e reserva local

`lib/channels/connect-waha.ts` reserva a identidade por organização e Idempotency-Key antes de criar/iniciar remoto. Erro desconhecido 409/422 não é sucesso; o cliente exige envelope conhecido, identidade exata e pós-condição. Falha preserva FAILED e a identidade; nova tentativa reutiliza a mesma sessão via reserva. Não há compensação destrutiva automática. `tier=CORE` não implica limite de uma sessão; a prova 2026.7.2/NOWEB chega somente a duas SCAN_QR_CODE, sem pairing ou envio.
