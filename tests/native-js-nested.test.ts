// The native-JS binding decodes nested and interval values through the official
// JS converter, with its own text mapping applied inside them too.
import { expect, test } from "bun:test";
import { open, row } from "./helper.ts";

test("nested values decode to arrays and objects, with dates inside as text", async () => {
  const ctx = await open();
  try {
    expect(
      await row(
        ctx.conn,
        "SELECT [1, 2] AS l, {'d': DATE '2024-01-02', 'n': 1.5::DECIMAL(4,1)} AS s, MAP {'k': 'v'} AS m, INTERVAL 3 DAY AS i, TIME '01:02:03' AS t",
      ),
    ).toEqual({
      l: [1, 2],
      s: { d: "2024-01-02", n: 1.5 },
      m: [{ key: "k", value: "v" }],
      i: { months: 0, days: 3, micros: 0n },
      t: "01:02:03",
    });
  } finally {
    ctx.dispose();
  }
});
