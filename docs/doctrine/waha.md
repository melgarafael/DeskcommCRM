---
type: doctrine
project: DeskcommCRM
---

# WAHA e anti-banimento

> Extraído **literalmente** do `CLAUDE.md` (seção «WAHA») para o arquivo de entrada caber no
> limite de 40k caracteres do Claude Code. O `CLAUDE.md` guarda a regra dura e aponta para cá;
> aqui mora o texto completo, com os motivos e as medições. Em divergência, vale **este** texto (é o original, copiado literalmente), e o resumo do `CLAUDE.md` é que se corrige.

- Imagem NOWEB pinada por arquitetura: `latest-2026.7.2` em x86 e `noweb-arm-2026.7.2` em ARM64. A prova local criou duas sessões CORE simultâneas até `SCAN_QR_CODE`; não prova pairing, duas contas `WORKING` nem envio. Não bloquear segunda sessão por tier: conferir resposta estruturada e pós-condição da operação.
- Engine NOWEB default; WEBJS apenas se precisar stickers animados / botões
- Auth: env do WAHA recebe **hash SHA512 hex** da api key; cliente envia plaintext em `X-Api-Key`
- Webhooks: HMAC SHA512 com `crypto.timingSafeEqual`
- Anti-banimento: throttle 1 msg/1.2s + jitter ≤800ms. Campanha 1 msg/5s. Warm-up 7-14d. Spinning de copy. Janela de disparo 7h-22h (domingo LIBERADO por default desde 2026-08-20; a janela é knob por canal). Janela de RESPOSTA por canal (0495, `channel_knobs.resposta_*`), que herda a de disparo quando vazia — só `inbound_turn`/`case_reply_turn` a leem
- STOP detection: a regra mora em `lib/opt-out/deteccao.ts` e é a MESMA nos dois lados —
  a ingestão (que grava `is_blocked=true`) e o runtime do agente. **Não é mais a palavra
  solta:** só bloqueia palavra ISOLADA (mensagem inteira = a palavra) ou verbo de cessação
  com OBJETO DE COMUNICAÇÃO ("parar de me mandar", "sair da lista"). Enquanto eram duas
  regras, a ingestão bloqueava paciente que perguntou "tem como parar a dor?" — medido em
  clínica, 12 falsos positivos num corpus de 32 frases de nicho.
  Cobre português e espanhol, nos dois níveis (inequívoco e ambíguo) — foi preciso um PR
  além do #275 (que só tinha coberto o vocabulário inequívoco) para o espanhol ganhar a
  camada ambígua e as construções com pronome preso ("escribirme"). Para ver o vocabulário
  em vigor sem confiar nesta linha:
  `sed -n '/PALAVRAS_DE_OPT_OUT/,/^]/p' lib/opt-out/deteccao.ts | grep -E '^ *"'`, e as frases de controle em
  `tests/unit/opt-out-deteccao.test.ts`.
  O Jev (`lib/ai/decisao/pedidos.ts`) só é perguntado onde esta regra disse não, e nunca bloqueia
  ninguém — no máximo abre um aviso na Central ("Avisar a equipe"): a regra continua a única que bloqueia
  (cerca: `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`).
- Mídia: subir pro Supabase Storage primeiro, passar URL ao WAHA (não inline base64)
- Multi-device: assinar `message.any` (não só `message`); tratar `fromMe=true` sem duplicar
- Grupos: entram **só os ligados** em Conexões › Grupos (`channel_session_groups`). O grupo ligado vira conversa `is_group` com um contato `kind = 'whatsapp_group'` que nunca entra em funil, lista, campanha ou IA; o remetente é `p.author` (nunca `p.from`), gravado em `messages.metadata.group_sender` (`lib/messaging/remetente-de-grupo.ts`). Para conversa de grupo o banco emite `message.group_received`, e não `message.received`, e o roteamento automático pula grupo. O filtro `ignore.groups` do WAHA é propriedade desta funcionalidade (`definirRecebimentoDeGrupos`); compatibilidade e convergência não o tocam. Spec: `docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md`
- Cron `recover-stuck-messages` (`app/api/v1/cron/recover-stuck-messages/route.ts`, agendado no `scheduler` do `docker-compose.prod.yml`): marca `status='sending'` há >5min como `failed` **e abre aviso na Central** (`agent_inbox_items` kind `message_send_stuck`). Não toca em `queued`: esse estado tem dono (no canal por QR, o resgate do watchdog; a mensagem da pessoa ou do agente que o canal mandou desacelerar, o `lib/messaging/reenvio-desacelerado.handler.ts` — quem são os donos, com o porquê, está na exceção da regra no `docs/business-rules/00-business-rules-catalog.md`), e falhá-lo perderia mensagem que ia sair. Mas não a deixa invisível: a `queued` vencida numa conexão que já voltou a WORKING vira aviso na Central (`avisarEsperaEsquecida`), sem mudar de status: 15 min para a que esperava a conexão, 50 min para a que pode ter nova tentativa agendada, e nenhuma acima de 24 h. Não reenvia — envio em dobro é pior que não-envio
