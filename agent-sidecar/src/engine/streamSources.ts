/** SDK API message id + block index identifies a block in both partial events and JSONL.
 * A single API response may be persisted as several assistant rows. Keep the completed
 * block ordinal across those rows; partial offsets count JS UTF-16 code units. */
export class StreamSources {
  private apiId = "";
  private completed = 0;
  private offsets = new Map<number, number>();

  start(id: string): void {
    if (id === this.apiId) return;
    this.apiId = id;
    this.completed = 0;
    this.offsets.clear();
  }

  delta(index: number, text: string): { sourceId: string; sourceOffset: number } | undefined {
    if (!this.apiId) return;
    const offset = this.offsets.get(index) ?? 0;
    this.offsets.set(index, offset + text.length);
    return { sourceId: `${this.apiId}:${index}`, sourceOffset: offset };
  }

  block(id: string): string {
    this.start(id);
    return `${id}:${this.completed++}`;
  }
}
