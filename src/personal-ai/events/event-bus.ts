/**
 * 极简异步事件通道：生产者 push，消费者用 for await 读取。
 * 用于把后台 Worker 的进度桥接到 SSE 流，不引入消息中间件。
 */
export interface EventChannel<T> {
  push(value: T): void;
  close(): void;
  stream(): AsyncIterable<T>;
}

export function createEventChannel<T>(): EventChannel<T> {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const take = (): Promise<IteratorResult<T>> =>
    new Promise<IteratorResult<T>>((resolve): void => {
      if (queue.length > 0) {
        resolve({ value: queue.shift() as T, done: false });
        return;
      }
      if (closed) {
        resolve({ value: undefined as unknown as T, done: true });
        return;
      }
      waiters.push(resolve);
    });

  return {
    push(value: T): void {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else queue.push(value);
    },
    close(): void {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as unknown as T, done: true });
      }
    },
    stream(): AsyncIterable<T> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          return {
            next: (): Promise<IteratorResult<T>> => take(),
            return: async (): Promise<IteratorResult<T>> => ({
              value: undefined as unknown as T,
              done: true,
            }),
          };
        },
      };
    },
  };
}
