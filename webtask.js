const tools = require('auth0-extension-tools');

const expressApp = require('./server');
const logger = require('./server/lib/logger');

module.exports = tools.createExpressServer((req, config, storage) => {
  logger.info('Starting Visual Studio Team Services Deploy extension - Version:', config('CLIENT_VERSION'));
  return expressApp(config, storage);
});
