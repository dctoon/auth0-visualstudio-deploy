import { getRepositoryId } from './tfs-git';
import deploy from './deploy';

export default (storage, id, branch, repository, sha, user, client) =>
  getRepositoryId(repository)
    .then(repositoryId => deploy(storage, id, repositoryId, branch, repository, sha, user, client));
