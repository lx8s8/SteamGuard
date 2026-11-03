import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readVerifiedReleaseSource, verifyReleaseSource, requiredArtifacts, requiredBuildJobs } from "../scripts/verify-release-source.mjs";

const request = {tag:"v1.6.0", runId:"41555794631", repository:"lx8s8/SteamGuard"};
const sourceSha = "a".repeat(40);
function fixture() {
  const run = {id:Number(request.runId), event:"push", path:".github/workflows/package.yml", head_branch:request.tag, head_sha:sourceSha, repository:{id:42,full_name:request.repository}, head_repository:{id:42,full_name:request.repository}, workflow_id:12, status:"completed", conclusion:"failure",run_attempt:1,pull_requests:[]};
  const jobs = [...requiredBuildJobs,"Publish official GitHub Release"].map((name,index) => ({id:index+1,name,run_id:run.id,head_sha:sourceSha,status:"completed",conclusion:index===7?"failure":"success"}));
  const artifacts = requiredArtifacts.map((name,index) => ({id:100+index,name,expired:false,size_in_bytes:1234,digest:`sha256:${"b".repeat(64)}`,workflow_run:{id:run.id,head_sha:sourceSha,head_branch:request.tag,repository_id:42,head_repository_id:42}}));
  return {run,workflow:{id:12,path:run.path},tagSha:sourceSha,jobs:{total_count:8,jobs},artifacts:{total_count:7,artifacts}};
}

test("all seven original build/test successes allow retrying only failed publication", () => {
  const data=fixture();
  assert.deepEqual(verifyReleaseSource(data,request),{runId:request.runId,sourceSha,artifactIds:"100,101,102,103,104,105,106"});
  data.run.conclusion="success";data.jobs.jobs[7].conclusion="success";
  assert.equal(verifyReleaseSource(data,request).sourceSha,sourceSha);
});

test("PR, dispatch, another tag/workflow/SHA/repository and unfinished runs are rejected", () => {
  const mutations=[
    d=>d.run.event="pull_request",d=>d.run.event="workflow_dispatch",d=>d.run.path=".github/workflows/other.yml",d=>d.run.head_branch="main",d=>d.run.head_sha="c".repeat(40),d=>d.tagSha="c".repeat(40),
    d=>d.run.repository.full_name="other/repo",d=>d.run.head_repository.id=43,d=>d.workflow.id=13,d=>d.workflow.path=".github/workflows/other.yml",d=>d.run.status="in_progress",d=>d.run.pull_requests=[{}],d=>d.run.conclusion="cancelled",
  ];
  for(const mutate of mutations){const data=fixture();mutate(data);assert.throws(()=>verifyReleaseSource(data,request));}
});

test("a failed or skipped test/build job, foreign SHA or duplicate job blocks release", () => {
  for(let i=0;i<7;i++)for(const conclusion of ["failure","skipped","cancelled"]){const data=fixture();data.jobs.jobs[i].conclusion=conclusion;assert.throws(()=>verifyReleaseSource(data,request),/did not succeed/);}
  for(const mutate of [d=>d.jobs.jobs[0].head_sha="c".repeat(40),d=>d.jobs.jobs[0].run_id++,d=>d.jobs.jobs[0].status="queued",d=>d.jobs.jobs[1].name=d.jobs.jobs[0].name,d=>d.jobs.total_count=9,d=>d.jobs.jobs.pop(),d=>d.jobs.jobs[7].conclusion="skipped"]){const data=fixture();mutate(data);assert.throws(()=>verifyReleaseSource(data,request));}
});

test("artifact names, immutable IDs, provenance, availability and digests are required", () => {
  const mutations=[d=>d.artifacts.artifacts[0].expired=true,d=>d.artifacts.artifacts[0].digest=null,d=>d.artifacts.artifacts[0].name="foreign",d=>d.artifacts.artifacts[1].id=d.artifacts.artifacts[0].id,d=>d.artifacts.artifacts[0].workflow_run.head_sha="c".repeat(40),d=>d.artifacts.artifacts[0].workflow_run.id++,d=>d.artifacts.artifacts[0].workflow_run.head_branch="main",d=>d.artifacts.artifacts[0].workflow_run.head_repository_id++,d=>d.artifacts.artifacts.pop(),d=>d.artifacts.total_count=8];
  for(const mutate of mutations){const data=fixture();mutate(data);assert.throws(()=>verifyReleaseSource(data,request));}
});

test("unsafe workflow inputs fail before any API request", async () => {
  for(const invalid of [{...request,tag:"v1.6.0; echo bad"},{...request,tag:"v1.6.0-rc.1"},{...request,runId:"001"},{...request,runId:"1/../../"},{...request,repository:"owner/repo/other"}])
    await assert.rejects(readVerifiedReleaseSource(invalid,()=>assert.fail("invalid input reached API")));
});

function apiFixture(data,{rerun=false,annotated=false}={}) {
  const prefix=`/repos/${request.repository}`, run=`${prefix}/actions/runs/${request.runId}`;
  let reads=0;
  return async route=>{
    if(route===run){reads++;return rerun&&reads>1?{...data.run,run_attempt:2}:data.run;}
    if(route===`${prefix}/actions/workflows/package.yml`)return data.workflow;
    if(route===`${prefix}/git/ref/tags/${request.tag}`)return {ref:`refs/tags/${request.tag}`,object:{type:annotated?"tag":"commit",sha:annotated?"f".repeat(40):sourceSha}};
    if(route===`${prefix}/git/tags/${"f".repeat(40)}`)return {object:{type:"commit",sha:sourceSha}};
    if(route===`${run}/jobs?filter=latest&per_page=100`)return data.jobs;
    if(route===`${run}/artifacts?per_page=100`)return data.artifacts;
    assert.fail(`Unexpected API request: ${route}`);
  };
}
test("REST gate peels annotated tags and rechecks completed source after listing jobs", async () => {
  assert.equal((await readVerifiedReleaseSource(request,apiFixture(fixture(),{annotated:true}))).sourceSha,sourceSha);
  await assert.rejects(readVerifiedReleaseSource(request,apiFixture(fixture(),{rerun:true})),/changed during verification/);
});

test("resume workflow downloads exact original artifacts and never rebuilds native targets", () => {
  const workflow=readFileSync('.github/workflows/release-resume.yml','utf8');
  assert.match(workflow,/ref: \$\{\{ steps\.source\.outputs\.source_sha \}\}/);
  assert.match(workflow,/artifact-ids: \$\{\{ steps\.source\.outputs\.artifact_ids \}\}/);
  assert.match(workflow,/digest-mismatch: error/);
  assert.match(workflow,/GITHUB_REF_NAME="\$TAG" node scripts\/collect-release\.mjs/);
  assert.match(workflow,/--json apiUrl,isDraft/);
  assert.ok(workflow.indexOf('node scripts/verify-release-assets.mjs')<workflow.indexOf('--draft=false'));
  assert.doesNotMatch(workflow,/tauri build|mobile\.mjs|cargo build|npm ci/);
});
