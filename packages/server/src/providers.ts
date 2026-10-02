import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ConversationModel,
  type CopilotModel,
  CopilotModelsFileSchema,
  type CopilotProvider,
  type ProviderModelConfig,
  type ProviderPreferences,
  ProviderPreferencesSchema,
  type ProviderTestCode,
  type ProviderTestResult,
  type ThinkingLevel,
} from "@argelanderspace/contracts";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AsyncLock } from "./lock.js";
import { ProviderCredentialStore } from "./provider-credentials.js";

export class ProviderSettingsError extends Error {
  constructor(
    readonly code: "storage" | "invalid_config" | "capabilities" | "not_found" | "unsupported"
  ) {
    super(code);
  }
}

export interface ProviderSettingsOptions {
  /** Composition seam: tests supply their own temp XDG-derived directory. */
  configDir?: string;
  testTimeoutMs?: number;
}

function privatePath(path: string, directory: boolean): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    stat.uid !== process.getuid?.()
  ) {
    throw new ProviderSettingsError("storage");
  }
}

function parseFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ProviderSettingsError("storage");
  }
}

/** Credentials use the Pi shape; reject corrupt/command entries before SDK authentication. */
function validateAuth(path: string): void {
  if (!existsSync(path)) return;
  const raw = parseFile(path);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ProviderSettingsError("storage");
  for (const entry of Object.values(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ProviderSettingsError("storage");
    const value = entry as Record<string, unknown>;
    if (value.type === "api_key") {
      if (
        typeof value.key !== "string" ||
        !value.key.trim() ||
        value.key.startsWith("!") ||
        value.key.replaceAll("$$", "").includes("$") ||
        Object.keys(value).some((key) => !["type", "key"].includes(key))
      )
        throw new ProviderSettingsError("storage");
    } else if (value.type === "oauth") {
      if (
        typeof value.access !== "string" ||
        typeof value.refresh !== "string" ||
        typeof value.expires !== "number"
      )
        throw new ProviderSettingsError("storage");
    } else throw new ProviderSettingsError("storage");
  }
}

export class ProviderSettings {
  readonly configDir: string;
  private runtime?: Promise<ModelRuntime>;
  private catalog?: Promise<Provider[]>;
  private readonly lock = new AsyncLock();
  private readonly catalogErrors = new Set<string>();
  private readonly customModels = new Set<string>();
  private readonly testTimeoutMs: number;

  constructor(options: ProviderSettingsOptions = {}) {
    this.configDir =
      options.configDir ??
      join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "argelanderspace", "copilot");
    this.testTimeoutMs = options.testTimeoutMs ?? 30_000;
  }

  private path(file: string): string {
    return join(this.configDir, file);
  }

  private guard(): void {
    try {
      // Refuse symlinks in the application-owned ancestry, too.
      for (const path of [dirname(this.configDir), this.configDir]) {
        try {
          if (lstatSync(path).isSymbolicLink()) throw new ProviderSettingsError("storage");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      privatePath(this.configDir, true);
      mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
      privatePath(this.configDir, true);
      for (const file of ["auth.json", "models.json", "preferences.json", "models-store.json"])
        privatePath(this.path(file), false);
      validateAuth(this.path("auth.json"));
      if (
        existsSync(this.path("models.json")) &&
        !CopilotModelsFileSchema.safeParse(parseFile(this.path("models.json"))).success
      )
        throw new ProviderSettingsError("storage");
      this.preferences();
    } catch {
      throw new ProviderSettingsError("storage");
    }
  }

  private preferences(): ProviderPreferences {
    if (!existsSync(this.path("preferences.json"))) return { version: 1, models: {} };
    const result = ProviderPreferencesSchema.safeParse(parseFile(this.path("preferences.json")));
    if (!result.success) throw new ProviderSettingsError("storage");
    return result.data;
  }

  /** No discovery, CLI, or session: this is only the public Node model runtime. */
  async getRuntime(): Promise<ModelRuntime> {
    this.guard();
    if (!this.runtime) {
      this.runtime = import("@earendil-works/pi-coding-agent")
        .then(({ ModelRuntime }) =>
          ModelRuntime.create({
            credentials: new ProviderCredentialStore(
              this.path("auth.json"),
              () => this.guard(),
              validateAuth
            ),
            modelsPath: this.path("models.json"),
            modelsStorePath: this.path("models-store.json"),
            allowModelNetwork: false,
            refreshOnCreate: false,
          })
        )
        .then((runtime) => {
          if (runtime.getError()) throw new ProviderSettingsError("storage");
          // Catalog models have Pi adapter capabilities. Custom IDs cannot invent thinking levels.
          const configured = existsSync(this.path("models.json"))
            ? CopilotModelsFileSchema.parse(parseFile(this.path("models.json")))
            : { providers: {} };
          for (const [provider, config] of Object.entries(configured.providers)) {
            for (const model of config.models ?? [])
              this.customModels.add(`${provider}/${model.id}`);
          }
          return runtime;
        })
        .catch(() => {
          this.runtime = undefined;
          throw new ProviderSettingsError("storage");
        });
    }
    return this.runtime;
  }

  private allowed(provider: Provider): boolean {
    // Pi 1.0.0 gives these providers account/profile prompts, not a single secret login.
    const extraInteraction = [
      "amazon-bedrock",
      "google-vertex",
      "cloudflare-workers-ai",
      "cloudflare-ai-gateway",
    ];
    return (
      (!extraInteraction.includes(provider.id) && !!provider.auth.apiKey?.login) ||
      provider.id === "openai-codex"
    );
  }

  private async provider(id: string): Promise<{ runtime: ModelRuntime; provider: Provider }> {
    const runtime = await this.getRuntime();
    const provider = runtime.getProvider(id);
    if (!provider || !this.allowed(provider)) throw new ProviderSettingsError("not_found");
    return { runtime, provider };
  }

  private async capabilitiesKnown(model: Model<Api>): Promise<boolean> {
    if (this.customModels.has(`${model.provider}/${model.id}`)) return false;
    this.catalog ??= import("@earendil-works/pi-ai/providers/all").then(({ builtinProviders }) =>
      builtinProviders()
    );
    const provider = (await this.catalog).find((item) => item.id === model.provider);
    const endpoint =
      provider?.getModels().find((item) => item.id === model.id)?.baseUrl ?? provider?.baseUrl;
    return !!endpoint && model.baseUrl === endpoint;
  }

  async modelDto(model: Model<Api>): Promise<CopilotModel> {
    const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
    const preference = this.preferences().models[model.provider]?.[model.id];
    const known = await this.capabilitiesKnown(model);
    const levels = known ? getSupportedThinkingLevels(model) : [];
    const defaultThinking = preference?.defaultThinking ?? null;
    return {
      id: model.id,
      name: model.name,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      image: model.input.includes("image"),
      tools: preference?.tools ?? true,
      thinkingLevels: levels,
      capabilitiesKnown: known,
      defaultThinking,
      defaultThinkingValid: defaultThinking === null || levels.includes(defaultThinking),
    };
  }

  /** Shared by settings and the subsequent conversation selector; validate before SDK clamp. */
  async resolveThinking(
    providerId: string,
    modelId: string,
    choice: ThinkingLevel | null
  ): Promise<ThinkingLevel | undefined> {
    const { runtime } = await this.provider(providerId);
    const model = runtime.getModel(providerId, modelId);
    if (!model) throw new ProviderSettingsError("not_found");
    const dto = await this.modelDto(model);
    if (!dto.capabilitiesKnown) {
      if (choice === null && dto.defaultThinking === null) return undefined;
      throw new ProviderSettingsError("capabilities");
    }
    const { clampThinkingLevel } = await import("@earendil-works/pi-ai");
    const actual = choice ?? dto.defaultThinking ?? clampThinkingLevel(model, "medium");
    if (!dto.thinkingLevels.includes(actual)) throw new ProviderSettingsError("capabilities");
    return actual;
  }

  /** Capture one conversation request under the same settings lock as credential/config changes. */
  async captureConversation(choice: ConversationModel, authenticate: boolean) {
    return this.lock.run(async () => {
      const { runtime, provider } = await this.provider(choice.provider);
      const model = runtime.getModel(choice.provider, choice.model);
      if (!model || !(await this.modelDto(model)).tools)
        throw new ProviderSettingsError("capabilities");
      const thinking = await this.resolveThinking(choice.provider, choice.model, choice.thinking);
      const auth = authenticate ? await runtime.getAuth(model) : undefined;
      return {
        runtime,
        provider,
        model: structuredClone(model),
        thinking,
        auth: auth ? structuredClone(auth) : undefined,
      };
    });
  }

  private async dto(id: string): Promise<CopilotProvider> {
    const { runtime, provider } = await this.provider(id);
    const stored = (await runtime.listCredentials()).some((item) => item.providerId === id);
    let configured = stored;
    if (!stored) {
      try {
        configured = !!(await runtime.checkAuth(id));
      } catch {
        this.catalogErrors.add(id);
      }
    }
    return {
      id,
      name: provider.name,
      method: id === "openai-codex" ? "oauth" : "api_key",
      credential: {
        configured,
        stored,
        source: stored ? "stored" : configured ? "environment" : "none",
      },
      models: await Promise.all(runtime.getModels(id).map((model) => this.modelDto(model))),
      catalogStatus: this.catalogErrors.has(id) ? "error" : "ready",
    };
  }

  async list(): Promise<CopilotProvider[]> {
    return this.lock.run(async () => {
      const runtime = await this.getRuntime();
      const providers = runtime
        .getProviders()
        .filter((provider) => this.allowed(provider) && runtime.getModels(provider.id).length > 0);
      const refreshed = await runtime.refresh({
        allowNetwork: false,
        providers: providers.map((provider) => provider.id),
      });
      for (const provider of providers) {
        if (refreshed.errors.has(provider.id)) this.catalogErrors.add(provider.id);
        else this.catalogErrors.delete(provider.id);
      }
      return Promise.all(providers.map((provider) => this.dto(provider.id)));
    });
  }

  async credential(id: string, key: string | null): Promise<CopilotProvider> {
    return this.lock.run(async () => {
      const { runtime, provider } = await this.provider(id);
      if (!provider.auth.apiKey?.login || id === "openai-codex")
        throw new ProviderSettingsError("unsupported");
      const { CredentialSynchronizationError } = await import("@earendil-works/pi-coding-agent");
      this.catalogErrors.delete(id);
      try {
        if (key === null) await runtime.logout(id);
        else
          await runtime.login(id, "api_key", {
            prompt: async (prompt) => {
              if (prompt.type !== "secret") throw new ProviderSettingsError("unsupported");
              // The public credential store preserves literal secrets without environment resolution.
              return key;
            },
            notify: () => {},
          });
      } catch (error) {
        if (error instanceof CredentialSynchronizationError) this.catalogErrors.add(id);
        else
          throw new ProviderSettingsError(
            error instanceof ProviderSettingsError ? error.code : "storage"
          );
      }
      this.guard();
      // SDK stores can report best-effort errors: disk is the persistence proof.
      const saved = parseFile(this.path("auth.json")) as Record<string, { key?: string }>;
      if (
        key === null ? saved[id] !== undefined : saved[id]?.key !== key.replaceAll("$", () => "$$")
      )
        throw new ProviderSettingsError("storage");
      return this.dto(id);
    });
  }

  private async draft(
    id: string,
    config: ProviderModelConfig
  ): Promise<{ model: Model<Api>; catalogModel: boolean }> {
    const { runtime } = await this.provider(id);
    const current = runtime.getModel(id, config.modelId);
    const template = current ?? runtime.getModels(id)[0];
    if (!template) throw new ProviderSettingsError("not_found");
    const catalogModel = !!current && !this.customModels.has(`${id}/${config.modelId}`);
    const known =
      !!current && (await this.capabilitiesKnown({ ...current, baseUrl: config.baseUrl }));
    const model = {
      ...template,
      id: config.modelId,
      name: config.name,
      baseUrl: config.baseUrl,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      input: config.image
        ? (["text", "image"] as ("text" | "image")[])
        : (["text"] as ("text" | "image")[]),
      ...(known ? {} : { reasoning: false, thinkingLevelMap: undefined }),
    };
    const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
    if (
      config.defaultThinking !== null &&
      (!known || !getSupportedThinkingLevels(model).includes(config.defaultThinking))
    )
      throw new ProviderSettingsError("capabilities");
    return { model, catalogModel };
  }

  async configure(id: string, config: ProviderModelConfig): Promise<CopilotProvider> {
    return this.lock.run(async () => {
      const { model, catalogModel } = await this.draft(id, config);
      const file = this.path("models.json");
      const previous = existsSync(file) ? readFileSync(file) : undefined;
      const models = previous
        ? CopilotModelsFileSchema.parse(JSON.parse(previous.toString()))
        : { providers: {} };
      const providerConfig = models.providers[id] ?? {};
      providerConfig.baseUrl = config.baseUrl;
      const fields = {
        name: config.name,
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        input: model.input,
      };
      if (catalogModel)
        providerConfig.modelOverrides = {
          ...providerConfig.modelOverrides,
          [config.modelId]: fields,
        };
      else
        providerConfig.models = [
          ...(providerConfig.models ?? []).filter((item) => item.id !== config.modelId),
          { id: model.id, api: model.api, reasoning: false, ...fields },
        ];
      models.providers[id] = providerConfig;
      const stage = this.path(`models-${randomUUID()}.tmp`);
      const preferencesPath = this.path("preferences.json");
      const oldPreferences = existsSync(preferencesPath)
        ? readFileSync(preferencesPath)
        : undefined;
      const preferences = this.preferences();
      preferences.models[id] = {
        ...preferences.models[id],
        [model.id]: { tools: config.tools, defaultThinking: config.defaultThinking },
      };
      const preferenceStage = this.path(`preferences-${randomUUID()}.tmp`);
      try {
        writeFileSync(
          stage,
          `${JSON.stringify(CopilotModelsFileSchema.parse(models), null, 2)}\n`,
          { mode: 0o600, flag: "wx" }
        );
        const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
        const candidate = await ModelRuntime.create({
          credentials: new ProviderCredentialStore(
            this.path("auth.json"),
            () => this.guard(),
            validateAuth
          ),
          modelsPath: stage,
          modelsStorePath: this.path("models-store.json"),
          refreshOnCreate: false,
          allowModelNetwork: false,
        });
        if (candidate.getError()) throw new ProviderSettingsError("invalid_config");
        writeFileSync(
          preferenceStage,
          `${JSON.stringify(ProviderPreferencesSchema.parse(preferences), null, 2)}\n`,
          { mode: 0o600, flag: "wx" }
        );
        this.guard();
        renameSync(preferenceStage, preferencesPath);
        try {
          renameSync(stage, file);
        } catch {
          if (oldPreferences) {
            writeFileSync(preferenceStage, oldPreferences, { mode: 0o600, flag: "wx" });
            renameSync(preferenceStage, preferencesPath);
          } else rmSync(preferencesPath);
          throw new ProviderSettingsError("storage");
        }
        this.runtime = undefined;
        return await this.dto(id);
      } catch (error) {
        throw new ProviderSettingsError(
          error instanceof ProviderSettingsError ? error.code : "storage"
        );
      } finally {
        rmSync(stage, { force: true });
        rmSync(preferenceStage, { force: true });
      }
    });
  }

  async test(
    id: string,
    config: ProviderModelConfig,
    requestSignal: AbortSignal
  ): Promise<ProviderTestResult> {
    // Capture the immutable model and resolved auth before releasing the short settings lock.
    const timeout = AbortSignal.timeout(this.testTimeoutMs);
    const signal = AbortSignal.any([requestSignal, timeout]);
    const code = (value: ProviderTestCode): ProviderTestResult => ({
      code: value,
      retryable: !["success", "cancelled"].includes(value),
    });
    try {
      const { provider, model, auth } = await withSignal(
        this.lock.run(async () => {
          signal.throwIfAborted();
          const { runtime, provider } = await this.provider(id);
          const { model } = await this.draft(id, config);
          const auth = await runtime.getAuth(model, { signal });
          return { provider, model, auth };
        }),
        signal
      );
      if (!auth) return code("credentials");
      const { normalizeContext } = await import("@earendil-works/pi-ai");
      const pending = provider
        .streamSimple(
          auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model,
          normalizeContext({
            messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
          }),
          {
            signal,
            maxTokens: 32,
            reasoning: undefined,
            apiKey: auth.auth.apiKey,
            env: auth.env,
            headers: auth.auth.headers,
          }
        )
        .result();
      // Bound even an adapter that fails to honor cancellation. Never serialize its response/error.
      const result = await withSignal(pending, signal);
      if (signal.aborted) return code(timeout.aborted ? "timeout" : "cancelled");
      if (result.stopReason === "aborted") return code("cancelled");
      if (result.stopReason === "error") return code(classifyProviderFailure(result.errorMessage));
      return code("success");
    } catch (error) {
      if (signal.aborted) return code(timeout.aborted ? "timeout" : "cancelled");
      if (error instanceof ProviderSettingsError)
        return code(error.code === "capabilities" ? "capabilities" : "unavailable");
      return code(classifyProviderFailure(error));
    }
  }
}

function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function classifyProviderFailure(error: unknown): ProviderTestCode {
  // Only examine internally; external SDK strings can contain request credentials.
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (/\b429\b|rate.?limit/i.test(text)) return "rate_limited";
  if (/\b401\b|\b403\b|api.?key|unauthori|authentication/i.test(text)) return "credentials";
  if (/model.*(?:not found|not exist|invalid|unavailable)/i.test(text)) return "model";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/\b404\b|fetch|connect|network|endpoint|ENOTFOUND|ECONN/i.test(text)) return "endpoint";
  return "unavailable";
}
