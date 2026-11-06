# Atendimento e follow-ups — bancada #3475

Prova sintética observada em 26/10/2026, no produto `20f335eaede5c423a0fcc902d79eaabb103ea342`, build de produção `cyznjcUkNaQa9Fn5H6iU4`. Banco Supabase próprio (PG15), GoTrue e Realtime reais, `baseline.sql` aplicado nos modos install e update com `ON_ERROR_STOP=1`, bootstrap-owner e contas de teste. Os seis cenários selecionados passaram em rodadas separadas; [relatório consolidado](relatorio-consolidado.json) aponta para os relatórios originais sem alterar seus estados.

| Jornada | Medição | Relatório |
| --- | --- | --- |
| Dossiê (#3455) | Viewer sem botão/POST403; outra org404; manager cancela dormente/coletando pela fila, estado e timeline imediatos, banco/evento/reload e tick sem despertar | [básico](run-basico/relatorio.json) |
| Inbox (#3407) | Parar no dormente; uma ocorrência cancelled_manual, inscrição cancelled e sem relógio; reload carregado oferece Iniciar, sem Parar | [básico](run-basico/relatorio.json), [recheck carregado](reload-carregado/relatorio.json) |
| Pausa (#3430) | Bearer real em nome de atendente, receiver HTTP, carimbo de cinco minutos; token puro não pausa e token sem escopo403. Cinco minutos reais aguardados, depois automático na tela | [básico](run-basico/relatorio.json), [recheck carregado](reload-carregado/relatorio.json) |
| Assinatura (#3424) | Automação e Prospecção pelos produtores reais, HTTP com provider controlado, mensagem persistida, assinatura exata no receiver WAHA e corpo no Inbox | [assinatura/admin](run-assinatura-admin/relatorio.json) |
| Avisos (#3426) | Quatro controles: filtro recusa/aceita, mídia sem texto e âncora atual do agente. JOIN Realtime confirmado antes do INSERT, toast positivo e ausência negativa, decisão autenticada e branch do consumer Web Push | [diagnóstico3 — somente avisos passou nesta rodada](run-diagnostico-3/relatorio.json) |
| ACK (#3469) | Envio UI→receiver; HMAC inválido não altera, HMAC real; read→ACK2/1/-1 preserva status/horas, failed+ACK1 mantém falha, ACK2/3 recupera, erro tardio não regride. Banco, indicadores e reload; orgB intacta | [básico](run-basico/relatorio.json) |

As capturas dos estados cancelados, Parar antes/depois, pausa/retorno, assinatura nos dois produtores, toast e ACKs foram inspecionadas. `evidence/atendimento-followups-3475/run-basico/inbox-dormente-parado.png` capturou a tela durante o carregamento; a ausência ali não é prova. O recheck `reload-carregado/` espera conversa, seção e seletor visíveis antes de conferir ausência e registrar a captura. A mensagem humana também está carregada no segundo registro. As imagens antigas ficam preservadas com esse limite.

## Bolha invisível: motor real e controle positivo

[Relatório](real-engine/relatorio.json), conversa invisível em `evidence/atendimento-followups-3475/real-engine/invisible-inbox.png` e controle legível em `evidence/atendimento-followups-3475/real-engine/valid-inbox.png`. A entrada veio por webhook WAHA com HMAC real; a pós-entrada emitiu o despacho e `drainTick` criou o job. `claimJobs`, `withServiceJob`, `createInboundTurnHandler` e complete/fail da fila são os mesmos do worker, executados uma vez, sem abrir os demais loops. A prioridade e o horário apenas do job sintético foram antecipados para selecionar esse caso na bancada.

O receiver do modelo emitiu `send_message` com um único U+200E (codepoint8206). Na segunda requisição HTTP, observou o resultado `corpo_vazio`. O traço canônico gravou `is_dry_run=false`, ferramenta falhou e zero mensagens; nenhum HTTP de envio WAHA nem linha outbound foi criado. Para limitar a tentativa, o provider devolveu **HTTP400 intencional depois da observação**: por isso o traço do turno é failed/AI_APICallError. Isso comprova a recusa e não comprova reescrita autônoma pelo modelo.

O controle legível do mesmo handler completou: uma ferramenta aceita, uma mensagem `sent`, um HTTP WAHA e assinatura exata do agente, com a bolha visível. A primeira formulação do controle tinha UUID cru e foi corretamente vetada por `internal_vocabulary_leak`; o texto do receiver foi corrigido, sem modificar ou relaxar o produto. `real-engine-attempt2-invisible.json` conserva a tentativa anterior.

O Testar agente **não** foi usado como prova dessa guarda: `applyPreviewPolicy` intercepta a tool e devolve simulated antes do execute. `llm-invisible-preview-attempt4.json` registra essa observação. A bancada também precisou do seed canônico `seedPlatformPlaybook`, normalmente executado no boot do worker, sem mover ponteiro existente.

## Limites e precondições corrigidas

- Provider LLM e transporte WAHA são receivers HTTP controlados; não são modelo externo nem WhatsApp real. Não há stub de runtime, mock de SQL ou substituição do handler. Não se reivindica FCM/Push entregue: nenhum envelope criptográfico foi recebido/decifrado.
- Nos avisos, os quatro casos medem o INSERT/Realtime, a rota de decisão e o job Web Push. **Não medem os quatro despachos completos da IA via pós-entrada/handler.** A linha de engajamento anterior é uma fixture histórica persistida com `ai_actor_id`, status sent e carimbo do atendimento corrente; não se afirma que foi produzida pelo LLM nesta rodada. O par de engine real foi medido separadamente.
- Prospecção reserva `message_id` quando cria candidato: isso não significa envio. O preflight passou a exigir candidato new e ausência de mensagem correspondente. O início também exige admin, ferramenta crm_move_lead_stage e funil permitido; a fixture recebeu ator admin separado, nova versão publicada e duas etapas abertas. O manager usado nos negativos não foi promovido.
- A primeira rodada de avisos inseria antes do JOIN Realtime; a correção do runner aguarda confirmação Phoenix do servidor. As tentativas anteriores permanecem em `run-assinatura-avisos*` e não são apresentadas como verde. Nenhuma mudança de produto foi necessária nesta bancada.
- A prova foi no Supabase PG15 (piso suportado); invariantes PG17 são do CI. Não houve migration, baseline ou alteração de testes congelados. Não se reivindica instalação fresca com provedores externos nem a suíte E2E inteira.

Fontes preservadas por ancestry: @webtecnica (#3455, #3407, #3430, #3424, #3426) e @paulolimajr77 (#3469). Adaptações da manutenção e créditos estão no PR.

## Índice das capturas

Os caminhos abaixo partem da raiz do repositório. Cada captura tem um papel declarado; as tentativas anteriores explicam o ajuste da bancada e não contam como aceite.

| Captura | O que sustenta |
| --- | --- |
| `evidence/atendimento-followups-3475/preflight/login-manager-real.png` | Sessão do manager real no preflight sintético |
| `evidence/atendimento-followups-3475/preflight/modulo-roteiro-ativado-pela-tela.png` | Precondição do módulo ligada pela interface |
| `evidence/atendimento-followups-3475/run-basico/dossie-dormente-cancelado-sem-reload.png` | Dossiê dormente cancelado e timeline imediata |
| `evidence/atendimento-followups-3475/run-basico/dossie-coletando-cancelado-sem-reload.png` | Dossiê coletando cancelado e timeline imediata |
| `evidence/atendimento-followups-3475/run-basico/inbox-dormente-com-parar.png` | Parar oferecido antes do cancelamento |
| `evidence/atendimento-followups-3475/run-basico/inbox-dormente-parado.png` | Registro histórico durante carregamento; não prova a ausência do botão |
| `evidence/atendimento-followups-3475/reload-carregado/inbox-cancelado-reload-carregado.png` | Seção carregada após reload, sem Parar e com seletor de Iniciar |
| `evidence/atendimento-followups-3475/run-basico/pausa-humana-de-cinco-minutos.png` | Pausa humana após envio em nome de atendente |
| `evidence/atendimento-followups-3475/run-basico/pausa-vencida-automatico-de-volta.png` | Retorno ao automático após cinco minutos reais |
| `evidence/atendimento-followups-3475/reload-carregado/pausa-vencida-mensagem-carregada.png` | Recheck do retorno com a mensagem humana carregada |
| `evidence/atendimento-followups-3475/run-basico/ack-lida-preservada-apos-2-1-erro-e-reload.png` | Leitura preservada após ACKs atrasados e reload |
| `evidence/atendimento-followups-3475/run-basico/ack-falha-recuperada-por-2.png` | Confirmação de entrega recupera a falha |
| `evidence/atendimento-followups-3475/run-basico/ack-falha-recuperada-por-3.png` | Confirmação de leitura recupera a falha |
| `evidence/atendimento-followups-3475/run-assinatura-admin/assinatura-automacao-mensagem-na-conversa.png` | Corpo gerado pela automação visível no Inbox; assinatura exata medida no receiver |
| `evidence/atendimento-followups-3475/run-assinatura-admin/assinatura-prospeccao-mensagem-na-conversa.png` | Corpo da primeira Prospecção visível no Inbox; assinatura exata medida no receiver |
| `evidence/atendimento-followups-3475/run-diagnostico-3/avisos-recusada-toast.png` | Toast positivo quando a palavra é recusada pelo filtro |
| `evidence/atendimento-followups-3475/run-diagnostico-3/avisos-recusada.png` | Estado após a observação do toast positivo |
| `evidence/atendimento-followups-3475/run-diagnostico-3/avisos-midia_sem_texto-toast.png` | Toast positivo para mídia ainda sem texto |
| `evidence/atendimento-followups-3475/run-diagnostico-3/avisos-midia_sem_texto.png` | Estado após a observação do toast da mídia |
| `evidence/atendimento-followups-3475/run-diagnostico-3/avisos-aceita.png` | Controle negativo com palavra aceita; ausência confirmada pelo runner após JOIN |
| `evidence/atendimento-followups-3475/run-diagnostico-3/avisos-ja_engajado.png` | Controle negativo com âncora histórica do atendimento corrente |
| `evidence/atendimento-followups-3475/real-engine/invisible-inbox.png` | Conversa carregada sem bolha outbound invisível; recusa comprovada pelo resultado da ferramenta |
| `evidence/atendimento-followups-3475/real-engine/valid-inbox.png` | Controle legível do mesmo handler com a resposta visível |
| `evidence/atendimento-followups-3475/run-assinatura-avisos/falha-assinatura.png` | Tentativa anterior: precondição de Prospecção não satisfeita |
| `evidence/atendimento-followups-3475/run-assinatura-avisos/falha-avisos.png` | Tentativa anterior: INSERT antes da confirmação do JOIN Realtime |
| `evidence/atendimento-followups-3475/run-assinatura-avisos-2/falha-assinatura.png` | Segunda tentativa anterior de Prospecção; não é aceite |
| `evidence/atendimento-followups-3475/run-assinatura-avisos-2/falha-avisos.png` | Segunda tentativa anterior de avisos; não é aceite |
| `evidence/atendimento-followups-3475/run-diagnostico-3/falha-assinatura.png` | Rodada em que avisos passou, mas Prospecção ainda exigia ator admin; assinatura aceita só na rodada posterior |

## Reproduzir e encerrar

O runner base está em `tests/qa/provar-atendimento-followups-3475.ts` com manifesto de exemplo e contrato ao lado. [Manifesto desta execução](manifesto-sintetico.json) contém só IDs e nomes de variáveis, sem senhas/tokens. O receiver e runner auxiliares usados no motor real estão como fontes textuais em `bancada/`; imports do runner partem de `scripts/qa/` na árvore servida. Não são um instalador nem abrem outros serviços.

[Marco de recursos liberados](bancada/recursos-liberados.json): app, receivers, Supabase, Redis, rede e volumes exclusivos encerrados/removidos por IDs/projeto exatos. Nenhum listener/contêiner/volume próprio restante; sete contêineres do curso permaneceram ativos. Não houve Docker local, prune, troca de contexto global, cópia/leitura de .env ou dados reais de cliente. A sessão com ambiente sintético em processo foi encerrada.

[Revalidação da retomada](bancada/revalidacao-retomada.json): às 20:42Z a VPS continuava sem os recursos próprios e com os sete contêineres do curso ativos. O consolidado confere com os relatórios originais e o mesmo build; nenhuma jornada foi reexecutada. O CI do head `b65041977` expôs a falta de citações canônicas das capturas neste README: o guard dirigido reproduziu duas falhas antes deste índice e passou 70/70 depois, sem alterar o teste. A parte 6 do E2E não chegou ao Playwright: falhou na instalação de ffmpeg. Esses estados não são apresentados como CI integral verde.
