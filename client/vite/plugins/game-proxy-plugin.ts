import { request, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";

/**
 * Vite plugin that proxies game WebSocket connections.
 * Routes `/game/<id>/play` to the corresponding game worker on port `8000 + id`.
 * This allows all traffic to flow through a single port (Vite dev server on 3000),
 * which is required for environments like GitHub Codespaces.
 */
export function gameProxy(): Plugin {
    return {
        name: "suroi-game-ws-proxy",
        configureServer(server) {
            server.httpServer?.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
                const match = req.url?.match(/^\/game\/(\d+)\/(.*)/);
                if (!match) return;

                const gameID = parseInt(match[1]);
                const port = 8000 + gameID;
                const targetPath = `/${match[2]}`;

                const proxyReq = request({
                    hostname: "127.0.0.1",
                    port,
                    path: targetPath,
                    method: req.method,
                    headers: {
                        ...req.headers,
                        host: `127.0.0.1:${port}`
                    }
                });

                proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
                    // Forward the 101 Switching Protocols response to the client
                    let response = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
                    for (const [key, value] of Object.entries(proxyRes.headers)) {
                        if (value !== undefined) {
                            const values = Array.isArray(value) ? value : [value];
                            for (const v of values) {
                                response += `${key}: ${v}\r\n`;
                            }
                        }
                    }
                    response += "\r\n";
                    socket.write(response);

                    if (proxyHead.length > 0) socket.write(proxyHead);

                    // Bidirectional pipe
                    proxySocket.pipe(socket);
                    socket.pipe(proxySocket);

                    proxySocket.on("error", () => socket.destroy());
                    socket.on("error", () => proxySocket.destroy());
                });

                proxyReq.on("error", (err) => {
                    console.error(`[game-proxy] Error connecting to game ${gameID} on port ${port}:`, err.message);
                    socket.destroy();
                });

                if (head.length > 0) {
                    proxyReq.write(head);
                }
                proxyReq.end();
            });
        }
    };
}
