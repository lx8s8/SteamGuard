import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const requiredBuildJobs = [
  "Frontend interactions and responsive layouts",
  "macOS Apple Silicon",
  "macOS Intel",
  "Windows x64",
  "Android release APK and AAB",
  "iOS simulator app (unsigned)",
  "iOS device IPA and archive (unsigned)",
];
const releaseJob = "Publish official GitHub Release";
export const requiredArtifacts = [
  "macOS-arm64-adhoc",
  "macOS-x64-adhoc",
  "Windows-x64",
  "Android-release-APK-and-AAB",
  "iOS-arm64-simulator-app-unsigned",
  "iOS-arm64-device-archive-unsigned",
  "iOS-arm64-device-IPA-unsigned",
];
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
function validateRequest({tag, runId, repository}) {
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Expected a stable release tag such as v1.6.0");
  if (typeof runId !== "string" || !/^[1-9]\d*$/.test(runId) || !positiveId(Number(runId))) throw new Error("Expected a positive source workflow run ID");
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
}
function exactList(response, field, names) {
  if (!response || !Array.isArray(response[field]) || response.total_count !== names.length || response[field].length !== names.length)
    throw new Error(`Expected exactly ${names.length} source ${field}; incomplete pages and extra entries are rejected`);
  const entries = new Map();
  for (const item of response[field]) {
    if (!item || !names.includes(item.name) || entries.has(item.name)) throw new Error(`Unexpected or duplicate source ${field} name`);
    entries.set(item.name, item);
  }
  return entries;
}

/** All metadata comes from this repository's REST API, never from artifacts. */
export function verifyReleaseSource({run, workflow, jobs, artifacts, tagSha}, request) {
  validateRequest(request);
  const {tag, runId, repository} = request;
  const sameRepository = value => typeof value === "string" && value.toLowerCase() === repository.toLowerCase();
  if (!run || String(run.id) !== runId || run.event !== "push" || run.path !== ".github/workflows/package.yml" || run.head_branch !== tag)
    throw new Error("Source must be the package.yml push run for this exact tag");
  if (!sameRepository(run.repository?.full_name) || !sameRepository(run.head_repository?.full_name) || !positiveId(run.repository?.id) || run.head_repository?.id !== run.repository.id)
    throw new Error("Source run must belong to this repository, not a fork");
  if (!sha(tagSha) || run.head_sha !== tagSha) throw new Error("Source SHA does not match the current tag commit");
  if (!workflow || workflow.path !== ".github/workflows/package.yml" || !positiveId(workflow.id) || workflow.id !== run.workflow_id)
    throw new Error("Source workflow identity does not match package.yml");
  if (run.status !== "completed" || !["success", "failure"].includes(run.conclusion) || !positiveId(run.run_attempt))
    throw new Error("Source workflow must be completed; only a release job failure is allowed");
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length) throw new Error("Pull-request runs cannot supply release artifacts");

  const checkedJobs = exactList(jobs, "jobs", [...requiredBuildJobs, releaseJob]);
  for (const [name, job] of checkedJobs) {
    if (String(job.run_id) !== runId || job.head_sha !== tagSha || job.status !== "completed")
      throw new Error(`Source job has a different run, SHA or incomplete status: ${name}`);
    const allowed = name === releaseJob ? ["success", "failure"] : ["success"];
    if (!allowed.includes(job.conclusion)) throw new Error(`Required source job did not succeed: ${name}`);
  }
  if (checkedJobs.get(releaseJob).conclusion !== run.conclusion)
    throw new Error("Source run conclusion does not match its release job");

  const checkedArtifacts = exactList(artifacts, "artifacts", requiredArtifacts);
  const ids = new Set();
  for (const [name, artifact] of checkedArtifacts) {
    const origin = artifact.workflow_run;
    if (!positiveId(artifact.id) || ids.has(artifact.id) || artifact.expired !== false || !positiveId(artifact.size_in_bytes) || !/^sha256:[0-9a-f]{64}$/i.test(artifact.digest ?? ""))
      throw new Error(`Source artifact is expired, incomplete or missing integrity metadata: ${name}`);
    if (String(origin?.id) !== runId || origin.head_sha !== tagSha || origin.head_branch !== tag || origin.repository_id !== run.repository.id || origin.head_repository_id !== run.repository.id)
      throw new Error(`Source artifact does not belong to the verified tag run: ${name}`);
    ids.add(artifact.id);
  }
  return {runId, sourceSha:tagSha, artifactIds:requiredArtifacts.map(name => checkedArtifacts.get(name).id).join(",")};
}

async function tagCommit(get, base, tag) {
  const ref = await get(`${base}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.ref !== `refs/tags/${tag}`) throw new Error("GitHub returned a different tag reference");
  let object = ref.object;
  for (let depth = 0; depth < 8; depth++) {
    if (!sha(object?.sha)) throw new Error("Invalid tag object SHA");
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag") throw new Error("Release tag does not point to a commit");
    object = (await get(`${base}/git/tags/${object.sha}`)).object;
  }
  throw new Error("Release tag nesting exceeds the limit");
}

export async function readVerifiedReleaseSource(request, get) {
  validateRequest(request);
  const base = `/repos/${request.repository}`;
  const runPath = `${base}/actions/runs/${request.runId}`;
  const [run, workflow, tagSha, jobs, artifacts] = await Promise.all([
    get(runPath),
    get(`${base}/actions/workflows/package.yml`),
    tagCommit(get, base, request.tag),
    get(`${runPath}/jobs?filter=latest&per_page=100`),
    get(`${runPath}/artifacts?per_page=100`),
  ]);
  const verified = verifyReleaseSource({run, workflow, tagSha, jobs, artifacts}, request);
  // Refuse a rerun started while the metadata pages were being checked.
  const latest = await get(runPath);
  if (["id", "run_attempt", "head_sha", "status", "conclusion"].some(field => latest[field] !== run[field]))
    throw new Error("Source workflow changed during verification; try again after it completes");
  return verified;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("Usage: node scripts/verify-release-source.mjs <tag> <run_id>");
  const request = {tag:args[0], runId:args[1], repository:process.env.GITHUB_REPOSITORY};
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  if (!/^https:\/\/[^/]+(?:\/api\/v3)?$/.test(base)) throw new Error("Invalid GitHub API URL");
  const get = async route => {
    const response = await fetch(`${base}${route}`, {headers:{
      Accept:"application/vnd.github+json", "User-Agent":"SteamGuard-release-source-verifier",
      ...(process.env.GH_TOKEN ? {Authorization:`Bearer ${process.env.GH_TOKEN}`} : {}),
    }});
    if (!response.ok) throw new Error(`GitHub REST verification failed (${response.status}): ${route}`);
    return response.json();
  };
  const result = await readVerifiedReleaseSource(request, get);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${result.runId}\nsource_sha=${result.sourceSha}\nartifact_ids=${result.artifactIds}\n`);
  console.log(`Verified package tag ${request.tag}, source ${result.sourceSha}, 7 successful build/test jobs and 7 immutable artifacts.`);
}
