import express from 'express';

import config from '../lib/config';
import deploy from '../lib/deploy';

import { hasChanges as hasGitChanges } from '../lib/tfs-git';
import { hasChanges as hasTfvcChanges } from '../lib/tfs-tfvc';
import { gitWebhook, tfvcWebhook } from '../lib/middlewares';

export default (storageContext) => {
  const tfsSecret = config('EXTENSION_SECRET');
  const webhooks = express.Router();
  const gitRoute = config('TFS_TYPE') === 'git' ? '/deploy' : '/deploy/git';
  const tfvcRoute = config('TFS_TYPE') === 'tfvc' ? '/deploy' : '/deploy/tfvc';

  webhooks.post(gitRoute, gitWebhook(tfsSecret), (req, res, next) => {
    const { id, repository_id, branch, commits, repository, user, sha } = req.webhook;

    // Only accept push requests.
    if (req.webhook.event !== 'git.push') {
      return res.status(202).json({ message: `Request ignored, the '${req.webhook.event}' event is not supported.` });
    }

    // Only run if there really are changes.
    hasGitChanges(commits, repository_id).then(changes => {
      if (!changes) {
        return res.status(202).json({ message: 'Request ignored, none of the Rules or Database Connection scripts were changed.' });
      }

      // Deploy the changes.
      return deploy(storageContext, id, repository_id, branch, repository, sha, user)
        .then(stats => res.status(200).json(stats))
        .catch(() => res.status(200).json());
    });
  });

  webhooks.post(tfvcRoute, tfvcWebhook(tfsSecret), (req, res, next) => {
    const { id, event, changeset, user } = req.webhook;

    // Only accept checkin requests.
    if (event !== 'tfvc.checkin') {
      return res.status(202).json({ message: `Request ignored, the '${event}' event is not supported.` });
    }

    // Only run if there really are changes.
    hasTfvcChanges(changeset).then(changes => {
      if (!changes) {
        return res.status(202).json({ message: 'Request ignored, none of the Rules or Database Connection scripts were changed.' });
      }

      // Deploy the changes.
      return deploy(storageContext, id, config('TFS_PROJECT'), config('TFS_PATH'), config('TFS_PROJECT'), changeset, user)
        .then(stats => res.status(200).json(stats))
        .catch(() => res.status(200).json());
        // .then(stats => res.status(200).json(stats))
        // .catch(next);
    });
  });

  return webhooks;
};
