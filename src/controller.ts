import { EventEmitter } from "events";
import { Categories, Logging } from "homebridge";
import { blue, bold, green, yellow } from "kolorist";
import { get } from "lodash";
import { HOMEBRIDGE_TYDOM_PASSWORD } from "src/config/env";
import { TydomAccessoryUpdateType } from "src/helpers";
import {
  asyncWait,
  getEndpointDetailsFromMeta,
  getEndpointGroupIdFromGroups,
  resolveEndpointCategory,
} from "src/helpers/tydom";
import { TydomPlatformConfig } from "src/platform";
import {
  TydomAccessoryContext,
  TydomAccessoryUpdateContext,
  TydomConfigResponse,
  TydomDeviceDataUpdateBody,
  TydomGroupsResponse,
  TydomMetaResponse,
} from "src/typings/tydom";
import { assert, chalkJson, chalkNumber, chalkString, debug, decode, stringIncludes } from "src/utils";
import { stringifyError } from "src/utils/error";
import TydomClient, {
  createClient as createTydomClient,
  type TydomHttpMessage,
  type TydomRequestBody,
  type TydomResponse,
} from "tydom-client";

export type ControllerDevicePayload = TydomAccessoryContext;

export type ControllerUpdatePayload = {
  type: TydomAccessoryUpdateType;
  category: Categories;
  updates: Record<string, unknown>[];
  context: TydomAccessoryContext;
};

export type ControllerNotificationPayload = {
  level: string;
  message: string;
};

const DEFAULT_REFRESH_INTERVAL_SEC = 4 * 60 * 60; // 4 hours
const DEFAULT_PRIMARY_RETRY_INTERVAL_SEC = 5 * 60; // 5 minutes
const RECONNECT_BASE_DELAY_MS = 5 * 1000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;

type TydomConnectionTarget = {
  hostname: string;
  type: "primary" | "local";
};

type TydomClientOperation<T> = (client: TydomClient) => Promise<T>;

type TydomFailoverOptions = {
  retryOperation?: boolean | ((err: unknown) => boolean);
};

export default class TydomController extends EventEmitter {
  public client: TydomClient;
  public config: TydomPlatformConfig;
  public log: Logging;
  private activeClient?: TydomClient;
  private activeHostname?: string;
  private activeTargetType?: TydomConnectionTarget["type"];
  private readonly password: string;
  private failoverPromise?: Promise<void>;
  private devices = new Map<string, Categories>();
  private state = new Map<string, unknown>();
  private refreshInterval?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private primaryRetryTimeout?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private closingClients = new WeakSet<TydomClient>();
  private hasConnectedOnce = false;
  constructor(log: Logging, config: TydomPlatformConfig) {
    super();
    this.config = config;
    this.log = log;
    const { hostname, localHostname, username, password: configPassword } = config;
    assert(hostname, 'Missing "hostname" config field for platform');
    assert(username, 'Missing "username" config field for platform');
    const password = HOMEBRIDGE_TYDOM_PASSWORD ? decode(HOMEBRIDGE_TYDOM_PASSWORD) : configPassword;
    assert(password, 'Missing "password" config field for platform');
    this.password = password;
    this.client = this.createClientFacade();
    if (localHostname && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
      this.log.warn(
        `Local Tydom fallback hostname=${chalkString(
          localHostname,
        )} is configured but NODE_TLS_REJECT_UNAUTHORIZED is not set to 0; the local self-signed certificate may be rejected`,
      );
    }
  }
  getUniqueId(deviceId: number, endpointId: number): string {
    return deviceId === endpointId ? `${deviceId}` : `${deviceId}:${endpointId}`;
  }
  getAccessoryId(deviceId: number, endpointId: number): string {
    const { username } = this.config;
    return `tydom:${username.slice(6)}:accessories:${this.getUniqueId(deviceId, endpointId)}`;
  }
  async connect(): Promise<void> {
    const { hostname, username } = this.config;
    try {
      await this.establishConnection(false);
    } catch (err) {
      this.log.error(`Failed to connect to Tydom hostname=${hostname} with username="${username}"`);
      throw err;
    }
  }
  async sync(): Promise<{
    config: TydomConfigResponse;
    groups: TydomGroupsResponse;
    meta: TydomMetaResponse;
  }> {
    const { hostname, refreshInterval = DEFAULT_REFRESH_INTERVAL_SEC } = this.config;
    debug(`Syncing state from hostname=${chalkString(hostname)}...`);
    const config = await this.client.get<TydomConfigResponse>("/configs/file");
    const groups = await this.client.get<TydomGroupsResponse>("/groups/file");
    const meta = await this.client.get<TydomMetaResponse>("/devices/meta");
    // Final outro handshake
    await this.refresh();
    if (this.refreshInterval) {
      debug(`Removing existing refresh interval`);
      clearInterval(this.refreshInterval);
    }
    debug(`Configuring refresh interval of ${chalkNumber(Math.round(refreshInterval))}s`);
    this.refreshInterval = setInterval(async () => {
      try {
        await this.refresh();
      } catch (err) {
        debug(`Failed interval refresh with err ${stringifyError(err as Error)}`);
      }
    }, refreshInterval * 1000);
    Object.assign(this.state, { config, groups, meta });
    return { config, groups, meta };
  }
  async scan(): Promise<void> {
    const { hostname } = this.config;
    this.log.info(`Scaning devices from hostname=${chalkString(hostname)}...`);
    const {
      settings = {},
      includedDevices = [],
      excludedDevices = [],
      includedCategories = [],
      excludedCategories = [],
    } = this.config;
    const { config, groups, meta } = await this.sync();
    const { endpoints, groups: configGroups } = config;
    endpoints.forEach((endpoint) => {
      const {
        id_endpoint: endpointId,
        id_device: deviceId,
        name: deviceName,
        first_usage: firstUsage,
      } = endpoint;
      const uniqueId = this.getUniqueId(deviceId, endpointId);
      const { metadata } = getEndpointDetailsFromMeta(endpoint, meta);
      const groupId = getEndpointGroupIdFromGroups(endpoint, groups);
      const group = groupId !== null ? configGroups.find(({ id }) => id === groupId) : undefined;
      const deviceSettings = settings[deviceId] ?? {};
      const categoryFromSettings = deviceSettings.category;
      // @TODO resolve endpoint productType
      this.log.info(
        `Found new device with firstUsage=${chalkString(firstUsage)}, deviceId=${chalkNumber(
          deviceId,
        )} and endpointId=${chalkNumber(endpointId)}`,
      );
      if (includedDevices.length && !stringIncludes(includedDevices, deviceId)) {
        return;
      }
      if (excludedDevices.length && stringIncludes(excludedDevices, deviceId)) {
        return;
      }
      if (categoryFromSettings) {
        this.log.info(
          `Using overriden category=${chalkNumber(categoryFromSettings)} from settings for deviceId=${chalkNumber(
            deviceId,
          )} and endpointId=${chalkNumber(endpointId)}`,
        );
      }
      const category =
        categoryFromSettings ?? resolveEndpointCategory({ firstUsage, metadata, settings: deviceSettings });
      if (!category) {
        this.log.warn(`Unsupported firstUsage="${firstUsage}" for endpoint with deviceId="${deviceId}"`);
        debug({ endpoint });
        return;
      }
      if (includedCategories.length && !stringIncludes(includedCategories, category)) {
        return;
      }
      if (excludedCategories.length && stringIncludes(excludedCategories, category)) {
        return;
      }
      if (!this.devices.has(uniqueId)) {
        this.log.info(
          `Adding new device with firstUsage=${chalkString(firstUsage)}, deviceId=${chalkNumber(
            deviceId,
          )} and endpointId=${chalkNumber(endpointId)}`,
        );
        const accessoryId = this.getAccessoryId(deviceId, endpointId);
        const nameFromSetting = get(settings, `${deviceId}.name`) as string | undefined;
        const name = nameFromSetting ?? deviceName;
        this.devices.set(uniqueId, category);
        const context: TydomAccessoryContext = {
          name,
          category,
          metadata,
          settings: deviceSettings,
          group,
          deviceId,
          endpointId,
          accessoryId,
          manufacturer: "Delta Dore",
          serialNumber: `ID${deviceId}`,
          // model: 'N/A',
          state: {},
        };
        this.emit("device", context);
      }
    });
  }
  async refresh(): Promise<void> {
    debug(`Refreshing Tydom controller ...`);
    await this.client.post("/refresh/all");
  }
  private createClientFacade(): TydomClient {
    return {
      close: (): void => {
        this.clearPrimaryRetryTimeout();
        this.clearReconnectTimeout();
        if (this.activeClient) {
          this.closeClient(this.activeClient);
        }
      },
      connect: async (): Promise<unknown> => {
        await this.connect();
        return undefined;
      },
      delete: async <T extends TydomResponse = TydomResponse>(url: string): Promise<T> =>
        await this.runWithFailover((client) => client.delete<T>(url), `DELETE ${url}`, {
          retryOperation: (err) => this.canRetryMutationAfterFailover(err),
        }),
      get: async <T extends TydomResponse = TydomResponse>(url: string): Promise<T> =>
        await this.runWithFailover((client) => client.get<T>(url), `GET ${url}`),
      post: async <T extends TydomResponse = TydomResponse>(
        url: string,
        body?: TydomRequestBody,
      ): Promise<T> =>
        await this.runWithFailover((client) => client.post<T>(url, body), `POST ${url}`, {
          retryOperation: (err) => this.canRetryMutationAfterFailover(err),
        }),
      put: async <T extends TydomResponse = TydomResponse>(url: string, body?: TydomRequestBody): Promise<T> =>
        await this.runWithFailover((client) => client.put<T>(url, body), `PUT ${url}`, {
          retryOperation: (err) => this.canRetryMutationAfterFailover(err),
        }),
      command: async <T extends TydomResponse = TydomResponse>(url: string): Promise<T[]> =>
        await this.runWithFailover((client) => client.command<T>(url), `COMMAND ${url}`),
      send: (rawHttpRequest: string): void => {
        assert(this.activeClient, "Tydom client is not connected");
        this.activeClient.send(rawHttpRequest);
      },
    } as TydomClient;
  }
  private getConnectionTargets(preferLocal: boolean): TydomConnectionTarget[] {
    const { hostname, localHostname } = this.config;
    const primaryTarget: TydomConnectionTarget = { hostname, type: "primary" };
    if (!localHostname || localHostname === hostname) {
      return [primaryTarget];
    }
    const localTarget: TydomConnectionTarget = { hostname: localHostname, type: "local" };
    return preferLocal ? [localTarget, primaryTarget] : [primaryTarget, localTarget];
  }
  private createClientForTarget({ hostname, type }: TydomConnectionTarget): TydomClient {
    const { username } = this.config;
    this.log.info(
      `Creating ${type} tydom client with username=${chalkString(username)} and hostname=${chalkString(
        hostname,
      )}`,
    );
    return createTydomClient({
      username,
      password: this.password,
      hostname,
      followUpDebounce: 500,
      retryOnClose: false,
    });
  }
  private async establishConnection(preferLocal: boolean): Promise<void> {
    const wasConnected = this.hasConnectedOnce;
    const target = await this.connectToFirstAvailableTarget(this.getConnectionTargets(preferLocal));
    if (wasConnected) {
      this.log.warn(`Reconnected to Tydom hostname=${chalkString(target.hostname)}, re-syncing state...`);
      this.resync().catch((err: unknown) => {
        this.log.error(`Failed to re-sync after reconnection: ${stringifyError(err as Error)}`);
      });
    } else {
      this.hasConnectedOnce = true;
    }
    this.emit("connect");
  }
  private async connectToFirstAvailableTarget(
    targets: TydomConnectionTarget[],
  ): Promise<TydomConnectionTarget> {
    let lastError: unknown;
    for (const target of targets) {
      debug(`Connecting to ${target.type} hostname=${chalkString(target.hostname)}...`);
      try {
        await this.connectToTarget(target);
        return target;
      } catch (err) {
        lastError = err;
        this.log.warn(
          `Failed to connect to ${target.type} Tydom hostname=${chalkString(target.hostname)}: ${stringifyError(
            err as Error,
          )}`,
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Failed to connect to any Tydom hostname");
  }
  private async connectToTarget(target: TydomConnectionTarget): Promise<void> {
    const client = this.createClientForTarget(target);
    this.attachClientHandlers(client, target);
    try {
      await client.connect();
      await asyncWait(250);
      await client.get("/ping");
      this.activateClient(client, target);
    } catch (err) {
      this.closeClient(client);
      throw err;
    }
  }
  private activateClient(client: TydomClient, target: TydomConnectionTarget): void {
    const previousClient = this.activeClient;
    this.activeClient = client;
    this.activeHostname = target.hostname;
    this.activeTargetType = target.type;
    this.reconnectAttempt = 0;
    this.clearReconnectTimeout();
    if (target.type === "local") {
      this.schedulePrimaryRetry();
    } else {
      this.clearPrimaryRetryTimeout();
    }
    if (previousClient && previousClient !== client) {
      this.closeClient(previousClient);
    }
    this.log.info(
      `Successfully connected to ${target.type} Tydom hostname=${chalkString(
        target.hostname,
      )} with username=${chalkString(this.config.username)}`,
    );
  }
  private attachClientHandlers(client: TydomClient, target: TydomConnectionTarget): void {
    client.on("message", (message: TydomHttpMessage) => {
      try {
        this.handleMessage(message);
      } catch (err) {
        this.log.error(
          `Encountered an uncaught error=${stringifyError(err as Error)} while processing message=${chalkJson(message)}"`,
        );
      }
    });
    client.on("disconnect", () => {
      if (this.closingClients.has(client) || this.activeClient !== client) {
        return;
      }
      this.log.warn(`Disconnected from ${target.type} Tydom hostname=${chalkString(target.hostname)}`);
      this.clearRefreshInterval();
      this.emit("disconnect");
      this.scheduleReconnect(target.type === "primary");
    });
  }
  private clearRefreshInterval(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }
  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
  }
  private clearPrimaryRetryTimeout(): void {
    if (this.primaryRetryTimeout) {
      clearTimeout(this.primaryRetryTimeout);
      this.primaryRetryTimeout = undefined;
    }
  }
  private closeClient(client: TydomClient): void {
    this.closingClients.add(client);
    client.close();
  }
  private async runWithFailover<T>(
    operation: TydomClientOperation<T>,
    operationName: string,
    { retryOperation = true }: TydomFailoverOptions = {},
  ): Promise<T> {
    assert(this.activeClient, "Tydom client is not connected");
    try {
      return await operation(this.activeClient);
    } catch (err) {
      if (!this.shouldTryLocalFallback()) {
        throw err;
      }
      this.log.warn(
        `Tydom ${operationName} failed on hostname=${chalkString(
          this.activeHostname ?? "unknown",
        )}, trying local fallback hostname=${chalkString(this.config.localHostname ?? "unknown")}: ${stringifyError(
          err as Error,
        )}`,
      );
      await this.failoverToLocal();
      const shouldRetryOperation = typeof retryOperation === "function" ? retryOperation(err) : retryOperation;
      if (!shouldRetryOperation) {
        throw err;
      }
      assert(this.activeClient, "Tydom client is not connected");
      return await operation(this.activeClient);
    }
  }
  private canRetryMutationAfterFailover(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
      message.includes("Required socket instance") || message.includes("Socket instance is closing/closed")
    );
  }
  private shouldTryLocalFallback(): boolean {
    const { localHostname } = this.config;
    return Boolean(localHostname && this.activeHostname !== localHostname);
  }
  private async failoverToLocal(): Promise<void> {
    this.failoverPromise ??= this.establishConnection(true).finally(() => {
      this.failoverPromise = undefined;
    });
    await this.failoverPromise;
  }
  private getPrimaryRetryIntervalMs(): number {
    const { primaryRetryInterval = DEFAULT_PRIMARY_RETRY_INTERVAL_SEC } = this.config;
    return Math.max(30, primaryRetryInterval) * 1000;
  }
  private schedulePrimaryRetry(): void {
    const { hostname, localHostname } = this.config;
    if (!localHostname || localHostname === hostname || this.activeTargetType !== "local") {
      return;
    }
    this.clearPrimaryRetryTimeout();
    const retryIntervalMs = this.getPrimaryRetryIntervalMs();
    debug(
      `Scheduling primary Tydom retry for hostname=${chalkString(hostname)} in ${chalkNumber(
        Math.round(retryIntervalMs / 1000),
      )}s while using local fallback`,
    );
    this.primaryRetryTimeout = setTimeout(() => {
      this.tryRestorePrimaryConnection().catch((err: unknown) => {
        this.log.warn(
          `Failed to restore primary Tydom hostname=${chalkString(hostname)}: ${stringifyError(err as Error)}`,
        );
        this.schedulePrimaryRetry();
      });
    }, retryIntervalMs);
  }
  private async tryRestorePrimaryConnection(): Promise<void> {
    const { hostname } = this.config;
    if (this.activeTargetType !== "local") {
      return;
    }
    this.log.info(`Checking if primary Tydom hostname=${chalkString(hostname)} is available again...`);
    await this.connectToTarget({ hostname, type: "primary" });
    this.log.warn(
      `Restored primary Tydom hostname=${chalkString(hostname)}, switching back from local fallback`,
    );
    this.resync().catch((err: unknown) => {
      this.log.error(`Failed to re-sync after primary restoration: ${stringifyError(err as Error)}`);
    });
    this.emit("connect");
  }
  private scheduleReconnect(preferLocal: boolean): void {
    this.clearReconnectTimeout();
    this.reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.log.warn(`Reconnecting to Tydom in ${Math.round(delay / 1000)}s...`);
    this.reconnectTimeout = setTimeout(() => {
      this.establishConnection(preferLocal).catch((err: unknown) => {
        this.log.error(`Failed to reconnect to Tydom: ${stringifyError(err as Error)}`);
        this.scheduleReconnect(preferLocal);
      });
    }, delay);
  }
  private async resync(): Promise<void> {
    const { hostname, refreshInterval = DEFAULT_REFRESH_INTERVAL_SEC } = this.config;
    debug(`Re-syncing state after reconnection to hostname=${chalkString(hostname)}...`);
    await asyncWait(250);
    await this.client.get("/ping");
    await this.refresh();
    // Re-establish refresh interval (cleared on disconnect)
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    debug(`Re-configuring refresh interval of ${chalkNumber(Math.round(refreshInterval))}s`);
    this.refreshInterval = setInterval(async () => {
      try {
        await this.refresh();
      } catch (err) {
        debug(`Failed interval refresh with err ${stringifyError(err as Error)}`);
      }
    }, refreshInterval * 1000);
  }
  handleMessage(message: TydomHttpMessage): void {
    const { uri, method, body } = message;
    const isDeviceUpdate = uri === "/devices/data" && method === "PUT";
    if (isDeviceUpdate) {
      this.handleDeviceDataUpdate(body, "data");
      return;
    }
    const isDeviceCommandUpdate = uri === "/devices/cdata" && method === "PUT";
    if (isDeviceCommandUpdate) {
      this.handleDeviceDataUpdate(body, "cdata");
      return;
    }
    debug(`Unkown message from Tydom client:\n${chalkJson(message)}`);
  }
  handleDeviceDataUpdate(body: TydomResponse, type: "data" | "cdata"): void {
    if (!Array.isArray(body)) {
      debug("Unsupported non-array device update", body);
      return;
    }
    (body as TydomDeviceDataUpdateBody).forEach((device) => {
      const { id: deviceId, endpoints } = device;
      for (const endpoint of endpoints) {
        const { id: endpointId, data, cdata } = endpoint;
        const updates = type === "data" ? data : cdata;
        const uniqueId = this.getUniqueId(deviceId, endpointId);
        if (!this.devices.has(uniqueId)) {
          debug(
            `${bold(yellow("←PUT"))}:${blue("ignored")} for device id=${chalkString(
              deviceId,
            )} and endpointId=${chalkNumber(endpointId)}`,
          );
          return;
        }
        const category = this.devices.get(uniqueId) ?? Categories.OTHER;
        const accessoryId = this.getAccessoryId(deviceId, endpointId);
        debug(
          `${bold(green("←PUT"))}:${blue("update")} for deviceId=${chalkNumber(deviceId)} and endpointId=${chalkNumber(
            endpointId,
          )}, updates:\n${chalkJson(updates)}`,
        );
        const context: TydomAccessoryUpdateContext = {
          category,
          deviceId,
          endpointId,
          accessoryId,
        };
        this.emit("update", {
          type,
          updates,
          context,
        } as ControllerUpdatePayload);
      }
    });
  }
}
