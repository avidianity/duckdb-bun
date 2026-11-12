import duckdb from '../../src/bindings/index.ts';
import { expect, suite, test } from '../vitest-shim.ts';
import { withDatabase } from './utils/withDatabase';

suite('errors', () => {
  test('wrong external type', async () => {
    await withDatabase({}, async (db) => {
      expect(() =>
        duckdb.query(db as unknown as duckdb.Connection, 'select 1'),
      ).toThrowError(/^Invalid connection argument$/);
    });
  });
});
