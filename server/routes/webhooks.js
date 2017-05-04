import express from 'express';
import { middlewares } from 'auth0-extension-express-tools';

import config from '../lib/config';
import deploy from '../lib/deploy';
import { hasChanges as hasGitChanges } from '../lib/tfs-git';
import { hasChanges as hasTfvcChanges } from '../lib/tfs-tfvc';
import { gitWebhook, tfvcWebhook } from '../lib/middlewares';

export default (storage) => {
  const tfsSecret = config('EXTENSION_SECRET');
  const webhooks = express.Router(); // eslint-disable-line new-cap
  const gitRoute = config('TFS_TYPE') === 'git' ? '/deploy' : '/deploy/git';
  const tfvcRoute = config('TFS_TYPE') === 'tfvc' ? '/deploy' : '/deploy/tfvc';

  webhooks.use(middlewares.managementApiClient({
    domain: config('AUTH0_DOMAIN'),
    clientId: config('AUTH0_CLIENT_ID'),
    clientSecret: config('AUTH0_CLIENT_SECRET')
  }));

  webhooks.post(gitRoute, gitWebhook(tfsSecret), (req, res) => {
    const { id, repository_id, branch, commits, repository, user, sha } = req.webhook;

    // Only accept push requests.
    if (req.webhook.event !== 'git.push') {
      return res.status(202).json({ message: `Request ignored, the '${req.webhook.event}' event is not supported.` });
    }

    // Only run if there really are changes.
    return hasGitChanges(commits, repository_id).then(changes => {
      if (!changes) {
        return res.status(202).json({ message: 'Request ignored, none of the Rules or Database Connection scripts were changed.' });
      }

      // Send response ASAP to prevent extra requests.
      res.status(202).json({ message: 'Request accepted, deployment started.' });

      // Deploy the changes.
      return deploy(storage, id, repository_id, branch, repository, sha, user, req.auth0);
    });
  });

  webhooks.post(tfvcRoute, tfvcWebhook(tfsSecret), (req, res) => {
    const { id, event, changeset, user } = req.webhook;

    // Only accept checkin requests.
    if (event !== 'tfvc.checkin') {
      return res.status(202).json({ message: `Request ignored, the '${event}' event is not supported.` });
    }

    // Only run if there really are changes.
    return hasTfvcChanges(changeset).then(changes => {
      if (!changes) {
        return res.status(202).json({ message: 'Request ignored, none of the Rules or Database Connection scripts were changed.' });
      }

      // Send response ASAP to prevent extra requests.
      res.status(202).json({ message: 'Request accepted, deployment started.' });

      // Deploy the changes.
      return deploy(storage, id, config('TFS_PROJECT'), config('TFS_PATH'), config('TFS_PROJECT'), changeset, user, req.auth0);
    });
  });

  return webhooks;
};
