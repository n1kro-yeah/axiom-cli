import { describe, expect, it } from "vitest";
import { AsyncQueue, parseRawSseBlock, consumeSseStream } from "../src/util/sse.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    }
  });
}

describe("parseRawSseBlock", () => {
  it("parses a simple data line", () => {
    const payload = JSON.stringify({ a: 1 });
    const event = parseRawSseBlock(`data: ${payload}`);
    expect(event).not.toBeNull();
    expect(event?.data).toBe(payload);
    expect(event?.event).toBeUndefined();
  });

  it("joins multi-line data with newlines", () => {
    const event = parseRawSseBlock("data: first\ndata: second");
    expect(event?.data).toBe("first\nsecond");
  });

  it("captures event name and id fields", () => {
    const event = parseRawSseBlock("event: message_start\nid: 42\ndata: x");
    expect(event?.event).toBe("message_start");
    expect(event?.id).toBe("42");
  });

  it("ignores comment-only blocks and empty blocks", () => {
    expect(parseRawSseBlock(": keep-alive")).toBeNull();
    expect(parseRawSseBlock("")).toBeNull();
    expect(parseRawSseBlock("\n")).toBeNull();
  });

  it("handles CRLF separators", () => {
    const event = parseRawSseBlock("data: one\r\ndata: two\r\n\r".replace(/\r$/, ""));
    expect(event?.data).toBe("one\ntwo");
  });
});

describe("consumeSseStream", async () => {
  it("delivers events split across chunk boundaries", async () => {
    const body = streamFromChunks([
      'event: alpha\ndata: {"n":1}\n',
      "\n",
      "data: partial",
      ' {"n":2}\n\ndata: last\n\n'
    ]);

    const seen: string[] = [];
    await consumeSseStream(body, (event) => {
      seen.push(event.data);
    });

    expect(seen).toEqual(['{"n":1}', 'partial {"n":2}', "last"]);
  });

  it("aborts promptly when the signal fires", async () => {
    const controller = new AbortController();
    const body = streamFromChunks(["data: one\n\n"]);

    let errorCaught: unknown;
    try {
      await consumeSseStream(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: wait\n"));
          },
          pull() {
            controller.abort();
          }
        }),
        () => undefined,
        controller.signal
      );
      void body;
    } catch (error) {
      errorCaught = error;
    }

    expect(errorCaught).toBeDefined();
  });

  it("propagates handler failures", async () => {
    const body = streamFromChunks(["data: boom\n\n"]);
    let failure: unknown;
    try {
      await consumeSseStream(body, () => {
        throw new Error("handler exploded");
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as Error)?.message).toBe("handler exploded");
  });
});

describe("AsyncQueue", async () => {
  it("iterates values pushed before consumption", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();

    const collected: number[] = [];
    for await (const value of queue) collected.push(value);
    expect(collected).toEqual([1, 2]);
  });

  it("supports interleaved producer and consumer", async () => {
    const queue = new AsyncQueue<string>();
    const consumer = (async () => {
      const out: string[] = [];
      for await (const value of queue) out.push(value);
      return out;
    })();

    queue.push("a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.push("b");
    queue.end();

    expect(await consumer).toEqual(["a", "b"]);
  });

  it("ends with an error when failed", async () => {
    const queue = new AsyncQueue<number>();
    queue.end(new Error("upstream failure"));

    let caught: unknown;
    try {
      for await (const _ of queue) {
        void _;
      }
    } catch (error) {
      caught = error;
    }
    expect((caught as Error)?.message).toBe("upstream failure");
  });
});
