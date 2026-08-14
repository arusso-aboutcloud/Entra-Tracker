Fixtures in this directory are **synthetic parsed items**, not raw Microsoft
payloads. The dedupe/merge stage (`dedupeIntraSource` / `mergeCrossSource` /
`twoStageDedupe` in `worker.js`) operates on already-parsed item objects, not
on markdown/HTML/RSS text, so there is no raw Microsoft source document to
trim for these cases. Each fixture is a small array of item objects shaped
exactly like parser output (same fields the real parsers emit), constructed
to exercise one dedupe/merge rule in isolation.

Parser-level fixtures (real trimmed Microsoft payloads, per the work order's
Phase-1-onward rule) belong in sibling directories as those parsers gain
fixture tests.
