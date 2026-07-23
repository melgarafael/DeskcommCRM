# Design — Inbox Multimodal + Agente de Vendas (épico em 6 ondas)

**Data:** 2026-07-21
**Status:** Aprovado (design mestre). Cada onda gera seu próprio plano de implementação.
**Escopo:** Upgrade do Inbox + Agente de IA: mídia multimodal ponta a ponta, composer estilo WhatsApp, split de mensagens do agente e toolkit do vendedor.

---

## Contexto (estado atual do código)

- **Ingestão** (`lib/waha/ingest.ts:229`): grava só a `media_url` hospedada pelo WAHA. Nunca baixa o binário nem sobe pro Supabase Storage. As colunas `media_storage_path` e `media_size_bytes` de `messages` existem mas nunca são preenchidas.
- **Envio** (`app/api/v1/messages/_handler.ts:245`): o schema Zod já aceita `media_url`/`media_mime`, mas o handler descarta a mídia e envia só texto. `WahaClient` (`lib/waha/client.ts`) só tem `sendMessage` → `/api/sendText`.
- **UI** (`components/inbox/MessageBubble.tsx`): mídia vira `MediaPlaceholder` (ícone + label). `Composer.tsx` é só texto; botão de anexo existe desabilitado; sem emoji, sem gravação de áudio.
- **Agente** (agent-engine/"Vendaval", ativo em produção via `workers/agent-worker/main.ts`): mídia chega ao modelo como o literal `[image]`/`[audio]` (`lib/agent-engine/edge/crm/get-lead-context.ts:184`). Multi-bolha já é fisicamente possível (múltiplas chamadas da tool `send_message` por turno, cada uma passando pelo pacing anti-ban).
- **Abstração de canal**: `lib/agent-engine/channel-adapter.ts` já foi desenhada pra trocar WAHA pela Meta Cloud API sem tocar o runtime do agente. Cobre só o lado do agente; o caminho REST do inbox chama WAHA direto.

## Decisões registradas

1. **Transcrição plugável, API como default.** Interface `TranscriptionProvider`; default = API speech-to-text (Whisper/Groq, BYOK como os demais providers); `mlx-whisper` como backend opcional para self-host em Apple Silicon (MLX não roda na VPS Linux de produção).
2. **Vídeo atrás de flag por agente, off por default** (caminho mais caro: ffmpeg + frames + transcrição).
3. **Execução: ondas 0→5 em sequência**, cada uma com spec/plano próprio, sem repriorização no meio.

---

## Onda 0 — Fundação: mídia normalizada e persistida

O ponto único de adaptação para a futura API oficial da Meta é o normalizador por provider:

```
WAHA webhook ──┐
               ├─→ MediaSource do provider ─→ MediaObject canônico ─→ Storage + messages
Meta webhook ──┘      (futuro)
```

- **Interface `MediaSource`** em `lib/messaging/media/`: `fetchMedia(ref) → { buffer, mime, filename? }`. Impl. WAHA baixa da `mediaUrl`; impl. Meta (futura) baixa via `media_id` + Graph API. O resto do sistema só conhece o `MediaObject` normalizado (`storage_path`, `mime`, `kind`, `size`, `filename`).
- **Fluxo assíncrono**: ingestão continua leve (grava `media_url` como hoje) e emite `media.persist_requested` no `event_log`. Worker consome, baixa o binário, sobe pro bucket privado `whatsapp-media` em `{org_id}/{conversation_id}/{message_id}.{ext}`, preenche `media_storage_path` + `media_size_bytes`. Estado em `metadata.media_status` (`pending` → `stored` | `failed`) com retry.
- **Acesso do frontend**: `GET /api/v1/messages/{id}/media` valida auth/org e devolve signed URL (TTL 1h). Fallback: se o binário ainda não está no Storage, proxy/fallback pra URL do WAHA. A UI nunca consome URL do WAHA diretamente.
- Migrations: doutrina do repo (arquivo versionado + apêndice idempotente no `baseline.sql` + linha no MANIFEST).

## Onda 1 — Renderização real na UI

`MessageBubble` ganha `MediaRenderer` por tipo, substituindo o placeholder:

- **Imagem**: thumbnail na bolha + lightbox no clique.
- **Vídeo**: `<video controls>` com poster.
- **Áudio/PTT**: player estilo WhatsApp — play/pause, progresso, velocidade 1x/1.5x/2x.
- **Figurinha**: inline ~128px, sem bolha.
- **Documento**: card com nome, tamanho, botão de download.

Signed URLs obtidas do endpoint da Onda 0, cacheadas via React Query com staleTime menor que o TTL. Só leitura — sem mudança de backend além da Onda 0.

## Onda 2 — Composer estilo WhatsApp

- **Botão "+"**: menu de anexos (foto/vídeo, documento). Upload → endpoint próprio → Storage → envio referencia o `storage_path`. Preview com caption antes de enviar.
- **Gravação de áudio**: `MediaRecorder` (opus), UX WhatsApp — gravar com timer, cancelar, enviar como PTT.
- **Emoji picker**: biblioteca lazy-loaded (carrega só ao abrir), com busca, categorias e recentes.
- **Backend**: `WahaClient` ganha `sendImage`/`sendVideo`/`sendFile`/`sendVoice`; `sendMessageHandler` para de descartar mídia. Payload outbound passa pelo formato normalizado (mesma costura que servirá a Meta).
- Regras existentes preservadas: mídia sobe pro Storage primeiro e o WAHA recebe URL (nunca base64 inline).

## Onda 3 — Agente multimodal

**Requisito central: MODEL-AGNÓSTICO.** O agente deve funcionar com Claude, OpenAI e Gemini — e ser universal, de forma que qualquer modelo novo plugado no sistema funcione sem código novo. A arquitetura tem DUAS camadas:

1. **Camada universal (funciona com QUALQUER modelo, presente ou futuro) — derivado textual.** Um worker de derivação roda após a persistência da mídia e grava `media_derived_text` na linha de `messages`. Áudio→transcrição, PDF/documento→texto extraído, imagem→descrição por visão, vídeo→transcrição da faixa + descrição de frames. Como o derivado é **texto puro**, ele entra no contexto do agente (histórico + turno) e QUALQUER modelo o lê — é a garantia de universalidade. `get-lead-context.ts` troca `[image]`/`[audio]` pelo derivado.

2. **Camada de aprimoramento (por-modelo, capability-gated) — parte nativa.** Para a mídia do turno CORRENTE, se o modelo configurado é conhecido por aceitar a modalidade nativamente, anexa-se também a content part nativa da AI SDK (`{type:'image', image}` / `{type:'file', data, mediaType}`) para fidelidade máxima. O seam `run-model-call.ts` já passa `ModelMessage[]` cru e a AI SDK v7 normaliza as parts para Claude/OpenAI/Gemini — ponto de injeção único: `inbound-turn.ts` (onde nasce `openingMessages`). Modelo desconhecido → sem parte nativa, o derivado já cobre (nunca quebra).

**Peças da universalidade:**
- **Provider registry** (`lib/agent-engine/edge/llm/providers.ts`): registrar `openai` e `google` ao lado de `anthropic` (uma linha cada; deps `@ai-sdk/{openai,google}` já instaladas). BYOK (`ai_provider_credentials`) já aceita os três no check.
- **Capability registry** (novo, declarativo): mapa por provider/prefixo de modelo → `{ image, pdf }`. Default conservador (modelo desconhecido = só derivado). Estender = uma linha; nunca quebra por construção.
- **`TranscriptionProvider` plugável** (decisão 1): default = API speech-to-text via credencial BYOK (OpenAI Whisper / Groq); `mlx-whisper` opcional em Apple Silicon. O derivado é texto → alimenta qualquer modelo de chat.
- **Derivação usa a mesma resolução BYOK** (`resolveOrgLlmConfig`) e o capability map p/ escolher um modelo de visão do tenant — model-agnóstica de ponta a ponta.

| Tipo | Camada universal (derivado) | Aprimoramento nativo (se capaz) |
|---|---|---|
| Imagem | Descrição por visão (modelo do tenant) | `{type:'image'}` no turno |
| PDF | Texto extraído | `{type:'file'}` no turno |
| Áudio/PTT | Transcrição (`TranscriptionProvider`) | — (nenhum provider aceita áudio nativo no chat hoje; derivado é o caminho) |
| Vídeo | Flag por agente, off default (decisão 2): ffmpeg → faixa de áudio (transcrição) + N frames (descrição) → derivado | — |

Corrida derivado × turno: aguardar com timeout curto; se estourar, o turno segue com o que houver (placeholder/parcial) e o derivado completo entra no próximo turno. Flag por-agente `multimodal_input` (nativo on/off) e `video_frames_enabled` em `ai_agent_versions`.

## Onda 4 — Split de mensagens configurável

- Config em `ai_agent_versions`: `split_messages: boolean` (+ estilo/tamanho alvo).
- Consumo no turno: instrução no prompt para responder via múltiplas chamadas `send_message` curtas. O pacing anti-ban existente já espaça cada envio com jitter humano.
- Fallback determinístico: textão acima de N caracteres é quebrado por parágrafo/sentença no handler da tool antes da entrega; cada parte passa individualmente pelo `before_send`.
- Zero infra nova.

## Onda 5 — Toolkit do vendedor

- **Templates de script**: tabela `message_templates` (RLS por org; `owner_user_id` preenchido = pessoal, `null` = compartilhado da org) com título, corpo, atalho e variáveis (`{{nome}}`, `{{primeiro_nome}}`). Na conversa: `/` no composer abre busca instantânea; CRUD completo em settings.
- **Resposta rascunhada pela IA**: draft aparece no composer, humano edita/aprova antes de enviar.
- **Notas internas**: anotações na conversa visíveis só pro time.
- **Lembrete/snooze**: "avisar se o lead não responder em X horas".
- Backlog (fora deste épico): mensagens agendadas, enquetes, GIFs no picker.

---

## Transversal (Definition of Done por onda)

- `typecheck`/`lint`/testes verdes; RLS testada em toda tabela nova; audit log em mutações; Zod em todo input externo.
- **Prova visível obrigatória**: teste real com Playwright em conta real a cada passo. Proibido reportar "funcionou" sem evidência observada (screenshot/output). O critério é "funcionou BEM" — experiência ruim identificada é bug e se corrige antes de reportar. Medidas de front por ferramenta (getBoundingClientRect/getComputedStyle), não a olho.
- **Handoff doc do épico** (`HANDOFF-inbox-multimodal.md` na raiz): lido no início de toda sessão, alimentado + commitado a cada avanço, teste, bug e correção.
- Referências de mercado (WhatsApp Web, Intercom etc.) como âncora de UX quando houver dúvida de comportamento.
- Toda mudança de schema: migration versionada + apêndice no `baseline.sql` + MANIFEST.
- Nada de HTTP em trigger Postgres — side effects sempre via `event_log` + worker.
