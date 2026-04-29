/**
 * Schemas registry. Add new entities as `lib/schemas/<entity>.ts` and re-export here.
 * ADR-03: Zod no boundary de TODA API route (Spec 09 §12).
 *
 * Convention:
 *   import { createLeadSchema, validateRequest } from "@/lib/schemas";
 *   const input = await validateRequest(createLeadSchema, req);
 */
export * from "./_validate";
export * from "./health";
export * from "./leads";
export * from "./contacts";
export * from "./team";
