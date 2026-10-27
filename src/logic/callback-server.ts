import type { AuthorizationResponse } from "@pagopa/io-wallet-oid4vci";

import * as http from "node:http";
import { URL } from "node:url";

import { CALLBACK_PATH } from "./constants";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface CallbackServerHandle {
  /** Stops listening, clears timers and rejects a pending completion. */
  close(): Promise<void>;
  /** Settles with the authorization callback, or rejects on timeout/abort/close. */
  readonly completion: Promise<AuthorizationResponse>;
  readonly port: number;
}

export interface CallbackServerOptions {
  port: number;
  /** Run cancellation/deadline signal; aborting closes the listener. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Opens the OAuth2 authorization callback listener on
 * `http://localhost:{port}{CALLBACK_PATH}` and resolves once it is listening.
 *
 * The returned `completion` resolves when the authorization server redirects
 * with `code`, `iss` and `state`; it rejects on timeout, abort or close. The
 * listener is closed (port released) on every one of those paths.
 */
export async function openCallbackServer(
  options: CallbackServerOptions,
): Promise<CallbackServerHandle> {
  const { port, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  signal?.throwIfAborted();

  const {
    promise: completion,
    reject,
    resolve,
  } = Promise.withResolvers<AuthorizationResponse>();
  // A completion nobody awaits must not become an unhandled rejection.
  completion.catch(() => undefined);

  let closed: Promise<void> | undefined;

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "", `http://localhost:${port}`);

    if (reqUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end("Not found");
      return;
    }

    const code = reqUrl.searchParams.get("code");
    const iss = reqUrl.searchParams.get("iss");
    const state = reqUrl.searchParams.get("state");

    if (!code || !iss || !state) {
      res
        .writeHead(400)
        .end(
          "Missing required parameters: code, iss, and state are all required.",
        );
      return;
    }

    res
      .writeHead(200, { Connection: "close", "Content-Type": "text/html" })
      .end(
        "<html><body><h1>Authorization successful</h1><p>You can close this tab and return to the terminal.</p></body></html>",
      );

    resolve({ code, iss, state });
    void close();
  });

  const onAbort = () => {
    reject(
      new Error(
        `Authorization callback on port ${port} aborted: ${String(signal?.reason ?? "cancelled")}`,
      ),
    );
    void close();
  };

  function close(): Promise<void> {
    closed ??= new Promise<void>((done) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Callback server on port ${port} closed`));
      server.close(() => done());
      server.closeAllConnections();
    });
    return closed;
  }

  await new Promise<void>((listening, failed) => {
    server.once("error", (err) => {
      failed(
        new Error(`Callback server error on port ${port}: ${err.message}`),
      );
    });
    server.listen(port, "127.0.0.1", () => listening());
  });

  const timer = setTimeout(() => {
    reject(
      new Error(
        `Callback server timed out after ${timeoutMs / 1000}s waiting for authorization callback on port ${port}`,
      ),
    );
    void close();
  }, timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return { close, completion, port };
}

/**
 * Compatibility wrapper: starts the listener and returns only the completion.
 */
export async function startCallbackServer(
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AuthorizationResponse> {
  const handle = await openCallbackServer({ port, timeoutMs });
  return handle.completion;
}
