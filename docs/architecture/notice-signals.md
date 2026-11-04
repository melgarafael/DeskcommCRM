# Candidato local A: avisos autorizados

```mermaid
flowchart LR
  Mutacao[Alteração de negócio] --> Trigger[Trigger transacional]
  Trigger --> Sinal[realtime_invalidations: org/tipo/nonce]
  Sessao[auth.sessions] --> RLS[SELECT restritivo9110]
  RLS --> Sinal
  Sinal --> Hook[useNoticeSignal:100ms]
  Hook --> GET[GET com autorização existente]
  GET --> Aviso[Lista/aviso com detalhe autorizado]
```

Sem detalhes de alerta/transferência no transporte. Fonte anterior, cache e sessão não podem servir de aprovação de autorização. Código preparado/testado offline; WS exclusivo e integração real ainda pendentes.
