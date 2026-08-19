import { randomUUID } from "node:crypto";
import { ConfigurationError } from "./errors";

export type PuppeteerBrowser = {
  newPage(): Promise<unknown>;
  disconnect(): Promise<void> | void;
};

export type BrowserConnectionMetadata = {
  connectionId: string;
  provider: "browserless";
  endpointOrigin: string;
  ownership: {
    browser: "browserless";
    connection: "automation-worker";
    reconnectEndpoint: "automation-worker";
  };
  reconnectable: true;
  connectedAt: string;
};

export type BrowserConnection = {
  browser: PuppeteerBrowser;
  metadata: BrowserConnectionMetadata;
  reconnect(): Promise<BrowserConnection>;
  disconnect(): Promise<void>;
};

export type BrowserProvider = {
  open(signal?: AbortSignal): Promise<BrowserConnection>;
};

export type PuppeteerConnector = (options: { browserWSEndpoint: string }) => Promise<PuppeteerBrowser>;

export type BrowserlessProviderOptions = {
  endpoint: string;
  token: string;
  connect: PuppeteerConnector;
  id?: () => string;
  now?: () => number;
};

function endpointWithToken(endpoint: string, token: string): URL {
  const url = new URL(endpoint);
  if (url.searchParams.has("token")) throw new ConfigurationError("Browserless endpoint must not already contain a token.");
  url.searchParams.set("token", token);
  return url;
}

export function createBrowserlessPuppeteerProvider(options: BrowserlessProviderOptions): BrowserProvider {
  const id = options.id ?? randomUUID;
  const now = options.now ?? Date.now;
  const endpoint = new URL(options.endpoint);
  const reconnectEndpoint = endpointWithToken(options.endpoint, options.token).toString();

  const open = async (signal?: AbortSignal): Promise<BrowserConnection> => {
    if (signal?.aborted) throw new Error("Browser connection was cancelled.");
    const browser = await options.connect({ browserWSEndpoint: reconnectEndpoint });
    const metadata: BrowserConnectionMetadata = {
      connectionId: id(),
      provider: "browserless",
      endpointOrigin: endpoint.origin,
      ownership: { browser: "browserless", connection: "automation-worker", reconnectEndpoint: "automation-worker" },
      reconnectable: true,
      connectedAt: new Date(now()).toISOString(),
    };
    return {
      browser,
      metadata,
      reconnect: () => open(signal),
      disconnect: async () => {
        await browser.disconnect();
      },
    };
  };
  return { open };
}

export function assertNoPatchrightInDistributedMode(mode: "distributed" | "local", providerName: string): void {
  if (mode === "distributed" && providerName.toLowerCase() === "patchright") {
    throw new ConfigurationError("Patchright is not supported in distributed automation mode; use Browserless.");
  }
}
