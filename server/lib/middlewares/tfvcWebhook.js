import { ArgumentError, UnauthorizedError } from '../errors';

const parse = ({ notificationId = '', resource = {}, eventType = '' }) => {
  return {
    id: notificationId,
    event: eventType,
    changeset: resource.changesetId,
    user: resource.checkedInBy.uniqueName
  };
};

module.exports = (secret) => (req, res, next) => {
  if (!secret || secret.length === 0) {
    return next(new UnauthorizedError('The extension secret is not set, unable to verify webhook signature.'));
  }

  if (secret !== req.headers['x-hook-secret']) {
    return next(new UnauthorizedError('The webhook secret is incorrect.'));
  }

  req.webhook = parse(req.body);

  return next();
};
