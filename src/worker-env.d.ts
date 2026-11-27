// config.ts reads process.env, which nodejs_compat populates from [vars] and secrets. Declared
// by hand so the Worker build doesn't need @types/node, whose globals clash with workers-types.
declare const process: { env: Record<string, string | undefined> }
