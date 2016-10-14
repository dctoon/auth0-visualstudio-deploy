import _ from 'lodash';
import { Router as router } from 'express';
import { middlewares } from 'auth0-extension-express-tools';
import { dashboardAdmins, requireUser } from 'auth0-source-control-extension-tools';

import html from './html';
import meta from './meta';
import hooks from './hooks';
import webhooks from './webhooks';
import rules from './rules';
import config from '../lib/config';
import deploy from '../lib/deploy';
import manualDeploy from '../lib/manualDeploy';

const setNotified = (storage) =>
  storage.read()
    .then(data => {
      data.isNotified = true; // eslint-disable-line no-param-reassign
      return data;
    })
    .then(data => storage.write(data));

export default (storage) => {
  const routes = router();

  routes.use(middlewares.managementApiClient({
    domain: config('AUTH0_DOMAIN'),
    clientId: config('AUTH0_CLIENT_ID'),
    clientSecret: config('AUTH0_CLIENT_SECRET')
  }));
  routes.use('/.extensions', hooks());
  routes.use('/', dashboardAdmins(config('AUTH0_DOMAIN'), 'Visual Studio Deployments', config('AUTH0_RTA')));
  routes.get('/', html());
  routes.use('/meta', meta());
  routes.use('/webhooks', webhooks(storage));
  routes.use('/api/rules', requireUser, rules(storage));

  routes.post('/api/notified', requireUser, (req, res, next) => {
    setNotified(storage)
      .then(() => res.status(204).send())
      .catch(next);
  });

  routes.get('/api/config', requireUser, (req, res, next) => {
    storage.read()
      .then(data => {
        if (data.isNotified) {
          return {
            showNotification: false,
            secret: config('EXTENSION_SECRET'),
            branch: config('TFS_BRANCH') || config('TFS_PATH'),
            prefix: config('TFS_INSTANCE'),
            repository: config('TFS_PROJECT')
          };
        }

        return req.auth0.rules.get()
          .then(existingRules => {
            const result = {
              showNotification: false,
              secret: config('EXTENSION_SECRET'),
              branch: config('TFS_BRANCH') || config('TFS_PATH'),
              prefix: config('TFS_INSTANCE'),
              repository: config('TFS_PROJECT')
            };

            if (existingRules && existingRules.length) {
              result.showNotification = true;
            } else {
              setNotified(storage);
            }

            return result;
          });
      })
      .then(data => res.json(data))
      .catch(next);
  });

  routes.get('/api/deployments', requireUser, (req, res, next) =>
    storage.read()
      .then(data => res.json(_.orderBy(data.deployments || [], [ 'date' ], [ 'desc' ])))
      .catch(next)
  );

  routes.post('/api/deployments', requireUser, (req, res, next) => {
    if (config('TFS_TYPE') === 'git') {
      manualDeploy(storage, 'manual', config('TFS_BRANCH'), config('TFS_PROJECT'), (req.body && req.body.sha) || config('TFS_BRANCH'), req.user.sub, req.auth0)
        .then(stats => res.json(stats))
        .catch(next);
    } else if (config('TFS_TYPE') === 'tfvc') {
      deploy(storage, 'manual', config('TFS_PROJECT'), config('TFS_PATH'), config('TFS_PROJECT'), (req.body && req.body.sha) || 'latest', req.user.sub, req.auth0)
        .then(stats => res.json(stats))
        .catch(next);
    } else {
      res.status(400).json({ message: 'Incorrect TFS_TYPE.' });
    }
  });

  return routes;
};
