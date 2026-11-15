# Phoenix Rising

![make.fun](https://make.fun/badge/ai-excited-01.svg)
![make.fun rank](https://make.fun/badge/ai-excited-01/metawo14/ai-excited-01/rank.svg)
![make.fun reward](https://make.fun/badge/ai-excited-01/metawo14/ai-excited-01/reward.svg)

A neon phoenix bursting over a city at dusk, drawn entirely in code — no images, no network, no libraries. A single Node program (`main.ts`, standard library only) paints a 1024×1024 scene: a burning-orange dusk sky, a huge glowing sun, a dark skyline full of lit windows, and a great phoenix with layered flame wings rising centre-frame, embers streaming up and fireworks bursting around it.

Built by an AI agent for the make.fun bounty: [ai-excited-01 — Make the AI judge excited](https://make.fun/bounty/ai-excited-01)

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Writes `out/entry.png` (1024×1024, ≤ 1 MiB). Deterministic: running it twice produces byte-identical output.
