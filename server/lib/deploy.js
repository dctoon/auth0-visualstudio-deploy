import { deploy as sourceDeploy } from 'auth0-source-control-extension-tools';
import config from '../lib/config';

import { getChanges as getGitChanges } from './tfs-git';
import { getChanges as getTfvcChanges } from './tfs-tfvc';

export default (storage, id, repositoryId, branch, repository, sha, user, client) => {
  const getChanges = config('TFS_TYPE') === 'git' ? getGitChanges : getTfvcChanges;

  const context = {
    init: () => getChanges(repositoryId, sha)
      .then(data => {
        context.pages = data.pages;
        context.rules = data.rules;
        context.databases = data.databases;
      })
  };

  const slackTemplate = {
    fallback: 'Visual Studio to Auth0 Deployment',
    text: `Visual Studio (${config('TFS_TYPE')}) to Auth0 Deployment`
  };

  return sourceDeploy({ id, branch, repository, sha, user }, context, client, storage, config, slackTemplate);
};
