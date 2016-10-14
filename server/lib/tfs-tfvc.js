import _ from 'lodash';
import path from 'path';
import Promise from 'bluebird';
import vsts from 'vso-node-api';
import request from 'request-promise';
import { constants, unifyDatabases, unifyScripts } from 'auth0-source-control-extension-tools';

import config from './config';
import logger from '../lib/logger';


/*
 * TFS API connection
 */
let tfvcApi = null;

const getApi = () => {
  if (!tfvcApi) {
    const collectionURL = `https://${config('TFS_INSTANCE')}.visualstudio.com/${config('TFS_COLLECTION')}`;
    const vsCredentials = vsts.getBasicHandler(config('TFS_TOKEN'), '');
    const vsConnection = new vsts.WebApi(collectionURL, vsCredentials);
    tfvcApi = vsConnection.getQTfvcApi();
  }

  return tfvcApi;
};

/*
 * Check if a file is part of the rules folder.
 */
const isRule = (file) =>
file.indexOf(`${config('TFS_PATH')}/${constants.RULES_DIRECTORY}/`) === 0;

/*
 * Check if a file is part of the database folder.
 */
const isDatabaseConnection = (file) =>
file.indexOf(`${config('TFS_PATH')}/${constants.DATABASE_CONNECTIONS_DIRECTORY}/`) === 0;

/*
 * Check if a file is part of the pages folder.
 */
const isPage = (file) =>
file.indexOf(`${config('TFS_PATH')}/${constants.PAGES_DIRECTORY}/`) === 0
&& constants.PAGE_NAMES.indexOf(file.split('/').pop()) >= 0;

/*
 * Get the details of a database file script.
 */
const getDatabaseScriptDetails = (filename) => {
  const parts = filename.replace(`${config('TFS_PATH')}/`, '').split('/');
  if (parts.length === 3 && /\.js$/i.test(parts[2])) {
    const scriptName = path.parse(parts[2]).name;
    if (constants.DATABASE_SCRIPTS.indexOf(scriptName) > -1) {
      return {
        database: parts[1],
        name: path.parse(scriptName).name
      };
    }
  }

  return null;
};

/*
 * Only Javascript and JSON files.
 */
const validFilesOnly = (fileName) => {
  if (isPage(fileName)) {
    return true;
  } else if (isRule(fileName)) {
    return /\.(js|json)$/i.test(fileName);
  } else if (isDatabaseConnection(fileName)) {
    const script = getDatabaseScriptDetails(fileName);
    return !!script;
  }

  return false;
};

/*
 * Get a flat list of changes and files that need to be added/updated/removed.
 */
export const hasChanges = (changesetId) =>
  getApi().getChangesetChanges(changesetId).then(data =>
  _.chain(data)
    .map(file => file.item.path)
    .flattenDeep()
    .uniq()
    .filter(validFilesOnly)
    .value()
    .length > 0);


/*
 * Get rules tree.
 */
const getRulesTree = (project) =>
  new Promise((resolve, reject) => {
    try {
      getApi().getItems(project, `${config('TFS_PATH')}/${constants.RULES_DIRECTORY}`)
        .then(data => {
          if (!data) {
            return resolve([]);
          }

          const files = data
            .filter(f => f.size)
            .filter(f => validFilesOnly(f.path));

          return resolve(files);
        })
        .catch(e => reject(e));
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get pages tree.
 */
const getPagesTree = (project) =>
  new Promise((resolve, reject) => {
    try {
      getApi().getItems(project, `${config('TFS_PATH')}/${constants.PAGES_DIRECTORY}`)
        .then(data => {
          if (!data) {
            return resolve([]);
          }

          const files = data
            .filter(f => f.size)
            .filter(f => validFilesOnly(f.path));

          return resolve(files);
        })
        .catch(e => reject(e));
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get connection files for one db connection
 */
const getConnectionTreeByPath = (project, branch, filePath) =>
  new Promise((resolve, reject) => {
    try {
      getApi().getItems(project, filePath).then(data => {
        if (!data) {
          return resolve([]);
        }

        const files = data
          .filter(f => f.size)
          .filter(f => validFilesOnly(f.path));

        return resolve(files);
      });
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get all files for all database-connections.
 */
const getConnectionsTree = (project, branch) =>
  new Promise((resolve, reject) => {
    try {
      getApi().getItems(project, `${config('TFS_PATH')}/${constants.DATABASE_CONNECTIONS_DIRECTORY}`)
        .then(data => {
          if (!data) {
            return resolve([]);
          }

          const subdirs = data.filter(f => f.isFolder && f.path !== `${config('TFS_PATH')}/${constants.DATABASE_CONNECTIONS_DIRECTORY}`);
          const promisses = [];
          let files = [];
          subdirs.forEach(subdir => {
            promisses.push(getConnectionTreeByPath(project, branch, subdir.path).then(tree => {
              files = files.concat(tree);
            }));
          });

          return Promise.all(promisses)
            .then(() => resolve(files));
        })
        .catch(e => reject(e));
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get full tree.
 */
const getTree = (project, changesetId) =>
  new Promise((resolve, reject) => {
    // Getting separate trees for rules and connections, as tfsvc does not provide full (recursive) tree
    const promises = {
      rules: getRulesTree(project, changesetId),
      connections: getConnectionsTree(project, changesetId),
      pages: getPagesTree(project, changesetId)
    };

    Promise.props(promises)
      .then(result => resolve(_.union(result.rules, result.connections, result.pages)))
      .catch(e => reject(e));
  });

/*
 * Download a single file.
 */
const downloadFile = (file, changesetId) => {
  const version = parseInt(changesetId, 10) || null;
  const versionString = (version) ? `&version=${version}` : '';
  const auth = new Buffer(`${config('TFS_USERNAME')}:${config('TFS_TOKEN')}`).toString('base64');

  const options = {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'text/html'
    },
    uri: `https://${config('TFS_INSTANCE')}.visualstudio.com/${config('TFS_COLLECTION')}/_apis/tfvc/items?path=${file.path}${versionString}&api-version=1.0`
  };

  return request.get(options)
    .then((data) => ({
      fileName: file.path,
      contents: data
    }))
    .catch(e => e);
};

/*
 * Download a single rule with its metadata.
 */
const downloadRule = (changesetId, ruleName, rule) => {
  const currentRule = {
    script: false,
    metadata: false,
    name: ruleName
  };

  const downloads = [];

  if (rule.script) {
    downloads.push(downloadFile(rule.scriptFile, changesetId)
      .then(file => {
        currentRule.script = true;
        currentRule.scriptFile = file.contents;
      }));
  }

  if (rule.metadata) {
    downloads.push(downloadFile(rule.metadataFile, changesetId)
      .then(file => {
        currentRule.metadata = true;
        currentRule.metadataFile = JSON.parse(file.contents);
      }));
  }

  return Promise.all(downloads)
    .then(() => currentRule);
};

/*
 * Determine if we have the script, the metadata or both.
 */
const getRules = (changesetId, files) => {
  // Rules object.
  const rules = {};

  _.filter(files, f => isRule(f.path)).forEach(file => {
    const ruleName = path.parse(file.path).name;
    rules[ruleName] = rules[ruleName] || {};

    if (/\.js$/i.test(file.path)) {
      rules[ruleName].script = true;
      rules[ruleName].scriptFile = file;
    } else if (/\.json$/i.test(file.path)) {
      rules[ruleName].metadata = true;
      rules[ruleName].metadataFile = file;
    }
  });

  // Download all rules.
  return Promise.map(Object.keys(rules), ruleName => downloadRule(changesetId, ruleName, rules[ruleName]), { concurrency: 2 });
};

/*
 * Download a single database script.
 */
const downloadDatabaseScript = (changesetId, databaseName, scripts) => {
  const database = {
    name: databaseName,
    scripts: []
  };

  const downloads = [];

  scripts.forEach(script => {
    downloads.push(downloadFile(script, changesetId)
      .then(file => {
        database.scripts.push({
          name: script.name,
          scriptFile: file.contents
        });
      })
    );
  });

  return Promise.all(downloads)
    .then(() => database);
};

/*
 * Get all database scripts.
 */
const getDatabaseScripts = (changesetId, files) => {
  const databases = {};

  _.filter(files, f => isDatabaseConnection(f.path)).forEach(file => {
    const script = getDatabaseScriptDetails(file.path);
    if (script) {
      databases[script.database] = databases[script.database] || [];
      databases[script.database].push({
        ...script,
        id: file.id,
        path: file.path
      });
    }
  });

  return Promise.map(Object.keys(databases), (databaseName) => downloadDatabaseScript(changesetId, databaseName, databases[databaseName]), { concurrency: 2 });
};

/*
 * Download a single page script.
 */
const downloadPage = (changesetId, pageName, page) => {
  const downloads = [];
  const currentPage = {
    metadata: false,
    name: pageName
  };

  if (page.file) {
    downloads.push(downloadFile(page.file, changesetId)
      .then(file => {
        currentPage.htmlFile = file.contents;
      }));
  }


  if (page.meta_file) {
    downloads.push(downloadFile(page.meta_file, changesetId)
      .then(file => {
        currentPage.metadata = true;
        currentPage.metadataFile = file.contents;
      }));
  }

  return Promise.all(downloads).then(() => currentPage);
};

/*
 * Get all pages.
 */
const getPages = (changesetId, files) => {
  const pages = {};

  // Determine if we have the script, the metadata or both.
  _.filter(files, f => isPage(f.path)).forEach(file => {
    const pageName = path.parse(file.path).name;
    const ext = path.parse(file.path).ext;
    pages[pageName] = pages[pageName] || {};

    if (ext !== '.json') {
      pages[pageName].file = file;
      pages[pageName].sha = file.sha;
      pages[pageName].path = file.path;
    } else {
      pages[pageName].meta_file = file;
      pages[pageName].meta_sha = file.sha;
      pages[pageName].meta_path = file.path;
    }
  });

  return Promise.map(Object.keys(pages), (pageName) =>
    downloadPage(changesetId, pageName, pages[pageName]), { concurrency: 2 });
};

/*
 * Get a list of all changes that need to be applied to rules and database scripts.
 */
export const getChanges = (project, changesetId) =>
  new Promise((resolve, reject) => {
    getTree(project, changesetId)
      .then(files => {
        logger.debug(`Files in tree: ${JSON.stringify(files.map(file => ({
          name: file.path,
          id: file.id
        })), null, 2)}`);

        const promises = {
          rules: getRules(changesetId, files),
          databases: getDatabaseScripts(changesetId, files),
          pages: getPages(changesetId, files)
        };

        Promise.props(promises)
          .then((result) =>
            resolve({
              rules: unifyScripts(result.rules),
              databases: unifyDatabases(result.databases),
              pages: unifyScripts(result.pages)
            }));
      })
      .catch(e => reject(e));
  });
