export const KIND_LADDER = [["type", "lint"], ["runtime"], ["model"], ["review"], ["instruction"], ["legacy"]];
export const kindRank = (kind) => KIND_LADDER.findIndex((tier) => tier.includes(kind));
export const BENCH_DEFAULTS = { baseFiles: 25, maxFiles: 3200, minMarginalMs: 20, linearMax: 1.15, sublinearMax: 0.9, constantMs: 5 };
export const benchSettings = (config) => ({ ...BENCH_DEFAULTS, ...config.bench });
