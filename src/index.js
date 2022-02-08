'use strict';

const core = require('@actions/core');
const github = require('./github'); // Don't destructure this object to stub with sinon in tests

const {
  fetch_other_group_members,
  identify_reviewers_by_changed_files,
  identify_reviewers_by_author,
  should_request_review,
  fetch_default_reviewers,
  randomly_pick_reviewers,
} = require('./reviewer');

async function run() {
  core.info('Fetching configuration file from the source branch');

  let config;

  try {
    config = await github.fetch_config();
  } catch (error) {
    if (error.status === 404) {
      core.warning(
        'No configuration file is found in the base branch; terminating the process'
      );
      return;
    }
    throw error;
  }

  const { title, is_draft, author } = github.get_pull_request();

  if (!should_request_review({ title, is_draft, config })) {
    core.info('Matched the ignoring rules; terminating the process');
    return;
  }

  core.info('Fetching changed files in the pull request');
  const changed_files = await github.fetch_changed_files();

  core.info('Identifying reviewers based on the changed files');
  const reviewers_based_on_files = identify_reviewers_by_changed_files({
    config,
    changed_files,
    excludes: [ author ],
  });

  core.info('Identifying reviewers based on the author');
  const reviewers_based_on_author = identify_reviewers_by_author({
    config,
    author,
  });

  core.info(
    'Adding other group members to reviewers if group assignment feature is on'
  );
  const reviewers_from_same_teams = fetch_other_group_members({
    config,
    author,
  });

  let reviewers = [
    ...new Set([
      ...reviewers_based_on_files,
      ...reviewers_based_on_author,
      ...reviewers_from_same_teams,
    ]),
  ];

  let codeowners = [ ...reviewers ]; // Copy reviewers

  if (reviewers.length === 0) {
    core.info('Matched no reviewers');
    const default_reviewers = fetch_default_reviewers({
      config,
      excludes: [ author ],
    });

    if (default_reviewers.length === 0) {
      core.info('No default reviewers are matched; terminating the process');
      return;
    }

    core.info('Falling back to the default reviewers');
    reviewers.push(...default_reviewers);
  }

  const existing_reviewers = await github.get_existing_reviewers();
  if (existing_reviewers.length > 0) {
    core.info(
      `The following users are already reviewing this code: ${existing_reviewers}.`
    );
    codeowners = codeowners.filter(
      (reviewer) => !existing_reviewers.includes(reviewer)
    );
  }

  let number_of_reviewers = config.options.number_of_reviewers;

  if (number_of_reviewers !== undefined) {
    number_of_reviewers -= existing_reviewers.length;
    if (number_of_reviewers <= 0) {
      core.info('Already have enough reviewers.');

      core.info('Tagging all codeowners and reviewers in a comment');
      await github.ping_all_reviewers(codeowners, existing_reviewers);

      return;
    }
  }

  core.info(`Randomly picking ${number_of_reviewers || 'all'} reviewers`);
  reviewers = randomly_pick_reviewers(reviewers, number_of_reviewers);

  core.info(`Requesting review to ${reviewers.join(', ')}`);
  await github.assign_reviewers(reviewers);

  codeowners = codeowners.filter((reviewer) => !reviewers.includes(reviewer));
  core.info('Tagging all codeowners and reviewers in a comment');
  await github.ping_all_reviewers(codeowners, reviewers);
}

module.exports = {
  run,
};

// Run the action if it's not running in an automated testing environment
if (process.env.NODE_ENV !== 'automated-testing') {
  run().catch((error) => core.setFailed(error));
}
