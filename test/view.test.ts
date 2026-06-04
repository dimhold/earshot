import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { LiveView, isLoopbackHost, serializeLine } from '../src/view/server.js';
import { VIEW_HTML } from '../src/view/page.js';

const LINE = { seq: 3, at: new Date(2026, 7, 16, 14, 31, 7), offsetMs: 1234.6, text: 'ship it' };

describe('isLoopbackHost', () => {
  it('accepts loopback with or without a port', () => {
    for (const host of ['127.0.0.1:8377', '127.0.0.1', 'localhost:8377', 'LOCALHOST', '[::1]:8377']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
  });

  it('rejects anything that could be a rebinding attack', () => {
    for (const host of ['example.com', 'earshot.local', '10.0.0.5:8377', undefined]) {
      assert.equal(isLoopbackHost(host), false, String(host));
    }
  });
});

describe('serializeLine', () => {
  it('sends the clock string the page renders, and rounds the offset', () => {
    assert.deepEqual(JSON.parse(serializeLine(LINE)), {
      seq: 3,
      time: '14:31:07',
      offsetMs: 1235,
      text: 'ship it',
    });
  });
});

describe('the page itself', () => {
  it('loads nothing from the network', () => {
    assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(VIEW_HTML), false);
    assert.equal(/<script[^>]+src=/.test(VIEW_HTML), false);
    assert.equal(/<link[^>]+href=/.test(VIEW_HTML), false);
  });
});

describe('LiveView', () => {
  it('serves the page, replays the session and streams new lines', async () => {
    const view = new LiveView('127.0.0.1', 0);
    const url = await view.start();
    try {
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>earshot<\/title>/);

      view.setStatus({ message: 'listening', source: 'microphone', live: true });
      view.append(LINE);

      const stream = await fetch(`${url}events`);
      assert.equal(stream.headers.get('content-type'), 'text/event-stream');

      const reader = stream.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /event: status/);
      assert.match(first, /"message":"listening"/);

      const replayed = first.includes('event: line')
        ? first
        : new TextDecoder().decode((await reader.read()).value);
      assert.match(replayed, /event: line/);
      assert.match(replayed, /ship it/);
      await reader.cancel();

      const download = await fetch(`${url}transcript.txt`);
      assert.equal(await download.text(), '[14:31:07] ship it\n');
    } finally {
      await view.stop();
    }
  });

  it('refuses a request whose Host is not loopback', async () => {
    const view = new LiveView('127.0.0.1', 0);
    const url = await view.start();
    const port = Number(new URL(url).port);
    try {
      // fetch() will not let a caller forge Host, so go through node:http.
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example.com' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);
    } finally {
      await view.stop();
    }
  });

  it('answers 404 for anything else', async () => {
    const view = new LiveView('127.0.0.1', 0);
    const url = await view.start();
    try {
      assert.equal((await fetch(`${url}admin`)).status, 404);
    } finally {
      await view.stop();
    }
  });
});
