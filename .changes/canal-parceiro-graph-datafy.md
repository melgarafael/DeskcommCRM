---
impacto: capacidade_nova
secao: adicionado
titulo: Conecte um número de WhatsApp por um parceiro Graph-compatível (Datafy)
---

A tela de **Conexões** ganhou um quarto caminho para conectar o WhatsApp, além do número por QR (celular), da API oficial da Meta e do provedor parceiro que já existia: um **parceiro Graph-compatível** (Datafy), homologado pela Meta, que usa a mesma API oficial por trás.

- **Conectar é só colar o token.** Na aba do parceiro, o operador informa apenas o token que recebeu do provedor (`sk_live_…`); o sistema descobre sozinho o número e a conta (WABA) e valida antes de gravar. Não há `phone_number_id` para caçar no painel — nem erro de digitação possível nesse campo.
- **Envia e recebe.** O envio (texto, mídia e contato) e o recebimento das respostas passam pelo mesmo canal, com transcrição somente-leitura e a mesma proteção anti-abuso dos demais.
- **Recebimento pela URL neutra.** O webhook entra pela rota genérica por token (a mesma do outro parceiro); a URL e o estado aparecem na tela para colar no painel do provedor. A assinatura do webhook é opcional no provedor — quando você a ativar, o segredo no servidor passa a validar as entregas.
- **Mesmas regras do WhatsApp oficial:** janela de 24 horas, necessidade de modelo aprovado fora da janela, custo por mensagem. O detalhe desta primeira versão: a **gestão de modelos ainda não está exposta para este canal** — dá para atender dentro da janela normalmente.

Também dá para escolher esse caminho já no **onboarding**, na pergunta de como o número já é usado.
