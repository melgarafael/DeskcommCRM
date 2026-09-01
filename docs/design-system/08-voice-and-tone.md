# 08 — Voz e Tom

> **Source of truth:** este documento. Todo microcopy do produto deve passar por aqui antes de ir pra produção.

## Personalidade

A voz do SonghaiCRM é **profissional sem ser formal, direta sem ser seca, humana sem ser casual**. A pessoa que está lendo é um atendente em meio a 40 conversas — ela precisa de clareza imediata, não de companhia.

Os 4 atributos canônicos:

- **Claro.** Frase curta, ordem direta, palavra exata. Se uma frase precisa ser relida, ela falhou.
- **Conciso.** Cada palavra carrega peso. Microcopy de botão raramente passa de 3 palavras; mensagem de confirmação raramente passa de 2 frases.
- **Confiante.** Sem hedging ("talvez", "geralmente", "pode ser"). O sistema sabe o que aconteceu e diz o que aconteceu.
- **Calmo.** Sem urgência manufaturada, sem celebração, sem exclamation marks — exceto em confirmação destrutiva onde o cuidado importa.

## Idioma e gramática

- **PT-BR brasileiro nativo**, não traduzido. Se a melhor expressão é uma estrutura própria do português, use; não force tradução literal de inglês.
- **"Você"**, sempre. Nunca "tu" (regional), nunca "vocês" (a interface fala com uma pessoa por vez), nunca terceira pessoa formal ("o usuário deve").
- **Evite anglicismos desnecessários.** "usuário" sim, "user" não; "atendente" sim, "agent" só em contextos técnicos (logs, settings de sistema). "fluxo" sim, "workflow" só em settings. "rascunho" sim, "draft" não em UI visível ao usuário.
- **Mantenha jargão de domínio quando ele é o termo correto.** "SLA", "CTR", "conversão", "ticket médio" — não traduza.

## Tabela do que SIM x do que NÃO

### Mensagens de erro

| ❌ Não | ✅ Sim |
|--------|-------|
| "Oops! Algo deu errado 😬" | "Não conseguimos completar essa ação. Tente novamente em instantes." |
| "Erro 500 — Internal Server Error" | "Tivemos um problema no servidor. Sua conversa não foi perdida." |
| "Falha ao salvar!" | "Não foi possível salvar. Verifique sua conexão." |
| "Acesso negado." | "Você não tem permissão pra essa ação. Fale com o admin do espaço." |

### Confirmações

| ❌ Não | ✅ Sim |
|--------|-------|
| "Salvo com sucesso! ✅" | "Salvo." |
| "Conversa marcada como resolvida! 🎉" | "Conversa resolvida." |
| "Awesome! Conta criada." | "Conta criada. Você já pode entrar." |

### IA / automação

| ❌ Não | ✅ Sim |
|--------|-------|
| "✨ Powered by AI" | "Atendimento com IA. Resposta em até 30 segundos." |
| "Smart suggestions" | "Sugestões automáticas" |
| "Magicamente organizado!" | "Organizado por contexto da conversa." |

### Ações destrutivas

| ❌ Não | ✅ Sim |
|--------|-------|
| "Tem certeza?? Essa ação é IRREVERSÍVEL!!!" | "Apagar 3 conversas? Essa ação não pode ser desfeita." |
| "Cuidado! Você vai perder seus dados!" | "Você está saindo desta conta. Suas conversas continuam no espaço." |

### Empty states

| ❌ Não | ✅ Sim |
|--------|-------|
| "Nada por aqui ainda 🌱" | "Nenhuma conversa pendente. Quando uma chegar, ela aparece aqui." |
| "Sem resultados :(" | "Nenhuma conversa encontrada para 'pedido cancelado'. Tente outros termos ou limpe o filtro." |
| "Lista vazia" | "Você não tem pedidos abertos. Crie um a partir de uma conversa." |

### Loading states

| ❌ Não | ✅ Sim |
|--------|-------|
| "Carregando…" | "Carregando conversas." |
| "Por favor aguarde" | (skeleton sem texto, ou) "Buscando." |
| "Hold on tight!" | "Sincronizando." |

## Microcopy patterns

### Empty states (3 partes)

1. **Estado** — o que está acontecendo agora, sem julgamento.
2. **Causa** — por quê (opcional, se não for óbvio).
3. **Próximo passo** — o que fazer agora.

> "Nenhuma conversa pendente. Todas resolvidas até aqui — boa! Crie uma manualmente ou configure um canal de entrada em **Configurações > Canais**."

### Errors (3 partes)

1. **O que aconteceu** — em frase direta.
2. **O que isso significa** — implicação pro usuário.
3. **Próximo passo** — ação pra resolver ou onde pedir ajuda.

> "Falhou ao enviar a mensagem. Sua mensagem ficou salva como rascunho. Tente reenviar em alguns segundos ou contate o suporte se persistir."

### Confirmação destrutiva (com undo quando possível)

> "Você apagou 3 conversas. **Desfazer** (10s)"

Padrão: ação no passado ("Você apagou"), CTA primário em verbo de reversão ("Desfazer"), countdown explícito.

### Botões

- 1–3 palavras. Verbo no infinitivo (`Salvar`, `Apagar`, `Marcar como resolvido`).
- Não use "Clique aqui" / "OK" / "Sim" / "Não" — use o verbo da ação (`Apagar` / `Cancelar`).
- Em confirmação destrutiva, o botão diz **o que vai acontecer** (`Apagar`), não confirmação genérica (`Confirmar`).

## Voz por contexto

### Erro técnico

Calmo, sem exclamation. Comunica que o sistema sabe do problema.

> "O servidor de mensagens está instável. Estamos investigando. Suas conversas estão salvas; tente novamente em 1 minuto."

### Ação destrutiva

Cuidadoso, explícito sobre consequência, com confirmação de número quando aplicável.

> "Apagar conversa com João Silva? Os 12 mensagens serão removidos do espaço (mas o cliente continua no CRM)."

### Sucesso

Sóbrio. Sem exclamation, sem emoji, sem "🎉". O fato é a recompensa.

> "Conversa atribuída a Maria. Notificação enviada."

### Onboarding / first-run

Acolhedor mas direto. Pode ser levemente caloroso, ainda sem casualidade exagerada.

> "Bem-vinda, Ana. Vamos começar conectando seu primeiro canal de atendimento. Leva uns 2 minutos."

### Notificação (toast)

Frase única, ≤ 60 caracteres ideal. Verbo no passado.

> "Pedido #12.443 marcado como enviado."

## Pontuação e símbolos

- **Ponto final em frases completas.** "Salvo." (com ponto) — comunica resolução.
- **Vírgula serial** (Oxford) não é padrão em PT-BR; siga uso natural.
- **Travessões** (—) são bem-vindos pra inserir contexto curto: "Pedido #12.443 — São Paulo".
- **Aspas duplas** ("…") em citação literal, **simples** ('…') só em citação dentro de citação.
- **Emoji**: nunca em mensagens de erro, sucesso, ou loading. Aceito apenas em copy de produto educacional ou marketing (não no app).
- **Exclamation**: máximo 1 ocorrência por view, e só em confirmação destrutiva ("Atenção!") quando o cuidado importa.

## Checklist antes de publicar microcopy

- [ ] É uma frase ou no máximo duas?
- [ ] Verbos estão no infinitivo (botões) ou passado (confirmação)?
- [ ] Não tem "talvez", "ops", "oh", "puxa"?
- [ ] Comunica próximo passo se for empty/error?
- [ ] Sem emoji?
- [ ] Sem exclamation (exceto destrutiva)?
- [ ] Cabe em 1 linha em viewport mobile (≤ 64 chars)?
- [ ] Mantém "você"? Não é "tu" nem "vocês"?
