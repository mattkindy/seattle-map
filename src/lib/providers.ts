// Generic provider selection, shared by the traffic and matrix
// registries. A provider declares whether it can run given the
// environment; selection takes an explicit override by name, otherwise
// the first available provider in registry order wins. Registries list
// measured sources before fallbacks, so order encodes preference.

export interface ProviderCtx {
  env: NodeJS.ProcessEnv;
  /** Repo root, for providers that depend on fetched data files. */
  root: string;
  log: (message: string) => void;
}

export interface Provider {
  name: string;
  available(ctx: ProviderCtx): boolean;
}

export function selectProvider<P extends Provider>(
  providers: readonly P[],
  ctx: ProviderCtx,
  override?: string,
): P {
  if (override) {
    const p = providers.find((x) => x.name === override);
    if (!p) {
      throw new Error(
        `unknown provider "${override}"; known: ` +
          providers.map((x) => x.name).join(", "),
      );
    }
    return p;
  }
  const p = providers.find((x) => x.available(ctx));
  if (!p) {
    throw new Error("no provider available");
  }
  return p;
}
