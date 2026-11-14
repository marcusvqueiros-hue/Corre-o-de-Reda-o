import type sodiumType from "libsodium-wrappers-sumo";

let cached: Promise<typeof sodiumType> | null = null;

/** Carrega o libsodium (WASM) sob demanda, só no cliente, uma única vez. */
export function getSodium(): Promise<typeof sodiumType> {
  cached ??= import("libsodium-wrappers-sumo").then(async (m) => {
    const sodium = (m.default ?? m) as typeof sodiumType;
    await sodium.ready;
    return sodium;
  });
  return cached;
}
