import express from 'express';

import config from '../lib/config';
import deploy from '../lib/deploy';

import { hasChanges } from '../lib/tfs';
import { gitWebhook } from '../lib/middlewares';

export default (storageContext) => {
  const tfsSecret = config('EXTENSION_SECRET');
  const webhooks = express.Router();


  webhooks.post('/deploy', gitWebhook(tfsSecret), (req, res, next) => {
    const { id, repository_id, branch, commits, repository, user, sha } = req.webhook;

    // Only accept push requests.
    if (req.webhook.event !== 'git.push') {
      return res.status(202).json({ message: `Request ignored, the '${req.webhook.event}' event is not supported.` });
    }

    // Only run if there really are changes.
    hasChanges(commits, repository_id).then(changes => {
      if (!changes) {
        return res.status(202).json({ message: 'Request ignored, none of the Rules or Database Connection scripts were changed.' });
      }

      // Deploy the changes.
      return deploy(storageContext, id, repository_id, branch, repository, sha, user)
        .then(stats => res.status(200).json(stats))
        .catch(() => res.status(200).json());
    });
  });

  return webhooks;
};
