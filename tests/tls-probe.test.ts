import { readFileSync } from 'node:fs';
import { createServer as createTcpServer, type AddressInfo, type Server } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchPage, probeTls } from '../src/net/http.js';
import { startTestServer, type TestServer } from './helpers/test-server.js';

let http: TestServer | undefined;
let tlsServer: TlsServer | undefined;
let tcpServer: Server | undefined;

afterEach(async () => {
  await http?.close();
  tlsServer?.close();
  tcpServer?.close();
  http = tlsServer = tcpServer = undefined;
});

describe('fetchPage setCookies', () => {
  it('returns each Set-Cookie on its own, even when Expires holds commas', async () => {
    http = await startTestServer({
      '/': (_req, res) => {
        res
          .writeHead(200, {
            'content-type': 'text/html',
            'set-cookie': [
              'a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure',
              'b=2; HttpOnly; SameSite=Lax',
            ],
          })
          .end('<html></html>');
      },
      '/none': {},
    });
    expect((await fetchPage(`${http.url}/`)).setCookies).toEqual([
      'a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure',
      'b=2; HttpOnly; SameSite=Lax',
    ]);
    expect((await fetchPage(`${http.url}/none`)).setCookies).toEqual([]);
  });
});

describe('probeTls', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url));

  async function listenTls(): Promise<number> {
    tlsServer = createTlsServer(
      { key: fixture('selfsigned.key'), cert: fixture('selfsigned.crt') },
      (socket) => socket.end(),
    );
    await new Promise<void>((resolve) => tlsServer!.listen(0, '127.0.0.1', resolve));
    return (tlsServer.address() as AddressInfo).port;
  }

  it('reports a self-signed certificate as unauthorized, with protocol and expiry', async () => {
    const port = await listenTls();
    const probe = await probeTls('127.0.0.1', port);
    expect(probe).toMatchObject({
      host: '127.0.0.1',
      port,
      error: null,
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      protocol: 'TLSv1.3',
    });
    expect(Date.parse(probe.validTo!)).toBeGreaterThan(Date.now());
  });

  it('reports a refused connection as an error without throwing', async () => {
    const port = await listenTls();
    await new Promise<void>((resolve) => tlsServer!.close(() => resolve()));
    const probe = await probeTls('127.0.0.1', port);
    expect(probe.error).toContain('ECONNREFUSED');
    expect(probe.authorized).toBe(false);
  });

  it('gives up after the timeout when the server never answers the handshake', async () => {
    tcpServer = createTcpServer(() => undefined);
    await new Promise<void>((resolve) => tcpServer!.listen(0, '127.0.0.1', resolve));
    const probe = await probeTls('127.0.0.1', (tcpServer.address() as AddressInfo).port, {
      timeoutMs: 100,
    });
    expect(probe.error).toContain('timed out');
  });

  it('stops when the signal is aborted', async () => {
    const probe = await probeTls('127.0.0.1', 1, { signal: AbortSignal.abort() });
    expect(probe.error).toBe('aborted');
  });
});
