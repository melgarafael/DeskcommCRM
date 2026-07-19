import type { ActionExecutor } from "@/lib/automation/types";

const _actions = new Map<string, ActionExecutor>();

export function registerAction(executor: ActionExecutor): void {
  _actions.set(executor.type, executor);
}

export function getAction(type: string): ActionExecutor | undefined {
  return _actions.get(type);
}
