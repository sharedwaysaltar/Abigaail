/**
 * Fixed-capacity FIFO. Never grows past `capacity`: when full, new items are
 * rejected (and counted) instead of allocating more memory.
 */
export class BoundedQueue<T> {
  private items: T[] = [];
  private droppedCount = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** Fraction of capacity in use, 0..1. */
  get fill(): number {
    return this.items.length / this.capacity;
  }

  /** Returns false (and counts a drop) when the queue is full. */
  push(item: T): boolean {
    if (this.items.length >= this.capacity) {
      this.droppedCount++;
      return false;
    }
    this.items.push(item);
    return true;
  }

  /** Remove and return up to `n` items from the front. */
  take(n: number): T[] {
    return this.items.splice(0, n);
  }

  /**
   * Put items back at the front (after a failed send), keeping only as many as
   * fit. Anything that does not fit is dropped and counted.
   */
  requeue(batch: T[]): void {
    const room = this.capacity - this.items.length;
    if (room <= 0) {
      this.droppedCount += batch.length;
      return;
    }
    const kept = batch.slice(0, room);
    this.droppedCount += batch.length - kept.length;
    this.items.unshift(...kept);
  }
}
