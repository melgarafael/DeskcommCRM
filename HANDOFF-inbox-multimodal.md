# HANDOFF — Épico "Inbox Multimodal + Agente de Vendas" (6 ondas)

> ⚠️ **INSTRUÇÃO PERMANENTE (não remover):** ler no INÍCIO de toda sessão que
> trabalhe neste épico; ATUALIZAR + COMMITAR ao final de CADA avanço, teste, bug
> encontrado e correção. Regras do Rafael:
> 1. Progresso só conta com PROVA VISÍVEL — teste real com Playwright em CONTA
>    REAL. É PROIBIDO relatar "funcionou" sem isso.
> 2. O critério não é "funcionou", é "funcionou BEM". UX ruim = bug: corrigir
>    antes de reportar. Medidas de front por ferramenta, não a olho.
> 3. Se precisar: criar contas, usar MCP, pedir credenciais ao Rafael.
> 4. graphify é obrigatório antes de ler código-fonte (`graphify query "..."`).
>    Buscar referências de mercado (WhatsApp Web, Intercom…) pra ancorar UX.

## Contexto fixo

- **Épico:** mídia multimodal ponta a ponta no inbox + agente, composer estilo
  WhatsApp, split de mensagens do agente, toolkit do vendedor.
- **Spec mestre:** `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md`
  (aprovado 2026-07-21). Execução: ondas 0→5 em sequência, cada onda com plano próprio.
- **Decisões:** transcrição plugável (API BYOK default, mlx-whisper opcional em
  Mac); vídeo atrás de flag por agente (off default); mídia sempre persistida no
  bucket `whatsapp-media` (UI nunca consome URL do WAHA direto).
- **Pontos de código âncora:** ingestão `lib/waha/ingest.ts` (media_url só);
  envio `app/api/v1/messages/_handler.ts` (descarta mídia hoje); UI
  `components/inbox/{MessageBubble,Composer}.tsx` (placeholder/só texto); agente
  `lib/agent-engine/edge/crm/get-lead-context.ts:184` (mídia vira `[image]`);
  abstração futura Meta: `lib/agent-engine/channel-adapter.ts`.
- **Evidências:** `.superpowers/evidence/inbox-multimodal-*.png` (gitignored).

## Estado atual

| Onda | Status | Prova |
|---|---|---|
| 0 — Fundação mídia (Storage + MediaSource + signed URL) | ✅ COMPLETA (7/7 + review final ready-to-merge) | E2E REAL provado 2026-07-21: WhatsApp "Lia" +5511 4863-3324 conectado por QR; Rafael enviou imagem/áudio/vídeo/PDF/figurinha reais → 5/5 ingeridos com tipo certo, worker persistiu no bucket (SQL: `media_status='stored'`, bytes corretos, path `{org}/{conv}/{msg}.{ext}`); endpoint 302→signed URL 5/5 com content-type certo (~800ms), cross-org 404. Evidências: `.superpowers/evidence/inbox-multimodal-onda0-{inbox,endpoint}.png`. T1: bucket via migration **0055** (0054 tomado por branch irmã). |
| 1 — Render real na UI | ✅ COMPLETA (review final ready) | E2E real 2026-07-21: 5/5 mídias RENDERIZADAS na conversa real; áudio tocou (currentTime 1.41s, 1.5x no clique), vídeo 103.9s, lightbox Esc ok; medidas por getBoundingClientRect: img 256×192 (4:3), sticker 160×160, audio 240×44, video 384×216 (16:9), zero overflow; 391+ testes, tsc/lint 0. Evidências: .superpowers/evidence/inbox-multimodal-onda1-{thread,lightbox}.png. Forward Onda 2: alargar hasMedia p/ media_storage_path. |
| 2 — Composer WhatsApp (anexo/áudio/emoji) | ✅ COMPLETA + confirmada no celular do Rafael | T1 upload storage-first (guard DoS); T2 backend via signed URL 600s + wahaSendPlanFor (review matou IDOR cross-tenant); T3 anexos+preview+caption; T4 gravador PTT (mic liberado sempre); T5 emoji-mart lazy pt-BR. Prova CRM→WAHA: 5/5 enviados (imagem+caption, PDF, texto, 👍 do picker, áudio gravado) → Rafael CONFIRMOU no celular: tudo chegou, **áudio como MENSAGEM DE VOZ** (convert:true funcionou no NOWEB Core — contingência ffmpeg NÃO necessária). Bug de ack destravado (ver Decisões). 421 testes, tsc/lint 0. Evidências: `.superpowers/evidence/inbox-multimodal-onda2-*.png`. |
| 3 — Agente multimodal (vision/transcrição/PDF/vídeo) | ⏳ aguarda 0 | — |
| 4 — Split de mensagens | ⏳ | — |
| 5 — Toolkit vendedor (templates, draft IA, notas, snooze) | ⏳ | — |

## Próximo passo exato

Iniciar Onda 3 (agente multimodal: vision em imagem, transcrição de áudio via TranscriptionProvider plugável, PDF nativo, vídeo atrás de flag). Base pronta: mídia já persistida no Storage (Onda 0) e servida por signed URL. Ponto de entrada: `lib/agent-engine/edge/crm/get-lead-context.ts:184` (hoje mídia vira `[image]`) — trocar por derivado textual + anexo nativo no model call.

## Decisões e problemas

- **Bug de ack destravado (2026-07-22, commit 6d807fd):** todo outbound travava em `sent`/ack=0 — o ack do WAHA 2026.x/NOWEB chega como `{fromMe}_{chatId}_{bareId}` mas o envio grava `external_id` = bareId (parseWahaMessageId extrai o id interno); `handleAck` casava por igualdade e nunca achava a linha. Fix: `bareWaMessageId` normaliza o ack à cauda antes do match (só no read-side; NÃO mexi no external_id de inbound, que é full e sustenta o dedup 23505). Pré-existente (afeta texto também), achado na prova E2E da Onda 2. Provado reenviando os 5 acks reais pelo webhook → status `read`/ack=3, UI com 5 checks "Lida".
- **Contingência de voz resolvida:** `sendVoice` com `convert:true` no WAHA NOWEB Core JÁ entrega como mensagem de voz (Rafael confirmou no celular) — a conversão OGG server-side (ffmpeg) NÃO é necessária na Onda 2.

- **T7/bugs reais do WAHA 2026.7.1 (2026-07-21, commits 131bea7+33bfc36):** a prova em conta real revelou que o payload NOWEB mudou: mídia em `payload.media.{url,mimetype}` (não `mediaUrl`), SEM campo `type` (inferir de `_data.message`: stickerMessage/imageMessage/…), `media.url` anuncia porta INTERNA do container (localhost:3000; no host é 3030). Fixes: `mediaUrlOf`/`mediaMimeOf`/`resolveMessageType` no ingest; `fetchWahaMedia` reconstrói a URL sobre `WAHA_API_BASE_URL` (path+query só — SSRF impossível por construção); `application/mp4`→`.mp4`. Mensagens de mídia pré-fix foram ingeridas como text vazio (limpas no dev; clones antigos não têm dados a migrar — mídia nunca funcionou antes).
- **Dev/WAHA auth:** o `.env.local` precisava do HASH sha512 em `WAHA_API_KEY` (o client envia o hash; imagem Core compara literal) — corrigido no worktree. Sessão FAILED `org_6e567068_a3ec82` ficou órfã em Conexões (limpar depois).
- **T4/retry (2026-07-21):** o plano previa retry gerido pelo handler (`status:"retry"` + backoff próprio) — ERRADO contra o contrato real: `drain.ts` não conta attempt em `retry` (reservado a postpone benigno) → loop infinito. Decisão: worker retorna `status:"error"` sempre e o drain é dono de retry/backoff/dead-letter; worker marca `media_status:"failed"` só no último attempt (`row.attempts >= 4`, espelho do MAX_ATTEMPTS=5 do drain). Review pegou isso — o teste original passava porque bypassava o drain.

## Log de sessões

- **2026-07-21** — Brainstorming + design mestre aprovado e commitado (`6e596ac`).
  Handoff criado. Nada implementado ainda.
- **2026-07-21 (exec Onda 0)** — Worktree `.claude/worktrees/feat-inbox-multimodal`
  (branch `feat/inbox-multimodal`, base `a480193`), baseline 335 testes verdes.
  T1 concluída (commit `98d78a2`). Aprendizado: aplicar SQL em `storage.*` no dev
  = `supabase db query --linked` (MCP exige OAuth; role `agent_worker` sem grants).
