import { github, githubPages, delay } from './release-github.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function pullRequestValidation(repository, pr, expectedHead, { pages = githubPages, sleep = delay } = {}) {
  const deadline = Date.now() + 60000;
  do {
    const runs = pages(repository, `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${expectedHead}`, 'workflow_runs')
      .filter((run) => run.head_sha === expectedHead && run.pull_requests?.some((item) => item.number === pr.number))
      .sort((a, b) => b.id - a.id);
    if (runs.length) return runs[0].id;
    await sleep(3000);
  } while (Date.now() < deadline);
  throw new Error('Requested PR CI is not visible; inspect Actions before retrying');
}

export function assertPullRequestRun(run, repository, branch, expectedHead) {
  assert(run.repository?.full_name === repository && run.path === '.github/workflows/ci.yml'
    && run.event === 'pull_request' && run.head_branch === branch && run.head_sha === expectedHead,
  'PR CI identity differs from the selected PR');
}

export async function mergeVerifiedPR(repository, pr, expectedHead, source, { api = github, pages = githubPages, sleep = delay, validation = pullRequestValidation, previousHead } = {}) {
  let runId, approvalReported = false, observedHead = false, propagationRetries = 0;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const current = api(repository, `pulls/${pr.number}`);
    assert(current.base.ref === 'develop' && (!pr.head?.ref || current.head.ref === pr.head.ref), 'Requested PR identity changed');
    if (current.head.sha !== expectedHead) {
      // After our lease-protected push, GitHub's PR API can briefly report the
      // previous head. Wait only for that known head, before ever trusting the new
      // one. Unknown changes, reversions after observation, and persistent lag fail closed.
      if (!observedHead && previousHead && current.head.sha === previousHead && !current.merged
        && current.state === 'open' && !current.draft && propagationRetries < 5) {
        propagationRetries++;
        await sleep(1000);
        continue;
      }
      throw new Error('Requested PR identity changed');
    }
    observedHead = true;
    if (current.merged) return current.merge_commit_sha;
    assert(current.state === 'open' && !current.draft, 'Requested PR was closed or held as a draft');
    const head = api(repository, 'git/ref/heads/develop').object.sha;
    if (head !== source) return null; // Reprepare the same owned branch against the newer source.
    runId ??= await validation(repository, current, expectedHead, { api, pages, sleep });
    const run = api(repository, `actions/runs/${runId}`);
    assertPullRequestRun(run, repository, current.head.ref, expectedHead);
    if (run.conclusion === 'action_required' && !approvalReported) {
      console.log(`PR CI needs maintainer approval: ${run.html_url}`);
      approvalReported = true;
    }
    assert(run.status !== 'completed' || ['success', 'action_required'].includes(run.conclusion), 'PR CI failed; inspect its run');
    if (run.status === 'completed' && run.conclusion === 'success' && current.mergeable) {
      const jobs = pages(repository, `actions/runs/${runId}/jobs?filter=latest`, 'jobs');
      const validate = jobs.filter((job) => job.name === 'validate');
      assert(validate.length === 1 && validate[0].head_sha === expectedHead && validate[0].status === 'completed'
        && validate[0].conclusion === 'success', 'PR CI has no successful validate job on the selected head');
      try {
        api(repository, `pulls/${pr.number}/merge`, { method: 'PUT', body: { sha: expectedHead, merge_method: 'squash' } });
      } catch (error) {
        const result = api(repository, `pulls/${pr.number}`);
        if (result.merged && result.head.sha === expectedHead) return result.merge_commit_sha;
        if (api(repository, 'git/ref/heads/develop').object.sha !== source) return null;
        throw error; // Never bypass protections or a review hold.
      }
      const result = api(repository, `pulls/${pr.number}`);
      assert(result.merged && result.head.sha === expectedHead, 'PR merge was not confirmed');
      return result.merge_commit_sha;
    }
    await sleep(15000);
  }
  throw new Error('PR CI or review requirements did not finish');
}
