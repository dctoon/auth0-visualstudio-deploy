import _ from 'lodash';
import path from 'path';
import Promise from 'bluebird';
import vsts from 'vso-node-api';
import { constants, unifyDatabases, unifyScripts } from 'auth0-source-control-extension-tools';

import config from './config';
import logger from '../lib/logger';

/*
 * TFS API connection
 */
let gitApi = null;

const getApi = () => {
  if (!gitApi) {
    const collectionURL = `https://${config('TFS_INSTANCE')}.visualstudio.com/${config('TFS_COLLECTION')}`;
    const vsCredentials = vsts.getBasicHandler(config('TFS_TOKEN'), '');
    const vsConnection = new vsts.WebApi(collectionURL, vsCredentials);
    gitApi = vsConnection.getQGitApi();
  }

  return gitApi;
};

/*
 * Check if a file is part of the rules folder.
 */
const isRule = (file) =>
file.indexOf(`${constants.RULES_DIRECTORY}/`) === 0;

/*
 * Check if a file is part of the database folder.
 */
const isDatabaseConnection = (file) =>
file.indexOf(`${constants.DATABASE_CONNECTIONS_DIRECTORY}/`) === 0;

/*
 * Check if a file is part of the pages folder.
 */
const isPage = (file) =>
file.indexOf(`${constants.PAGES_DIRECTORY}/`) === 0 && constants.PAGE_NAMES.indexOf(file.split('/').pop()) >= 0;

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
export const hasChanges = (commits, repoId) =>
  new Promise((resolve, reject) => {
    // 1. get changes for each commit
    // 2. get valid files from changes, if any
    try {
      const promisses = [];
      let files = [];

      commits.forEach(commit => {
        promisses.push(getApi().getChanges(commit.commitId, repoId).then(data => {
          files = files.concat(data.changes);
        }));
      });

      return Promise.all(promisses)
        .then(() => resolve(_.chain(files)
            .map(file => file.item.path)
            .flattenDeep()
            .uniq()
            .filter(f => validFilesOnly(f.slice(1)))
            .value()
            .length > 0))
        .catch(e => reject(e));
    } catch (e) {
      return reject(e);
    }
  });

/*
 * Get last commitId for branch
 */
const getCommitId = (repositoryId, branch) =>
  new Promise((resolve, reject) => {
    if (/[a-z0-9]{40}/.test(branch)) {
      return resolve(branch);
    }

    try {
      return getApi().getBranch(repositoryId, branch)
        .then(data => {
          if (!data) {
            logger.error(`Branch '${branch}' not found`);
            return reject(new Error(`Branch '${branch}' not found`));
          }

          return resolve(data.commit.commitId);
        })
        .catch(e => reject(e));
    } catch (e) {
      return reject(e);
    }
  });

/*
 * Get full tree.
 */
const getTree = (repositoryId, branch) =>
  new Promise((resolve, reject) => {
    getCommitId(repositoryId, branch)
      .then(commitId => getApi().getCommit(commitId, repositoryId))
      .then(commit => getApi().getTree(repositoryId, commit.treeId, null, null, true))
      .then(data =>
        resolve(data.treeEntries
          .filter(f => f.gitObjectType === 3)
          .filter(f => validFilesOnly(f.relativePath))
          .map(f => ({ path: f.relativePath, id: f.objectId }))))
      .catch(e => reject(e));
  });

/*
 * Download a single file.
 */
const downloadFile = (repositoryId, branch, file) =>
  new Promise((resolve, reject) => {
    try {
      getApi().getBlobContent(repositoryId, file.id, null, true).then(data => {
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
          reject(new Error(`Error downloading '${file.path}'`));
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
    script: false,
    metadata: false,
    name: ruleName
  };

  const downloads = [];

  if (rule.script) {
    downloads.push(downloadFile(repositoryId, branch, rule.scriptFile)
      .then(file => {
        currentRule.script = true;
        currentRule.scriptFile = file.contents;
      }));
  }

  if (rule.metadata) {
    downloads.push(downloadFile(repositoryId, branch, rule.metadataFile)
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
  return Promise.map(Object.keys(rules), (ruleName) => downloadRule(repositoryId, branch, ruleName, rules[ruleName]), { concurrency: 2 });
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

  return Promise.map(Object.keys(databases), (databaseName) => downloadDatabaseScript(repositoryId, branch, databaseName, databases[databaseName]), { concurrency: 2 });
};

/*
 * Download a single page script.
 */
const downloadPage = (repositoryId, branch, pageName, page) => {
  const downloads = [];
  const currentPage = {
    metadata: false,
    name: pageName
  };

  if (page.file) {
    downloads.push(downloadFile(repositoryId, branch, page.file)
      .then(file => {
        currentPage.htmlFile = file.contents;
      }));
  }

  if (page.meta_file) {
    downloads.push(downloadFile(repositoryId, branch, page.meta_file)
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
const getPages = (repositoryId, branch, files) => {
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
    downloadPage(repositoryId, branch, pageName, pages[pageName]), { concurrency: 2 });
};

/*
 * Get a list of all changes that need to be applied to rules and database scripts.
 */
export const getChanges = (repositoryId, branch) =>
  new Promise((resolve, reject) => {
    getTree(repositoryId, branch)
      .then(files => {
        logger.debug(`Files in tree: ${JSON.stringify(files.map(file => ({
          name: file.path,
          id: file.id
        })), null, 2)}`);

        const promises = {
          rules: getRules(repositoryId, branch, files),
          databases: getDatabaseScripts(repositoryId, branch, files),
          pages: getPages(repositoryId, branch, files)
        };

        return Promise.props(promises)
          .then(result => resolve({
            rules: unifyScripts(result.rules),
            databases: unifyDatabases(result.databases),
            pages: unifyScripts(result.pages)
          }));
      })
      .catch(e => reject(e));
  });

/*
 * Get a repository id by name.
 */
export const getRepositoryId = (name) =>
  getApi().getRepositories()
    .then(repositories => {
      if (!repositories) return null;

      let rID = null;
      const repository = repositories.filter(f => f.name === name);

      if (repository[0] && repository[0].id) rID = repository[0].id;

      return rID;
    });
