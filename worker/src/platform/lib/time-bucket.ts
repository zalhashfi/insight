// UTC hour buckets: the unit R2 telemetry history is partitioned by. Both the
// writer (ProjectDO flushing the ring buffer) and the reader (CSV export walking
// a range) must agree byte-for-byte on the name, so the format lives here alone.

import { ServiceError } from './service';

// 31 days of hourly buckets.
export const MAX_EXPORT_BUCKETS = 744;

export function hourBucket(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}`;
}

// Every hour bucket touched by [fromSec, toSec], inclusive of both endpoints.
export function hourBucketsBetween(fromSec: number, toSec: number): string[] {
  const start = Math.floor(fromSec / 3600) * 3600;
  const end = Math.floor(toSec / 3600) * 3600;
  const count = (end - start) / 3600 + 1;
  if (count > MAX_EXPORT_BUCKETS) {
    throw new ServiceError('bad_request', 'range too large', 'range_too_large');
  }

  const buckets: string[] = [];
  for (let ts = start; ts <= end; ts += 3600) buckets.push(hourBucket(ts));
  return buckets;
}
