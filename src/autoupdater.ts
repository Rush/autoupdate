import * as github from '@actions/github';
import * as ghCore from '@actions/core';
import Octokit from '@octokit/rest';
import { ConfigLoader } from './config-loader';

const sleep = (timeMs: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, timeMs);
  });
};

export class AutoUpdater {
  eventData: any;
  config: ConfigLoader;
  octokit: github.GitHub;

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  constructor(config: ConfigLoader, eventData: any) {
    this.eventData = eventData;
    this.config = config;
    this.octokit = new github.GitHub(this.config.githubToken());
  }

  async handlePush(): Promise<number> {
    const { ref, repository } = this.eventData;

    ghCore.info(`Handling push event on ref '${ref}'`);

    if (!ref.startsWith('refs/heads/')) {
      ghCore.warning('Push event was not on a branch, skipping.');
      return 0;
    }

    const baseBranch = ref.replace('refs/heads/', '');

    let updated = 0;
    const paginatorOpts = this.octokit.pulls.list.endpoint.merge({
      owner: repository.owner.name,
      repo: repository.name,
      base: baseBranch,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
    });
    for await (const pullsPage of this.octokit.paginate.iterator(
      paginatorOpts,
    )) {
      for (const pull of pullsPage.data) {
        ghCore.startGroup(`PR-${pull.number}`);
        const isUpdated = await this.update(pull);
        if (isUpdated && this.config.waitAfterUpdate()) {
          sleep(this.config.waitAfterUpdate() * 1000);
          ghCore.info(`Waiting for ${this.config.waitAfterUpdate} seconds before next update`);
        }
        ghCore.endGroup();

        if (isUpdated) {
          updated++;
        }
      }
    }

    ghCore.info(
      `Auto update complete, ${updated} pull request(s) that point to base branch '${baseBranch}' were updated.`,
    );

    return updated;
  }

  async handlePullRequest(): Promise<boolean> {
    const { action } = this.eventData;

    ghCore.info(`Handling pull_request event triggered by action '${action}'`);

    const isUpdated = await this.update(this.eventData.pull_request);
    if (isUpdated) {
      ghCore.info(
        'Auto update complete, pull request branch was updated with changes from the base branch.',
      );
    } else {
      ghCore.info('Auto update complete, no changes were made.');
    }

    return isUpdated;
  }

  async update(pull: Octokit.PullsListResponseItem): Promise<boolean> {
    const { ref } = pull.head;
    ghCore.info(`Evaluating pull request #${pull.number}...`);

    const prNeedsUpdate = await this.prNeedsUpdate(pull);
    if (!prNeedsUpdate) {
      return false;
    }

    const baseRef = pull.base.ref;
    const headRef = pull.head.ref;
    ghCore.info(
      `Updating branch '${ref}' on pull request #${pull.number} with changes from ref '${baseRef}'.`,
    );

    if (this.config.dryRun()) {
      ghCore.warning(
        `Would have merged ref '${headRef}' into ref '${baseRef}' but DRY_RUN was enabled.`,
      );
      return true;
    }

    const mergeMsg = this.config.mergeMsg();
    const mergeOpts: Octokit.RequestOptions & Octokit.ReposMergeParams = {
      owner: pull.head.repo.owner.login,
      repo: pull.head.repo.name,
      // We want to merge the base branch into this one.
      base: headRef,
      head: baseRef,
    };

    if (mergeMsg !== null && mergeMsg.length > 0) {
      mergeOpts.commit_message = mergeMsg;
    }

    await this.merge(mergeOpts);

    return true;
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  async prNeedsUpdate(pull: any): Promise<boolean> {
    if (pull.merged === true) {
      ghCore.warning('Skipping pull request, already merged.');
      return false;
    }
    if (pull.state !== 'open') {
      ghCore.warning(
        `Skipping pull request, no longer open (current state: ${pull.state}).`,
      );
      return false;
    }

    const { data: comparison } = await this.octokit.repos.compareCommits({
      owner: pull.head.repo.owner.login,
      repo: pull.head.repo.name,
      // This base->head, head->base logic is intentional, we want
      // to see what would happen if we merged the base into head not
      // vice-versa.
      base: pull.head.label,
      head: pull.base.label,
    });

    if (comparison.behind_by === 0) {
      ghCore.info('Skipping pull request, up-to-date with base branch.');
      return false;
    }

    const prFilter = this.config.pullRequestFilter();

    ghCore.info(
      `PR_FILTER=${prFilter}, checking if this PR's branch needs to be updated.`,
    );

    if (prFilter === 'labelled') {
      const labels = this.config.pullRequestLabels();
      if (labels.length === 0) {
        ghCore.warning(
          'Skipping pull request, no labels were defined (env var PR_LABELS is empty or not defined).',
        );
        return false;
      }
      ghCore.info(
        `Checking if this PR has a label in our list (${labels.join(', ')}).`,
      );

      if (pull.labels.length === 0) {
        ghCore.info('Skipping pull request, it has no labels.');
        return false;
      }

      for (const label of pull.labels) {
        if (labels.includes(label.name)) {
          ghCore.info(
            `Pull request has label '${label.name}' and PR branch is behind base branch.`,
          );
          return true;
        }
      }

      ghCore.info(
        'Pull request does not match any of the defined labels, skipping update.',
      );
      return false;
    }

    if (this.config.pullRequestFilter() === 'protected') {
      ghCore.info('Checking if this PR is against a protected branch.');
      const { data: branch } = await this.octokit.repos.getBranch({
        owner: pull.head.repo.owner.login,
        repo: pull.head.repo.name,
        branch: pull.base.ref,
      });

      if (branch.protected) {
        ghCore.info(
          'Pull request is against a protected branch and is behind base branch.',
        );
        return true;
      }

      ghCore.info(
        'Pull request is not against a protected branch, skipping update.',
      );
      return false;
    }

    ghCore.info('All checks pass and PR branch is behind base branch.');
    return true;
  }

  async merge(
    mergeOpts: Octokit.RequestOptions & Octokit.ReposMergeParams,
  ): Promise<boolean> {
    const doMerge = async () => {
      const mergeResp = await this.octokit.repos.merge(mergeOpts);

      // See https://developer.github.com/v3/repos/merging/#perform-a-merge
      const { status } = mergeResp;
      if (status === 200) {
        ghCore.info(
          `Branch update succesful, new branch HEAD: ${mergeResp.data.sha}.`,
        );
        return true;
      } else if (status === 204) {
        ghCore.info(
          'Branch update not required, branch is already up-to-date.',
        );
        return false;
      }
    };

    const retryCount = this.config.retryCount();
    const retrySleep = this.config.retrySleep();
    const mergeConflictAction = this.config.mergeConflictAction();

    let retries = 0;

    while (true) {
      try {
        ghCore.info('Attempting branch update...');
        doMerge();
        break;
      } catch (e) {
        if (
          e.message === 'Merge conflict' &&
          mergeConflictAction === 'ignore'
        ) {
          ghCore.info('Merge conflict detected, skipping update.');
          break;
        }
        if (e.message === 'Merge conflict') {
          ghCore.error('Merge conflict error trying to update branch');
          throw e;
        }

        ghCore.error(`Caught error trying to update branch: ${e.message}`);

        if (retries < retryCount) {
          ghCore.info(
            `Branch update failed, will retry in ${retrySleep}ms, retry #${retries} of ${retryCount}.`,
          );

          retries++;
          await sleep(retrySleep);
        } else {
          throw e;
        }
      }
    }
    return true;
  }
}
