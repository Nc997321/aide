import { AsyncLocalStorage } from "node:async_hooks";

export const BROWSER_OPERATION_TIMEOUT_MS = 60_000;

type Operation = { epoch: number; deadline: number };
type Interruption = { cancelled: true; error: string } | { timedOut: true; error: string };

const operations = new AsyncLocalStorage<Operation>();
let cancellationEpoch = 0;

/** 同一动作链的每次查询共享截止时间；取消发生在两次查询之间也不会漏掉。 */
export function withBrowserOperation<T>(work: () => Promise<T>): Promise<T> {
  return operations.run({
    epoch: cancellationEpoch,
    deadline: Date.now() + BROWSER_OPERATION_TIMEOUT_MS,
  }, work);
}

export function cancelBrowserOperations(): void {
  cancellationEpoch += 1;
}

export function remainingBrowserOperationMs(): number {
  const operation = operations.getStore();
  return operation ? Math.max(0, operation.deadline - Date.now()) : Infinity;
}

export function browserOperationInterruption(): Interruption | undefined {
  const operation = operations.getStore();
  if (!operation) return undefined;
  if (operation.epoch !== cancellationEpoch) {
    return { cancelled: true, error: "the browser operation was interrupted; no further actions were sent" };
  }
  if (remainingBrowserOperationMs() === 0) {
    return { timedOut: true, error: "the browser operation exhausted its 60s budget; no further actions were sent" };
  }
  return undefined;
}
