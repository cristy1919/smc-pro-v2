export type CloudflareBillableUsageSample = {
  date: string | null;
  workersRequests: number;
  workersDurationGbSeconds: number;
  workersKVReads: number;
  workersKVWrites: number;
  durableObjectSqlRowsRead: number;
  durableObjectSqlRowsWritten: number;
};

export type CloudflareBillableUsageSummary = {
  workersRequests: number | null;
  workersDurationGbSeconds: number | null;
  workersKVReads: number | null;
  workersKVWrites: number | null;
  durableObjectSqlRowsRead: number | null;
  durableObjectSqlRowsWritten: number | null;
  matchedMetrics: {
    workersRequests: string[];
    workersDurationGbSeconds: string[];
    workersKVReads: string[];
    workersKVWrites: string[];
    durableObjectSqlRowsRead: string[];
    durableObjectSqlRowsWritten: string[];
  };
  availableMetrics: string[];
  samples: CloudflareBillableUsageSample[];
};

type BillableUsageRow = Record<string, unknown>;
type MetricKey = Exclude<keyof CloudflareBillableUsageSample, "date">;

function rowString(row: BillableUsageRow, key: string): string {
  return String(row[key] ?? "").toLowerCase();
}

function rowQuantity(row: BillableUsageRow): number {
  const value = Number(row.ConsumedQuantity);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function summarizeCloudflareBillableUsage(rows: unknown[]): CloudflareBillableUsageSummary {
  const groups: Record<MetricKey, BillableUsageRow[]> = {
    workersRequests: [],
    workersDurationGbSeconds: [],
    workersKVReads: [],
    workersKVWrites: [],
    durableObjectSqlRowsRead: [],
    durableObjectSqlRowsWritten: []
  };
  const availableMetrics = new Set<string>();
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as BillableUsageRow;
    const id = rowString(row, "x_BillableMetricId");
    const name = rowString(row, "x_BillableMetricName");
    const description = rowString(row, "ChargeDescription");
    const familyId = rowString(row, "x_ProductFamilyId");
    const familyName = rowString(row,  --- TRUNCATED --- 5,680 chars