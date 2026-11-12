# Benchmarks

The bench compares duckdb-bun ("ours", loaded from `src/neo.ts`, the public entry) with a baseline ("baseline").
Both run under the same Bun, on the same machine, through the same public `@duckdb/node-api` calls.

## Baseline

`bench/baseline.ts` picks the baseline (ADR 0009):

1. The `@duckdb/node-api` reference in `devDependencies`, when it is built on the pinned DuckDB (`tests/reference.ts`).
   Bun loads its N-API addon, so no Node is involved.
2. Otherwise, after an upgrade to a DuckDB release that npm has no `@duckdb/node-api` for yet, the previous release of this package on npm.
   The bench installs it with `bun add` into its temporary directory, with its platform package, and runs it from there.
   This measures the new release against the last one, so a DuckDB upgrade never waits for `@duckdb/node-api`.
3. Otherwise, before the first release on npm, nothing: the bench runs ours alone and the gate has nothing to judge.

The report names the baseline in the gate's heading and in `baseline` in the JSON.

## Run

```sh
bun run bench
```

It needs libduckdb and the shim for the host platform (`bun run fetch-lib` and `bun run build:native`, see the main README).
It makes no network requests: inputs are generated locally, and extension autoinstall and autoload are off.
A full run takes a few minutes; run it on an otherwise idle machine, and never at the same time as another heavy suite.

Options, all optional:

```sh
bun run bench --scenario read-all,prepared   # only these scenarios
bun run bench --impl ours                    # only one implementation
bun run bench --rounds 2                     # rounds per scenario, overriding each scenario's default
bun run bench --rows 100000                  # rows in the generated files and tables (default 1000000)
bun run bench --lag-rows 600000000           # rows the event-loop lag query hashes (default 600000000)
```

`--rows 10000 --lag-rows 10000000 --rounds 2` gives a smoke run that finishes in under a minute.

## Scenarios

| Scenario         | What one run does                                                                                       | Runs per child |
| ---------------- | ------------------------------------------------------------------------------------------------------- | -------------- |
| `ingest-json`    | `CREATE OR REPLACE TABLE ... AS SELECT * FROM read_json_auto(...)` over a newline-delimited JSON file   | 5              |
| `ingest-csv`     | The same over a CSV file with the same rows, through `read_csv`                                         | 5              |
| `parquet-write`  | `COPY` a table of mixed types to a `.parquet` file                                                      | 5              |
| `read-all`       | `runAndReadAll("SELECT * FROM mixed")`, then `getRowObjects()`                                          | 5              |
| `prepared`       | `prepare` once, then `bindInteger` and `runAndReadAll` 10,000 times, each returning one row             | 5              |
| `event-loop-lag` | `SELECT sum(hash(i)) FROM range(N) t(i)` while a 10 ms `setInterval` records the gaps between its ticks | 3              |

The mixed table has 1M rows of INTEGER, VARCHAR, DOUBLE, TIMESTAMP, DECIMAL(18,2) and INTEGER[] columns.
The bench writes the JSON and CSV inputs with plain JavaScript before any child starts, so neither implementation pays for generating them.
All scenarios except `event-loop-lag` do one unmeasured warm-up run in each child first.
After the measured runs, each scenario checks its result (row counts, the prepared statement's returned id), and a wrong result is reported as an error.

## How it measures

The parent, `bench/main.ts`, starts one child process (`bench/runner.ts`) at a time, and each child does one measured run of one scenario on one implementation.
So RSS of one implementation or scenario never mixes with another.
Each scenario runs in rounds of baseline, ours, ours, baseline: 5 rounds, so 10 runs of each implementation, and 4 rounds for `event-loop-lag`.
Each baseline child and the ours child next to it form a pair, which ran seconds apart, and each row merges the runs of all the children.
A fixed order is biased: with the baseline always first, `getRowObjects` measured 25% slower for ours, and about 10% faster when ours went first.
The child opens an in-memory database with DuckDB's default thread count, runs the scenario, and writes its raw numbers as JSON for the parent.
A child that crashes, hangs for more than 15 minutes, or throws is reported with its error text, and the bench moves on.

## Read the tables

Each scenario prints one Markdown table with one row per implementation.

- **Median, Min, Max (ms)**: wall time of one measured run, from before the first call to after the last awaited result.
  Compare medians; a wide gap between min and max means the machine was noisy.
- **Run peak RSS (MiB)**: the highest `process.memoryUsage.rss()` during one measured run, which starts after a full garbage collection, as the median over the runs.
  This is what the gate compares: the whole-child peak depends on when the garbage collector happened to run, and in `read-all` two children of the same package differed by 9% on that alone.
- **Peak RSS (MiB)**: the highest `process.memoryUsage.rss()` a 10 ms timer in the child saw, also sampled before and after every run.
  The timer cannot fire while the JavaScript thread is blocked, so a peak reached inside a synchronous call can be missed.
- **Max RSS (MiB)**: the operating system's high-water mark for the child (`process.resourceUsage().maxRSS`), which catches what the timer misses.
  Both numbers cover the whole child: start-up, set-up such as creating the 1M-row table, and every run.
- **runAndReadAll, getRowObjects (ms)** in `read-all`: the median of each half of a run, the query with materialization, then the conversion to JavaScript objects.
- **Per call (us)** in `prepared`: the median run time divided by 10,000.
- **Max gap, p99 gap (ms)** in `event-loop-lag`: the gaps between consecutive ticks of the 10 ms interval while the query runs, the largest over all runs, and the median of the per-run 99th percentiles.
  A gap near 10 ms means the query ran off the JavaScript thread and the event loop stayed free.
  A gap near the query's length means the query blocked the event loop.
- **Ticks** in `event-loop-lag`: interval ticks recorded during one query; with a free event loop it is about the query's length divided by 10 ms.
- **Error**: the error text when the scenario failed or its result was wrong; the other cells then cover only the runs that finished.

Pick `--lag-rows` so the lag query takes about 5 seconds on the machine; the default takes 5 to 7 seconds on an Apple M5 with 10 cores.

## Gate

`bun run bench --gate` fails, with exit status 1, when ours does worse than the baseline on any scenario:

- The runs show ours more than 10% slower (`--max-slower`) at 99% confidence, and the medians differ by more than 5 ms.
- The run peaks show ours using more than 10% more RSS (`--max-memory`) at 99% confidence, and the medians differ by more than 16 MiB, which covers the baseline difference between the two packages at start-up.
- In `event-loop-lag`, the median over runs of ours' 99th percentile gap reaches 50 ms, or any single gap reaches 1000 ms, which only a blocked event loop shows.
  A single gap is not held to 50 ms: the macOS runner preempts the JS thread now and then, and showed single gaps of 85 and 95 ms for ours and official in one run.
- Either implementation fails or returns a wrong result.

The confidence comes from a one-sided Wilcoxon signed-rank test, a rank test that assumes no particular distribution, over the pairs.
For each pair it takes the log of ours over the baseline, minus the log of 1.1 for the 10% limit, and asks whether those differences lie above zero.
The p-value is exact: it counts every way of giving signs to the ranks, so 10 pairs can reach 1/1024 and 8 pairs 1/256.
The gate table prints the number of pairs, the median pair ratio and each p-value; a scenario fails below 0.01.

A fixed limit on two medians failed at random on CI, because the runners are noisy in different ways:

- On the Linux runner (4 vCPU), most scenarios spread by under 3%, but `parquet-write` runs took either about 115 ms or about 140 ms for both packages, so the median moved by which speed each child happened to hit.
- On the macOS runner (3 vCPU, virtualized), runs of one scenario spread by up to 60%: `ingest-csv` ran between 144 and 265 ms for the official package alone.
- RSS does not fall after a garbage collection, so pages kept from one run add to the next run's peak at random.

A test over unpaired runs failed at random too, because the macOS runner's noise comes in spells of a few seconds.
With two children per implementation in plain ABBA order, both ours children ran back to back.
On 2026-11-12 one spell made the official `parquet-write` runs of one child take 295 to 524 ms instead of 134 to 150 ms, and another made ours look 28% slower on `ingest-json` at p = 0.0036.
A Mann-Whitney U test counted the 10 runs of each package as independent, but runs in one spell are not.
Paired children see the same spell, so it moves a pair's ratio far less than either run.

With low noise, the test fails a real excess of a few percent over the limit; with the macOS runner's noise it fails only a large one, so the Linux job is the sharp gate.
`tests/bench-gate.test.ts` checks the exact p-values and replays the slow spells the macOS runner showed on 2026-11-12.
CI runs the gate on both platforms on every push, and the release workflow runs it before it publishes.
Each run uploads `bench/results/` as the `bench-<platform>` artifact.

## Results

Each run also writes `bench/results/<date>-<platform>.json`, and the same tables, with the gate, as `bench/results/<date>-<platform>.md`; for example `bench/results/2026-11-12-darwin-arm64.json`.
It holds the machine, the Bun and package versions, the options, and for each scenario and implementation the summary plus the raw per-run numbers.
A second run on the same day and platform overwrites the file.
Git ignores `bench/results/`; attach the file to an issue or a pull request to share it.
