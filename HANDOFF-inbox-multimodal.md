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
| 0 — Fundação mídia (Storage + MediaSource + signed URL) | 🛠 em execução (T3/7 ✅) | T1: bucket `whatsapp-media` criado (migration **0055**, não 0054 — branch irmã reivindicou o número) e aplicado no banco dev via `supabase db query --linked`; prova SQL: `public=false, file_size_limit=52428800`. Review spec ✅ + quality approved. |
| 1 — Render real na UI | ⏳ aguarda 0 | — |
| 2 — Composer WhatsApp (anexo/áudio/emoji) | ⏳ aguarda 0-1 | — |
| 3 — Agente multimodal (vision/transcrição/PDF/vídeo) | ⏳ aguarda 0 | — |
| 4 — Split de mensagens | ⏳ | — |
| 5 — Toolkit vendedor (templates, draft IA, notas, snooze) | ⏳ | — |

## Próximo passo exato

Escrever o plano de implementação da Onda 0 (skill writing-plans) e executar com
prova Playwright: mídia inbound real (imagem/áudio enviados de um WhatsApp real
pra conta de teste) baixada do WAHA → Storage → signed URL servida.

## Decisões e problemas

- (registrar aqui a cada avanço)

## Log de sessões

- **2026-07-21** — Brainstorming + design mestre aprovado e commitado (`6e596ac`).
  Handoff criado. Nada implementado ainda.
- **2026-07-21 (exec Onda 0)** — Worktree `.claude/worktrees/feat-inbox-multimodal`
  (branch `feat/inbox-multimodal`, base `a480193`), baseline 335 testes verdes.
  T1 concluída (commit `98d78a2`). Aprendizado: aplicar SQL em `storage.*` no dev
  = `supabase db query --linked` (MCP exige OAuth; role `agent_worker` sem grants).
