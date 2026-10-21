import type { UiAreaContract } from "./contracts";
import { createUiAreaCatalog } from "./registry";
import { inboxPresentationSchema } from "./inbox-presentation";
import { pipelinePresentationSchema } from "./pipeline-presentation";
import { calendarPresentationSchema } from "./calendar-presentation";

/** Contracts for the first host adapters. The resolver accepts any registered contract. */
export const inboxArea: UiAreaContract = {
  id: "inbox",
  title: "Conversas",
  version: 1,
  validateConfiguration: (input) => inboxPresentationSchema.safeParse(input).success,
  regions: [
    "list",
    "conversation",
    "contact",
    "header",
    "history",
    "composer",
    "filters",
    "list-item",
    "bubble-in",
    "bubble-out",
    "start",
  ],
  required: ["list", "conversation", "contact"],
};
export const pipelineArea: UiAreaContract = {
  id: "pipeline",
  title: "Funis",
  version: 1,
  validateConfiguration: (input) => pipelinePresentationSchema.safeParse(input).success,
  regions: ["toolbar", "board", "column", "card", "state", "score"],
  required: ["toolbar", "board"],
};
export const calendarArea: UiAreaContract = {
  id: "calendar",
  title: "Agenda",
  version: 1,
  validateConfiguration: (input) => calendarPresentationSchema.safeParse(input).success,
  regions: ["controls", "services", "status", "notice", "content", "event", "history", "grid", "period-list"],
  slots: ["notice", "controls", "content"],
  required: ["controls", "content"],
};

export const registeredUiAreas = createUiAreaCatalog([inboxArea, pipelineArea, calendarArea]);
