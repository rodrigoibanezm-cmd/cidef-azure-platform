// Stable P1 FORUM facade. Internal responsibilities live in forum/.
export { DATA_SOURCE, CERTIFIER_VERSION, describeForum } from './forum/contract.js';
export { inspectForum, fetchForum } from './forum/access.js';
export { observeForumEvidence } from './forum/observations.js';
