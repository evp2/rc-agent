/**
 * Minimal pull-based async queue: a value pushed before anyone is waiting is
 * buffered; a `next()` call arriving before any value exists parks until one
 * is pushed. Backs each Engine session's event stream, and the Claude
 * adapter's streaming input (each query's prompt).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly parked: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  /** No-op once closed, so a late push can never resurrect a stream a reader has already been told is done. */
  push(value: T): void {
    if (this.closed) return;
    const resolve = this.parked.shift();
    if (resolve) resolve({ value, done: false });
    else this.buffered.push(value);
  }

  /** Ends the stream. Idempotent; resolves every parked `next()` as done. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.parked.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as T, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.parked.push(resolve));
      },
    };
  }
}

/**
 * Reads exactly one value off an async iterable, or undefined if it ends
 * before producing one. Leaves the rest of the iterable untouched -- callers
 * that never invoke this at all (an un-iterated generator) never run any of
 * its body, which is what lets a probe query's never-yielding prompt pass
 * through here safely as long as nothing actually calls it.
 */
export async function takeOne<T>(source: AsyncIterable<T>): Promise<T | undefined> {
  const { value, done } = await source[Symbol.asyncIterator]().next();
  return done ? undefined : value;
}
