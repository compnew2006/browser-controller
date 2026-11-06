# Local paired browser performance harness

The harness serves fixed pages on `127.0.0.1` and runs the same named scenarios against two caller-provided adapters. It does not open the user's browser, access browser-controller state, pair an extension, or install anything. It does not ship an adapter for either browser-controller or agent-browser: their actual timings remain unmeasured until adapters are supplied and exercised.

Use trusted local adapter modules that open **separate, isolated browser profiles**, restrict navigation and traffic to the supplied loopback URL, and clean up their own processes and temporary state. The runner cannot enforce adapter isolation. A module exports `default` with `createSession({ baseUrl, mode, measure })`; the session exposes `reset({ baseUrl, scenario })`, `run({ baseUrl, scenario, mode, measure, recordRequest })` and `close()`. Reset must restore and verify the initial fixture state before every sample, including warm samples. Return `{ success: true }` only after the scenario's postcondition is observed. The scenario names are `navigation`, `input`, `form`, `spa`, `iframe` and `batch`.

Run two trusted adapters explicitly:

```sh
node scripts/browser-performance-run.mjs --adapter-a /absolute/path/to/adapter-a.mjs --adapter-b /absolute/path/to/adapter-b.mjs --ack-isolated --iterations 30 --warmups 1
```

Cold samples include session creation and cleanup. Sample durations include reset for both modes; adapters must use equivalent reset procedures. Warm samples reuse a session per adapter and scenario after warmup. Adapter execution order alternates per sample. All durations use a monotonic clock; p50 and p95 use nearest rank. Overall, successful, and failed sample durations are reported separately. The report counts successful and failed samples, tool requests and payload bytes recorded by the adapter. No responses, inputs, URLs, exception messages, actual model token counts or browser profile details are included.

`measure(phase, async () => ...)` wraps an actually observed phase: `connection`, `tab_lookup`, `target_resolution`, `input_dispatch`, `settle`, or `save`. The `save` phase is appropriate only for an explicit observed save condition. An unmeasured phase reports zero samples and null percentiles. `recordRequest(bytes)` records a request count and payload size; pass a byte count, never payload text. Connection measurement for a reused warm session belongs in the adapter's actual reuse operation. Warm session setup and warmup calls are excluded from measured samples.

Interpretation depends on adapter correctness, equivalent actions and postconditions, matched browser/viewport/cache conditions, stable system load and instrumentation overhead. The paired harness is a measurement framework, not proof of browser-controller performance or of safe profile isolation.
