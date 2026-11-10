/**
 * Differential parity gate (FR-043, AS-009): `parseWorkbook` must return exactly
 * what the pre-change SheetJS implementation (`oracleParse`) returns — same rows,
 * same order, same keys in the same order, same value types, same `Date` epoch
 * milliseconds, same prototype-free rows, and the same error outcome.
 *
 * Every fixture runs in this process (whatever `TZ` it was started with) and the
 * whole file is then re-run in child processes with `TZ` pinned BEFORE any module
 * loads — once under UTC and once under Europe/Copenhagen. SheetJS caches its date
 * base at module load, so flipping `process.env.TZ` mid-process would not prove
 * parity; a pinned child process does.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  differential,
  PARITY_TIME_ZONES,
  runSuiteUnderTimeZone,
  timeZoneOfChild,
} from "./support/sheetjs-oracle.js";
import {
  fixtureCases,
  randomWorkbook,
  SOURCE_SHAPES,
  syntheticBrancheliste,
  syntheticSources,
  type FixtureCase,
  type FixtureRead,
} from "./support/fixtures.js";

const childZone = timeZoneOfChild(process.env);

const assertParity = async (c: FixtureCase, read: FixtureRead): Promise<void> => {
  const { expected, divergence } = await differential(c.bytes, read.schema, read.opts);
  // A fixture bug that made both sides trivially equal (e.g. both empty) must not
  // pass silently: the oracle outcome has to be what the fixture intends.
  if (read.expectation.kind === "rows") {
    expect(expected.kind).toBe("rows");
    if (expected.kind === "rows") expect(expected.rows.length).toBeGreaterThanOrEqual(read.expectation.min);
  } else {
    expect(expected.kind).toBe("error");
    if (expected.kind === "error") expect(expected.error.kind).toBe(read.expectation.errorKind);
  }
  expect(divergence).toBeNull();
};

const cases = await fixtureCases();

describe("AS-009: parseWorkbook ≡ SheetJS oracle on every fixture", () => {
  for (const c of cases) {
    for (const read of c.reads) {
      it(`AS-009: ${c.name} [${read.label}] matches the oracle`, () => assertParity(c, read), 60_000);
    }
  }
});

describe("AS-009: random synthetic workbooks (cell-type mix, sparse addressing)", () => {
  const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i * 7919);
  for (const seed of SEEDS) {
    it(`AS-009: random workbook seed ${seed} matches the oracle on every read`, async () => {
      const c = await randomWorkbook(seed);
      for (const read of c.reads) {
        const { divergence } = await differential(c.bytes, read.schema, read.opts);
        expect({ read: read.label, divergence }).toEqual({ read: read.label, divergence: null });
      }
    });
  }
});

/**
 * Digest of an archive's file entries (name + uncompressed bytes, in archive order).
 * Zip bytes are not compared because JSZip stamps implicit folder entries with
 * wall-clock time, and `docProps/` is skipped because ExcelJS writes wall-clock
 * created/modified stamps there; the workbook content is what the parity gate
 * reads.
 */
const contentDigest = async (bytes: Uint8Array): Promise<string> => {
  const hash = createHash("sha256");
  const zip = await JSZip.loadAsync(bytes).catch(() => null);
  if (zip === null) return hash.update(bytes).digest("hex");
  for (const entry of Object.values(zip.files).filter((e) => !e.dir && !e.name.startsWith("docProps/"))) {
    hash.update(entry.name).update("\0").update(await entry.async("uint8array")).update("\0");
  }
  return hash.digest("hex");
};

/**
 * Golden content digests, recorded from the generators before any refactor of
 * fixtures.ts. A generator refactor must leave every fixture's content (and so its
 * seeded-RNG call order) unchanged, or the parity evidence above silently shifts.
 */
const GOLDEN_FIXTURE_DIGESTS: Readonly<Record<string, string>> = {
  "ExcelJS writer output": "f15f6f1d1f1379db142a40d18b083b6ec53224dfa633cdb55578a7a55869c750",
  "edge-case matrix (date1904)": "10eb65aa58b2c9eabec3c0aa0ad83650a2db2915fdaeccfc970f09fb37f6e38a",
  "edge-case matrix": "3a7cb1b033b9c9c7b7ff540fa87bdc350a5487825b95c12c9fbb21ad425f4f65",
  "existing: absent worksheet": "edece759bbfe9fcd44dff8ef7bd72becd158b026e6829405e31e30f04fca3dcd",
  "existing: custom header row": "9eb904ec87f92499533b9c86d3f044e46674babcb96483e28f9618faac5a5ed7",
  "existing: dateGroupItem table autofilter": "69092f72123a431cb576bbf731ec9d40a984bdcf9b97c6253c0938a285f84697",
  "existing: duplicate header": "b0da333c7bd7deb7d6832d01edeed3e047847993a0bba9e7104daa874495b182",
  "existing: end-to-end disk workbook": "880c462659b13d2afa2b2ef3774dbb48c63a69a139233b03978dbbc09296ad4a",
  "existing: error cell mixed with values": "a63b5af97d99735fa8c7facd3a5fd8e27d19c2b599480dd623124d798f2f305f",
  "existing: fully-blank row skipped": "f823e8f4a8a29008b43d3d2e27bcf0c351a8c62b9c6a8c22315799360ffad6a5",
  "existing: happy path": "32b4c770ae4f8e51e342f85f3b9754dabab327e8d6324ed07fc91a33bdfa015e",
  "existing: hostile __proto__/constructor headers": "4c8adad30e393d00c6b8ed6b21cf36dacd179d3602f3c6b8da55cd2353a0ce32",
  "existing: malformed table XML": "c4937a1928a01f18de3ddbea0436620b8d7c3c047c150ef2afd7e4a4102294cc",
  "existing: multiple blank headers": "cfe08783d0347f6118a24eee088b4ee97993d73636f9d59de1829d992187c7ea",
  "existing: non-workbook bytes": "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  "existing: schema violation": "aa7f194ae1d67c79fa0b5370cf8ba60579b8f09b71600dd2f3b33faa7cba8d77",
  "existing: sheet by name": "d0f13f823a965d53c144935a3ef4af818ba3df37ee2f90f4bc4a3bd0ee1ac37c",
  "existing: sheet by numeric index": "0457cbc6cfdb2ac139e7b03f09f189b66f558f12bd95f0843302560730760afd",
  "source: danskErhverv": "2b83dba743c6fc6fdbfe79c3411182cf9c3d2269acf62bf354619f0e89cc2490",
  "source: fck": "ecf85019f6cbbb6089e2070b3202d691e57cb58409aae5df40ee6c284dcd3028",
  "source: gamleKunder": "ac79d22d20f1b0b6814cf47a839fb060f7fe2099eacb25db1a2f926b39f4dca1",
  "source: globalConnect": "596cadc7170cda516aa458561fc7ed504f163cdaf2ac47dfd1642c5718188cc7",
  "source: itBranchen": "1c75fbaf8b1b98635f6d8ff1e56eb15cf5309742ed40fe111859b176121a3f68",
  "source: leverandoer": "cc669aa9d479bd1469ed08d0fef5230e28477bc8d2106b655fe789b427997c1f",
  "source: scoringsmodel": "8eaf178836e4b6397b72390533c27101969fc116a45cb796156ab93a7a787a00",
  "source: tabte": "41b178041bda55902e374f24c7f1c7bc740104c1817905763f1a43611e08ca07",
  "source: tivoli": "b93f11940ce4e3b90272dd73e854a2786e9c2e04395a1291be046d8dd47a3757",
  "synthetic Brancheliste (25600 rows)": "ef74d6944b91403cd83c8053430bc720f99145b0eb54e98ee300b5c9b72b1489",
};

const GOLDEN_RANDOM_DIGESTS: Readonly<Record<string, string>> = {
  "random-1000": "7c7171b21d35c894cfd9eb3c9ed3623ae9fd1a747670907900a1a2c0c9534e18",
  "random-8919": "d4f52c475b26285f717fa663eaf60041169189981a87c79a2304b20d9dd63a90",
  "random-16838": "49ba34b315a70308202b1989b54f7faabe95877481b6815167fe3450f801a766",
  "random-24757": "6f94ed2ec50989129abf1d74143664fadd950715405d141808df10e26d4d7ef3",
};

describe("fixture generators are stable against golden content", () => {
  it("every parity fixture's content matches its recorded golden digest", async () => {
    const actual = Object.fromEntries(await Promise.all(cases.map(async (c) => [c.name, await contentDigest(c.bytes)] as const)));
    expect(actual).toEqual(GOLDEN_FIXTURE_DIGESTS);
  });

  it("random workbooks' content matches their recorded golden digests", async () => {
    const actual = Object.fromEntries(
      await Promise.all(
        Object.keys(GOLDEN_RANDOM_DIGESTS).map(async (name) => {
          const c = await randomWorkbook(Number(name.slice("random-".length)));
          return [c.name, await contentDigest(c.bytes)] as const;
        }),
      ),
    );
    expect(actual).toEqual(GOLDEN_RANDOM_DIGESTS);
  });
});

describe("fixture generators are deterministic", () => {
  it("syntheticBrancheliste yields identical bytes for the same seed and different bytes for another", async () => {
    const [a, b, c] = await Promise.all([
      syntheticBrancheliste(300, 42),
      syntheticBrancheliste(300, 42),
      syntheticBrancheliste(300, 43),
    ]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("syntheticSources yields identical bytes per shape for the same seed, for all nine shapes", async () => {
    const [a, b] = await Promise.all([syntheticSources(5), syntheticSources(5)]);
    expect(Object.keys(a).sort()).toEqual([...SOURCE_SHAPES].sort());
    expect(SOURCE_SHAPES).toHaveLength(9);
    for (const shape of SOURCE_SHAPES) {
      expect(Buffer.from(a[shape]).equals(Buffer.from(b[shape]))).toBe(true);
    }
  });
});

if (childZone.kind === "child") {
  describe("time-zone pin (child run)", () => {
    it(`runs with TZ pinned to ${childZone.zone.tz}`, () => {
      expect(process.env.TZ).toBe(childZone.zone.tz);
      // July: UTC has offset 0, Copenhagen is CEST (UTC+2 → getTimezoneOffset -120).
      expect(new Date(Date.UTC(2024, 6, 1)).getTimezoneOffset()).toBe(childZone.zone.julyOffsetMinutes);
    });
  });
} else {
  describe("AS-009: parity holds with TZ pinned per process", () => {
    for (const zone of PARITY_TIME_ZONES) {
      it(
        `AS-009: the whole parity suite passes under TZ=${zone.tz}`,
        async () => {
          const run = await runSuiteUnderTimeZone(import.meta.path, zone);
          if (run.kind !== "passed") throw new Error(`parity suite under TZ=${zone.tz} ${run.kind}:\n${run.output}`);
          expect(run.passed).toBeGreaterThan(cases.length);
        },
        600_000,
      );
    }
  });
}
