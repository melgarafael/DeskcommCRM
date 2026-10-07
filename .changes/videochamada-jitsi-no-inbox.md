---
impacto: capacidade_nova
secao: adicionado
titulo: Videochamada por Jitsi Meet direto da conversa
---

O cabeçalho da conversa ganha o botão **Vídeo**. Ele abre uma sala de
videochamada — `<servidor>/sala-<uuid aleatório>`, uma por chamada — e as
três saídas saem de lá: **Abrir sala em nova aba**, **Copiar link** e
**Enviar link na conversa**.

A sala abre em **nova aba**, não em iframe: o `Permissions-Policy` de produção
(`camera=(), microphone=(self)`) nega câmera e microfone dentro de um iframe de
outra origem, e o `meet.jit.si` derruba chamada embutida em 5 minutos. Na aba
nova roda a página do Jitsi, com as permissões dela. A sala é aleatória por
abertura — nada é gravado, e o id da conversa não sai para o cliente.

**O envio do link é trava, não atalho.** Ele usa a mesma régua do composer: com
a janela de 24h fechada o botão desabilita e mostra o motivo na tela. A rota
`POST /api/v1/messages` não barra a janela para quem envia da tela (só para
`api_token`/`ai_agent`), então sem essa trava o link sairia como `201` e a
plataforma recusaria a entrega depois com `131047` — a falha silenciosa da
issue 1614. Contato bloqueado/anonimizado e conversa encerrada entram pelo
mesmo caminho. `supportReadonly` não entra: ele mora no `user`, que o
cabeçalho não recebe.

O alvo é o contato que já está no WhatsApp: o link chega na conversa e ele
entra pelo celular, sem instalar nada e sem criar conta. Telemedicina e
teleatendimento é o caso em que isso mais muda — o encontro acontece onde o
paciente já está; demonstração e reunião rápida da equipe usam a mesma sala.

A feature nasce desligada: sem `JITSI_SERVER_URL` no `.env`, o botão não
renderiza e a tela não muda. A URL é validada como `http(s)` no Zod e lida em
runtime (mesmo caminho da marca e do DSN do Sentry), então apontar para o
servidor próprio não exige rebuild. Ela também aparece em **Recursos opcionais**,
em `lib/recursos-opcionais/` (nível servidor, ao lado da chamada de voz).
Para ligar, `docs/features/videochamada.md` e o bloco do `.env.example`.

Sem gravação, sem linha em `voice_calls`, sem migration. Quem tem o link entra
— é a mesma natureza do link de reset de senha, e a doc declara essa e as
outras limitações (inclusive a saída de servidor próprio com JWT).

Refs #2440

Contribuição de @webtecnica.
