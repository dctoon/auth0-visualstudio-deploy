import { ArgumentError, UnauthorizedError } from '../errors';

const parse = ({ notificationId = '', resource = {}, eventType = '' }) => {
  const refParts = resource.refUpdates[0].name.split('/');
  const checkout_sha = resource.refUpdates[0].newObjectId;

  return {
    id: notificationId,
    repository_id: resource.repository.id,
    event: eventType,
    branch: refParts.length === 3 ? refParts[2] : '',
    commits: resource.commits,
    repository: resource.repository.name,
    user: resource.pushedBy.uniqueName,
    sha: checkout_sha
  };
};

module.exports = (secret) => (req, res, next) => {
  if (!secret || secret.length === 0) {
    return next(new UnauthorizedError('The extension secret is not set, unable to verify webhook signature.'));
  }

  if (secret !== req.headers['x-hook-secret']) {
    return next(new UnauthorizedError('The webhook secret is incorrect.'));
  }

  if (!req.body.resource.refUpdates || !req.body.resource.refUpdates[0]) {
    return next(new ArgumentError('The webhook details are incorrect.'));
  }

  req.webhook = parse(req.body);

  return next();
};
