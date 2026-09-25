---
impacto: nada_mudou
secao: corrigido
titulo: Corrige convites filtrados por identificação SMTP local em instalações Docker
---

Corrige uma falha em que o servidor de e-mail aceitava os convites, mas podia filtrá-los depois porque o CRM se identificava como localhost. O envio SMTP passa a usar o domínio já configurado na instalação, sem exigir ajustes manuais no contêiner. A falha foi observada na hospedagem de e-mail HostGator; a correção se aplica ao transporte SMTP em geral. Crédito: @vitorlacerdadigital.
