import assert from "node:assert/strict";
import test from "node:test";

import { PnmStreamParser } from "../lib/server/pnm-parser";

test("parses P5 stream and emits rows", () => {
  const rows: Buffer[] = [];
  const parser = new PnmStreamParser({
    onHeader: (header) => {
      assert.equal(header.magic, "P5");
      assert.equal(header.width, 2);
      assert.equal(header.height, 2);
      assert.equal(header.channels, 1);
    },
    onRows: (data) => rows.push(Buffer.from(data))
  });

  const header = Buffer.from("P5\n2 2\n255\n", "ascii");
  const body = Buffer.from([0, 120, 200, 255]);

  parser.push(Buffer.concat([header, body.subarray(0, 2)]));
  parser.push(body.subarray(2));
  parser.finish();

  const merged = Buffer.concat(rows);
  assert.deepEqual([...merged], [0, 120, 200, 255]);
});

test("parses P6 stream and emits rows", () => {
  const rows: Buffer[] = [];
  const parser = new PnmStreamParser({
    onHeader: (header) => {
      assert.equal(header.magic, "P6");
      assert.equal(header.width, 1);
      assert.equal(header.height, 2);
      assert.equal(header.channels, 3);
    },
    onRows: (data) => rows.push(Buffer.from(data))
  });

  const payload = Buffer.from("P6\n1 2\n255\n", "ascii");
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0]);

  parser.push(Buffer.concat([payload, rgb]));
  parser.finish();

  assert.deepEqual([...Buffer.concat(rows)], [255, 0, 0, 0, 255, 0]);
});
