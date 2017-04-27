import _ from 'lodash';
import express from 'express';
import { middlewares } from 'auth0-extension-express-tools';

import rules from './rules';
import deploy from '../lib/deploy';
import manualDeploy from '../lib/manualDeploy';
import config from '../lib/config';

const setNotified = (storage) =>
  storage.read()
    .then(data => {
      data.isNotified = true; // eslint-disable-line no-param-reassign
      return data;
    })
    .then(data => storage.write(data));

export default (storage) => {
  const api = express.Router(); // eslint-disable-line new-cap
  api.use(middlewares.authenticateAdmins({
    credentialsRequired: true,
    secret: config('EXTENSION_SECRET'),
    audience: 'urn:visualstudio-deploy',
    baseUrl: config('PUBLIC_WT_URL'),
    onLoginSuccess: (req, res, next) => {
      next();
    }
  }));

  api.use(middlewares.managementApiClient({
    domain: config('AUTH0_DOMAIN'),
    clientId: config('AUTH0_CLIENT_ID'),
    clientSecret: config('AUTH0_CLIENT_SECRET')
  }));

  api.use('/rules', rules(storage));

  api.post('/notified', (req, res, next) => {
    setNotified(storage)
      .then(() => res.status(204).send())
      .catch(next);
  });

  api.get('/config', (req, res, next) => {
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

  api.get('/deployments', (req, res, next) =>
    storage.read()
      .then(data => res.json(_.orderBy(data.deployments || [], [ 'date' ], [ 'desc' ])))
      .catch(next)
  );

  api.post('/deployments', (req, res, next) => {
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
  return api;
};
