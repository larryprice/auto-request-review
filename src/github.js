'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const partition = require('lodash/partition');
const yaml = require('yaml');

class PullRequest {
  // ref: https://developer.github.com/v3/pulls/#get-a-pull-request
  constructor(pull_request_paylaod) {
    // "ncc" doesn't yet support private class fields as of 29 Aug. 2020
    // ref: https://github.com/vercel/ncc/issues/499
    this._pull_request_paylaod = pull_request_paylaod;
  }

  get author() {
    return this._pull_request_paylaod.user.login;
  }

  get title() {
    return this._pull_request_paylaod.title;
  }

  get is_draft() {
    return this._pull_request_paylaod.draft;
  }
}

function get_pull_request() {
  const context = get_context();

  return new PullRequest(context.payload.pull_request);
}

async function fetch_config() {
  const context = get_context();
  const octokit = get_octokit();
  const config_path = get_config_path();

  const { data: response_body } = await octokit.rest.repos.getContent({
    owner: context.repo.owner,
    repo: context.repo.repo,
    path: config_path,
    ref: context.ref,
  });

  const content = Buffer.from(
    response_body.content,
    response_body.encoding
  ).toString();
  return yaml.parse(content);
}

async function fetch_changed_files() {
  const context = get_context();
  const octokit = get_octokit();

  const changed_files = [];

  const per_page = 100;
  let page = 0;
  let number_of_files_in_current_page;

  do {
    page += 1;

    const { data: response_body } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      page,
      per_page,
    });

    number_of_files_in_current_page = response_body.length;
    changed_files.push(...response_body.map((file) => file.filename));
  } while (number_of_files_in_current_page === per_page);

  return changed_files;
}

async function assign_reviewers(reviewers) {
  const context = get_context();
  const octokit = get_octokit();

  const [ teams_with_prefix, individuals ] = partition(reviewers, (reviewer) =>
    reviewer.startsWith('team:')
  );
  const teams = teams_with_prefix.map((team_with_prefix) =>
    team_with_prefix.replace('team:', '')
  );

  return octokit.rest.pulls.requestReviewers({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    reviewers: individuals,
    team_reviewers: teams,
  });
}

async function get_all_comments() {
  const context = get_context();
  const octokit = get_octokit();

  return octokit.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.pull_request.number,
  });
}

function tagged_users(users) {
  const [ teams_with_prefix, individuals ] = partition(users, (user) =>
    user.startsWith('team:')
  );
  const teams = teams_with_prefix.map((team_with_prefix) =>
    team_with_prefix.replace('team:', '')
  );

  return individuals
    .map((individual) => `@${individual}`)
    .concat(teams.map((team) => `@${team}`));
}

async function ping_all_reviewers(codeowners, reviewers) {
  if (codeowners.length === 0 && reviewers.length === 0) {
    core.info('No reviewers or codeowners to ping');
    return;
  }

  const context = get_context();
  const octokit = get_octokit();

  const tagged_reviewers = tagged_users(reviewers);
  const tagged_codeowners = tagged_users(codeowners);

  let body
    = 'Attention: Files that you are the codeowner for have been modified in this PR.\n\nReviewers are required to approve this review. Additional codeowner reviews are optional.';

  if (tagged_reviewers.length > 0) {
    body += `\n\nReviewers: ${tagged_reviewers}`;
  }
  if (tagged_codeowners.length > 0) {
    body += `\n\nAdditional Codeowners: ${tagged_codeowners}`;
  }

  const { data } = await get_all_comments();

  // Avoid sending the same comment multiple times
  if (data.find((comment) => comment.body === body)) {
    core.info('Reviewers were already pinged, not sending again');
    return;
  }

  return octokit.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.pull_request.number,
    body,
  });
}

async function get_existing_reviewers() {
  const context = get_context();
  const octokit = get_octokit();

  // Get anyone who has already reviewed the code. This endpoint returns
  // anyone who has commented, requested changes, or approved the review.
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });

  // De-dupe the existing reviews and remove any reviews from the author
  const author = context.payload.pull_request.user.login;
  const reviewers = [
    ...new Set(
      reviews
        .map((review) => review.user.login)
        .filter((reviewer) => reviewer !== author)
    ),
  ];

  // Get users marked as reviewers who have not yet participated.
  const {
    data: { users, teams },
  } = await octokit.rest.pulls.listRequestedReviewers({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  });
  const pending_reviewers = users
    .map((user) => user.login)
    .concat(teams.map((team) => team.slug));

  // Concat and de-dupe the full list of reviewers
  return [ ...new Set(pending_reviewers.concat(reviewers)) ];
}

/* Private */

let context_cache;
let token_cache;
let config_path_cache;
let octokit_cache;

function get_context() {
  return context_cache || (context_cache = github.context);
}

function get_token() {
  return token_cache || (token_cache = core.getInput('token'));
}

function get_config_path() {
  return config_path_cache || (config_path_cache = core.getInput('config'));
}

function get_octokit() {
  if (octokit_cache) {
    return octokit_cache;
  }

  const token = get_token();
  return (octokit_cache = github.getOctokit(token));
}

function clear_cache() {
  context_cache = undefined;
  token_cache = undefined;
  config_path_cache = undefined;
  octokit_cache = undefined;
}

module.exports = {
  get_existing_reviewers,
  get_pull_request,
  fetch_config,
  fetch_changed_files,
  assign_reviewers,
  ping_all_reviewers,
  clear_cache,
};
