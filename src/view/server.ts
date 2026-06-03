/**
 * LiveView — a local HTTP server that streams the transcript to a browser tab.
 *
 * It binds to 127.0.0.1 and rejects requests whose Host header is anything
 * other than loopback, so a page on the open internet cannot rebind DNS and
 * read your transcript. Delivery is Server-Sent Events, which is one long
 * response and no dependency, and new tabs get the whole session replayed
 * before the live stream starts.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { formatClock, type TranscriptLine } from '../transcript/transcript.js';
import { VIEW_HTML } from './page.js';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('VIEW');

export interface ViewStatus {
  message: string;
  source?: string;
  live: boolean;
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

export function serializeLine(line: TranscriptLine): string {
  return JSON.stringify({
    seq: line.seq,
    time: formatClock(line.at),
    offsetMs: Math.round(line.offsetMs),
    text: line.text,
  });
}

export class LiveView {
  private readonly server: Server;
  private readonly clients = new Set<ServerResponse>();
  private readonly history: TranscriptLine[] = [];
  private status: ViewStatus = { message: 'starting', live: false };
  private boundPort = 0;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort}/`;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`port ${this.port} is already in use. Pass a different --port.`)
            : err,
        );
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve();
      });
    });
    log.info(`live transcript at ${this.url}`);
    return this.url;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('earshot only serves loopback.\n');
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    switch (path) {
      case '/':
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(VIEW_HTML);
        return;
      case '/events':
        this.subscribe(res);
        return;
      case '/transcript.txt':
        res
          .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          .end(this.history.map((l) => `[${formatClock(l.at)}] ${l.text}`).join('\n') + '\n');
        return;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    }
  }

  private subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));

    send(res, 'status', JSON.stringify(this.status));
    for (const line of this.history) send(res, 'line', serializeLine(line));
  }

  append(line: TranscriptLine): void {
    this.history.push(line);
    for (const client of this.clients) send(client, 'line', serializeLine(line));
  }

  setStatus(status: ViewStatus): void {
    this.status = status;
    const payload = JSON.stringify(status);
    for (const client of this.clients) send(client, 'status', payload);
  }

  async stop(): Promise<void> {
    this.setStatus({ ...this.status, message: 'session ended', live: false });
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function send(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}
