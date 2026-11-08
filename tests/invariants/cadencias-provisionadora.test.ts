/** ADR-0002: as tabelas só nascem quando o dono instala o módulo. */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";
moldeDeProvisionadora({ modulo: "cadencias", tabelas: ["email_cadences", "email_cadence_enrollments", "email_cadence_events", "email_cadence_suppressions", "email_cadence_recipients"], protecaoPropria: ["email_cadences", "email_cadence_enrollments", "email_cadence_events", "email_cadence_suppressions", "email_cadence_recipients"] });
