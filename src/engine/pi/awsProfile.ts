import { loadSharedConfigFiles } from "@smithy/core/config";

// The AWS SDK reads ~/.aws/credentials and config once per process and reuses the result for every
// client built afterwards, so refreshed credentials are ignored until this overwrites that cache.
export async function refreshAwsProfileFiles(): Promise<void> {
  await loadSharedConfigFiles({ ignoreCache: true });
}
