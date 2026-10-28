import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RouteSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Delay before the response headers are sent. */
  delayMs?: number;
}

export type Route = RouteSpec | ((req: IncomingMessage, res: ServerResponse) => void);

export interface TestServer {
  /** Base URL without trailing slash, e.g. http://127.0.0.1:12345 */
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(routes: Record<string, Route>): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    const route = routes[req.url ?? '/'];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    if (typeof route === 'function') {
      route(req, res);
      return;
    }
    const send = () => {
      res.writeHead(route.status ?? 200, { 'content-type': 'text/html', ...route.headers });
      res.end(route.body ?? '');
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    // Safe to call more than once.
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
