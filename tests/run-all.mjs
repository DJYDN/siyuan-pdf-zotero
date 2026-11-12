// In-process test entry point.
// DSH's file sandbox blocks Node's test-runner child process spawn, so we import
// every test file into one process and let node:test report the TAP stream.
import "./unit/anchor.test.mjs";
import "./unit/asset-path.test.mjs";
import "./unit/citation-mapper.test.mjs";
import "./unit/store-backup.test.mjs";
import "./unit/link-format.test.mjs";
import "./integration/pdf-source.test.mjs";
import "./integration/pdfjs.test.mjs";
import "./integration/links.test.mjs";
import "./integration/citation.test.mjs";
