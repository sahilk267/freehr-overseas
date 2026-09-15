import { AsyncLocalStorage } from "node:async_hooks";

export type AuditActorContext = {
  userId: number;
  role: string;
  workspaceOwnerId: number;
};

const actorStorage = new AsyncLocalStorage<AuditActorContext>();

export function runWithAuditActor<T>(actor: AuditActorContext, callback: () => T) {
  return actorStorage.run(actor, callback);
}

export function getAuditActor() {
  return actorStorage.getStore();
}
