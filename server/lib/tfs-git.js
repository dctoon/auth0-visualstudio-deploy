import _ from 'lodash';
import path from 'path';
import Promise from 'bluebird';
import vsts from 'vso-node-api';

import config from './config';
import logger from '../lib/logger';
import * as constants from './constants';

/*
 * TFS API connection
 */
const collectionURL = `https://${config('TFS_INSTANCE')}.visualstudio.com/${config('TFS_COLLECTION')}`;
const vsCredentials = vsts.getBasicHandler(config('TFS_TOKEN'), '');
const vsConnection = new vsts.WebApi(collectionURL, vsCredentials);
const gitApi = vsConnection.getQGitApi();

/*
 * Check if a file is part of the rules folder.
 */
const isRule = (fileName) =>
fileName.indexOf(`${constants.RULES_DIRECTORY}/`) === 0;

/*
 * Check if a file is part of the database folder.
 */
const isDatabaseConnection = (fileName) =>
fileName.indexOf(`${constants.DATABASE_CONNECTIONS_DIRECTORY}/`) === 0;

/*
 * Get the details of a database file script.
 */
const getDatabaseScriptDetails = (filename) => {
  const parts = filename.split('/');
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
  if (isRule(fileName)) {
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
export const hasChanges = (commits, repoId) =>
  new Promise((resolve, reject) => {
    // 1. get changes for each commit
    // 2. get valid files from changes, if any
    try {
      const promisses = [];
      let files = [];

      commits.forEach(commit => {
        promisses.push(gitApi.getChanges(commit.commitId, repoId).then(data => {
          files = files.concat(data.changes);
        }));
      });

      Promise.all(promisses)
        .then(() => resolve(_.chain(files)
            .map(file => file.item.path)
            .flattenDeep()
            .uniq()
            .filter(f => validFilesOnly(f.slice(1)))
            .value()
            .length > 0))
        .catch(e => reject(e));
    }
    catch (e) {
      return reject(e);
    }
  });

/*
 * Parse the repository.
 */
const parseRepo = (repository = '') => {
  const parts = repository.split('/');
  if (parts.length === 2) {
    const [ user, repo ] = parts;
    return {user, repo};
  } else if (parts.length === 5) {
    const [ , , , user, repo ] = parts;
    return {user, repo};
  }

  throw new Error(`Invalid repository: ${repository}`);
};

/*
 * Get last commitId for branch
 */
const getCommitId = (repositoryId, branch) =>
  new Promise((resolve, reject) => {
    if (/[a-z0-9]{40}/.test(branch)) {
      return resolve(branch);
    }

    try {
      gitApi.getBranch(repositoryId, branch)
        .then(data => {
          if (data) {
            return resolve(data.commit.commitId);
          } else {
            logger.error(`Branch '${branch}' not found`);
            return reject(new Error(`Branch '${branch}' not found`));
          }
        })
        .catch(e => reject(e));
    } catch (e) {
      reject(e);
    }
  });

/*
 * Get full tree.
 */
const getTree = (repositoryId, branch) =>
  new Promise((resolve, reject) => {
    getCommitId(repositoryId, branch)
      .then(commitId => gitApi.getCommit(commitId, repositoryId))
      .then(commit => gitApi.getTree(repositoryId, commit.treeId, null, null, true))
      .then(data =>
        resolve(data.treeEntries
          .filter(f => f.gitObjectType === 3)
          .filter(f => validFilesOnly(f.relativePath))
          .map(f => ({path: f.relativePath, id: f.objectId}))))
      .catch(e => reject(e));
  });

/*
 * Download a single file.
 */
const downloadFile = (repositoryId, branch, file) =>
  new Promise((resolve, reject) => {
    try {
      gitApi.getBlobContent(repositoryId, file.id, null, true).then(data => {
        if (data) {
          let result = '';

          data.on('data', (chunk) => {
            result += chunk;
          });

          data.on('end', () => resolve({
            fileName: file.path,
            contents: result
          }));
        } else {
          logger.error(`Error downloading '${file.path}'`);
          return reject(new Error(`Error downloading '${file.path}'`));
        }
      });
    } catch (e) {
      reject(e);
    }
  });

/*
 * Download a single rule with its metadata.
 */
const downloadRule = (repositoryId, branch, ruleName, rule) => {
  const currentRule = {
    ...rule,
    name: ruleName
  };

  const downloads = [];

  if (rule.script) {
    downloads.push(downloadFile(repositoryId, branch, rule.scriptFile)
      .then(file => {
        currentRule.script = file.contents;
      }));
  }

  if (rule.metadata) {
    downloads.push(downloadFile(repositoryId, branch, rule.metadataFile)
      .then(file => {
        currentRule.metadata = JSON.parse(file.contents);
      }));
  }

  return Promise.all(downloads)
    .then(() => currentRule);
};

/*
 * Determine if we have the script, the metadata or both.
 */
const getRules = (repositoryId, branch, files) => {
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
  return Promise.map(Object.keys(rules), (ruleName) => downloadRule(repositoryId, branch, ruleName, rules[ruleName]), {concurrency: 2});
};

/*
 * Download a single database script.
 */
const downloadDatabaseScript = (repositoryId, branch, databaseName, scripts) => {
  const database = {
    name: databaseName,
    scripts: []
  };

  const downloads = [];

  scripts.forEach(script => {
    downloads.push(downloadFile(repositoryId, branch, script)
      .then(file => {
        database.scripts.push({
          stage: script.name,
          contents: file.contents
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
const getDatabaseScripts = (repositoryId, branch, files) => {
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

  return Promise.map(Object.keys(databases), (databaseName) => downloadDatabaseScript(repositoryId, branch, databaseName, databases[databaseName]), {concurrency: 2});
};

/*
 * Get a list of all changes that need to be applied to rules and database scripts.
 */
export const getChanges = (repositoryId, branch) =>
  new Promise((resolve, reject) => {
    getTree(repositoryId, branch)
      .then(files => {
        logger.debug(`Files in tree: ${JSON.stringify(files.map(file => ({name: file.path, id: file.id})), null, 2)}`);

        const promises = {
          rules: getRules(repositoryId, branch, files),
          databases: getDatabaseScripts(repositoryId, branch, files)
        };

        return Promise.props(promises)
          .then(result => resolve({
            rules: result.rules,
            databases: result.databases
          }));
      })
      .catch(e => reject(e));
  });

/*
 * Get a repository id by name.
 */
export const getRepositoryId = (name) =>
  gitApi.getRepositories()
    .then(repositories => {
      if (!repositories)
        return null;

      const repository = repositories.filter(f => f.name === name);

      if (repository[0] && repository[0].id)
        return repository[0].id;
      else
        return null;
    });
