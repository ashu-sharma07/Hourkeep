import { MAX_MESSAGE_BYTES } from './protocol.js';

/** Thrown when a message exceeds the size limit. */
export class FrameTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`message exceeds ${limit} bytes`);
    this.name = 'FrameTooLargeError';
  }
}

/** Serialise one message as a single JSON line. Throws if it exceeds the limit. */
export function encodeMessage(message: unknown, limit = MAX_MESSAGE_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
  if (body.length > limit) throw new FrameTooLargeError(limit);
  return body;
}

/**
 * Incremental newline-delimited frame decoder with a hard size limit. It never buffers more
 * than `limit` bytes: a peer that sends no newline is cut off instead of exhausting memory.
 */
export class LineDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly limit = MAX_MESSAGE_BYTES) {}

  /** Feed bytes; returns every complete line (without the newline). Throws on overflow. */
  push(chunk: Buffer | string): string[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf(0x0a, start);
      if (nl === -1) break;
      if (nl - start >= this.limit) throw new FrameTooLargeError(this.limit);
      lines.push(this.buffer.toString('utf8', start, nl));
      start = nl + 1;
    }
    this.buffer = this.buffer.subarray(start);
    if (this.buffer.length >= this.limit) throw new FrameTooLargeError(this.limit);
    return lines;
  }

  /** Bytes of an unterminated line currently held. */
  get pending(): number {
    return this.buffer.length;
  }
}
