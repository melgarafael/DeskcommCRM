import type { UiAreaContract } from "./contracts";
import { createUiAreaCatalog } from "./registry";
import { inboxPresentationSchema, inboxFiltersPresentationSchema } from "./inbox-presentation";
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
    "contact-card",
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
/** Independent slots let a package arrange the same controls without shipping its layout in the host. */
export const inboxFiltersArea: UiAreaContract = {
  id: "inbox-filters",
  title: "Filtros de conversas",
  version: 1,
  validateConfiguration: (input) => inboxFiltersPresentationSchema.safeParse(input).success,
  regions: ["search", "views", "quick", "advanced", "selection", "filter-advanced", "filter-panel"],
  slots: ["search", "views", "quick", "advanced", "selection"],
  required: ["search", "views", "quick", "advanced"],
};
export const inboxHeaderArea: UiAreaContract = {
  id: "inbox-header",
  title: "Cabeçalho da conversa",
  version: 1,
  validateConfiguration: (input) =>
    Object.keys(input).every((key) => key === "actionsControl") &&
    (input.actionsControl === undefined ||
      input.actionsControl === "inline" ||
      input.actionsControl === "disclosure"),
  regions: [
    "identity",
    "tools",
    "primary",
    "actions",
    "notices",
    "actions-trigger",
    "actions-panel",
  ],
  slots: ["identity", "tools", "primary", "actions", "notices"],
  required: ["identity", "actions"],
};
export const pipelineArea: UiAreaContract = {
  id: "pipeline",
  title: "Funis",
  version: 1,
  validateConfiguration: (input) => pipelinePresentationSchema.safeParse(input).success,
  regions: ["toolbar", "board", "column", "column-header", "card", "state", "score"],
  required: ["toolbar", "board"],
};
export const calendarArea: UiAreaContract = {
  id: "calendar",
  title: "Agenda",
  version: 1,
  validateConfiguration: (input) => calendarPresentationSchema.safeParse(input).success,
  regions: [
    "controls",
    "services",
    "status",
    "notice",
    "content",
    "event",
    "history",
    "grid",
    "period-list",
  ],
  slots: ["notice", "controls", "content"],
  required: ["controls", "content"],
};

export const registeredUiAreas = createUiAreaCatalog([
  inboxArea,
  inboxFiltersArea,
  inboxHeaderArea,
  pipelineArea,
  calendarArea,
]);
