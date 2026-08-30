/**
 * Publish experiment records to the FireRaid lab server.
 * FR-R4-086: reads records via Recorder.loadExperiment, validates each with
 *            RunRecordV1Schema.safeParse, POSTs to the server ingest endpoint.
 *
 * Usage: tsx harness/core/publish-runs.ts <experiment_id> <base_url>
 * Requires: process.env.FIRERAID_LAB_API_SECRET
 */
import { Recorder } from "./index.js";
import { RunRecordV1Schema } from "./run-schema.js";

function main(): void {
  const [experimentId, baseUrl] = process.argv.slice(2);
  if (!experimentId || !baseUrl) {
    console.error("Usage: tsx harness/core/publish-runs.ts <experiment_id> <base_url>");
    process.exit(1);
  }

  const secret = process.env.FIRERAID_LAB_API_SECRET;
  if (!secret) {
    console.error("FIRERAID_LAB_API_SECRET is not set");
    process.exit(1);
  }

  // Load records for the experiment
  const records = Recorder.loadExperiment(experimentId);

  if (records.length === 0) {
    console.error(`No records found for experiment: ${experimentId}`);
    process.exit(1);
  }

  // Validate each record
  const validRuns: unknown[] = [];
  const invalid: string[] = [];

  for (const record of records) {
    const result = RunRecordV1Schema.safeParse(record);
    if (result.success) {
      validRuns.push(result.data);
    } else {
      invalid.push(
        `${record.run_id}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
      );
    }
  }

  if (validRuns.length === 0) {
    console.error("No valid records to publish");
    for (const inv of invalid) console.error(`  INVALID: ${inv}`);
    process.exit(1);
  }

  if (invalid.length > 0) {
    console.warn(`${invalid.length} record(s) failed validation and were skipped:`);
    for (const inv of invalid) console.warn(`  ${inv}`);
  }

  console.log(`Publishing ${validRuns.length} valid record(s) to ${baseUrl}/api/lab/runs/ingest`);

  // POST to ingest endpoint
  (async () => {
    try {
      const resp = await fetch(`${baseUrl}/api/lab/runs/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ runs: validRuns }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        console.error(`Server returned ${resp.status}: ${body}`);
        process.exit(1);
      }

      const responseText = await resp.text();
      console.log(`Server response (${resp.status}):`);
      console.log(responseText);
    } catch (err) {
      console.error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  })();
}

main();
