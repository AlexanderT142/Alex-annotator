import { AiProviderError, type AiConnectionSettings } from "./ai-provider";

type Identity = { provider: string; protocol: string; baseUrl: string };
const LEGACY_KEY = "local-pdf-annotator.ai-api-key";

export function connectionIdentity(connection: Identity): string {
  const url = new URL(connection.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new AiProviderError("Use an HTTPS provider base URL without credentials, query parameters, or fragments. HTTP is supported only on localhost.");
  }
  return `${connection.provider}|${connection.protocol}|${url.href.replace(/\/+$/, "")}`;
}

export function connectionForJob(current: AiConnectionSettings, job: Identity & { model: string }): AiConnectionSettings {
  if (connectionIdentity(current) !== connectionIdentity(job)) {
    throw new AiProviderError(`Select the original ${job.provider} connection before resuming this job. No request was sent.`);
  }
  if (!current.apiKey.trim()) throw new AiProviderError("Add a key for this provider before starting or resuming the job.");
  return { ...current, model: job.model };
}

/** Credentials are separated by provider, protocol and endpoint. A key is never
 * carried across a provider change, including between custom endpoints. */
export class AiCredentialStore {
  constructor(private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}

  read(connection: Identity): string {
    if (!connection.baseUrl) return "";
    return this.storage.getItem(this.key(connection)) ?? "";
  }

  write(connection: Identity, value: string): void {
    const key = this.key(connection);
    if (value.trim()) this.storage.setItem(key, value.trim());
    else this.storage.removeItem(key);
  }

  migrate(connection: Identity, vaultKey: string): string {
    const existing = this.read(connection);
    const legacy = this.storage.getItem(LEGACY_KEY) ?? "";
    const value = existing || vaultKey || legacy;
    if (value && !existing) {
      this.write(connection, value);
      if (this.read(connection) !== value) throw new Error("Could not verify device-local key storage.");
    }
    // Remove the old unscoped value only after the new copy is confirmed.
    if (legacy) this.storage.removeItem(LEGACY_KEY);
    return value;
  }

  private key(connection: Identity): string {
    return `local-pdf-annotator.ai-key.v2.${encodeURIComponent(connectionIdentity(connection))}`;
  }
}
