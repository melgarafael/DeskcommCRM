/** Streaming linear PCM16 resampling; phase and boundary samples survive network chunks. */
export class PcmResampler {
  private samples: number[] = [];
  private position = 0;
  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
  ) {}
  push(bytes: Buffer): Buffer {
    if (bytes.length % 2) throw new Error("invalid_pcm");
    for (let i = 0; i < bytes.length; i += 2) this.samples.push(bytes.readInt16LE(i));
    const output: number[] = [];
    while (this.position + 1 < this.samples.length) {
      const left = Math.floor(this.position),
        fraction = this.position - left;
      output.push(
        Math.round(this.samples[left]! * (1 - fraction) + this.samples[left + 1]! * fraction),
      );
      this.position += this.inputRate / this.outputRate;
    }
    const consumed = Math.floor(this.position);
    this.samples = this.samples.slice(consumed);
    this.position -= consumed;
    const result = Buffer.alloc(output.length * 2);
    output.forEach((sample, i) => result.writeInt16LE(sample, i * 2));
    return result;
  }
}

export class PcmQueue {
  private chunks: { bytes: Buffer; item: string; index: number }[] = [];
  private size = 0;
  private played = new Map<string, number>();
  get empty() {
    return this.size === 0;
  }
  push(bytes: Buffer, item: string, index = 0) {
    if (bytes.length % 2 || this.size + bytes.length > 960_000)
      throw new Error("audio_queue_overflow");
    if (!bytes.length) return;
    this.chunks.push({ bytes, item, index });
    this.size += bytes.length;
  }
  clear() {
    const interrupted = [
      ...new Map(
        this.chunks.map((c) => [
          c.item,
          {
            item_id: c.item,
            content_index: c.index,
            audio_end_ms: Math.floor((this.played.get(c.item) ?? 0) / 32),
          },
        ]),
      ).values(),
    ];
    this.chunks = [];
    this.size = 0;
    this.played.clear();
    return interrupted;
  }
  next() {
    if (!this.size) return null;
    const output: Buffer[] = [];
    let remaining = 640;
    while (remaining && this.chunks.length) {
      const c = this.chunks[0]!;
      const bytes = c.bytes.subarray(0, remaining);
      c.bytes = c.bytes.subarray(bytes.length);
      this.size -= bytes.length;
      remaining -= bytes.length;
      this.played.set(c.item, (this.played.get(c.item) ?? 0) + bytes.length);
      output.push(bytes);
      if (!c.bytes.length) this.chunks.shift();
    }
    return Buffer.concat(output);
  }
}
