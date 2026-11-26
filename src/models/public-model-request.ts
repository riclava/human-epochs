import { lookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline, Readable, Transform } from "node:stream";
import { isEventStream } from "../contracts/event-stream.js";

const reserved = new BlockList();
for (const [address, mask] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) reserved.addSubnet(address, mask);
for (const [address, mask] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  reserved.addSubnet(address, mask, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !reserved.check(address);
  return family === 6 && globalV6.check(address, "ipv6") && !reserved.check(address, "ipv6");
}

export function isPublicModelHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return isIP(host) ? isPublicAddress(host) : host.includes(".") && !host.endsWith(".localhost") && !host.endsWith(".local");
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { family: options.family, all: true }, (error, records) => {
    if (error) return callback(error, "", 0);
    const candidates = records.filter(record => isPublicAddress(record.address));
    if (!candidates.length) return callback(new Error("Model host has no public address"), "", 0);
    // The addresses returned here go directly to the socket. A separate preflight lookup would leave a DNS race.
    if (options.all) return callback(null, candidates);
    const [first] = candidates;
    callback(null, first.address, first.family);
  });
};

export const requestPublicModel: typeof fetch = (input, init) => {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.protocol !== "https:" || !isPublicModelHost(url.hostname)) return Promise.reject(new Error("Model endpoint must be public HTTPS"));
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers)),
      signal: init?.signal ?? undefined,
      lookup: publicLookup,
    }, incoming => {
      const status = incoming.statusCode ?? 502;
      if (status < 200 || status >= 300 || status === 204 || status === 205) {
        incoming.destroy();
        resolve(new Response(null, { status: status < 200 ? 502 : status }));
        return;
      }
      const contentType = incoming.headers["content-type"];
      let source: Readable = incoming;
      // The SSE parser limits buffered event data. Frame overhead does not count toward the reply limit.
      if (!isEventStream(contentType)) {
        let length = 0;
        const limited = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            length += chunk.length;
            if (length > 8 * 1024 * 1024) return callback(new Error("Model response is too large"));
            callback(null, chunk);
          },
        });
        source = pipeline(incoming, limited, () => {});
      }
      const body = Readable.toWeb(source, { strategy: {
        highWaterMark: source.readableHighWaterMark,
        size: (chunk: Buffer) => chunk.length,
      } }) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers: contentType ? { "Content-Type": contentType } : undefined }));
    });
    outgoing.once("error", reject);
    outgoing.end(typeof init?.body === "string" ? init.body : undefined);
  });
};
