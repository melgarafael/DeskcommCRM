---
impacto: nada_mudou
secao: corrigido
titulo: Report a failed media-removal queue read as a failed cron run
---
When the media-removal worker cannot read its queue, the cron now returns an error instead of reporting a successful empty batch. The scheduler can report the failed run, and its request ID links to the application log. Pending files remain queued for a later attempt. Credit: @samirhvbr.
