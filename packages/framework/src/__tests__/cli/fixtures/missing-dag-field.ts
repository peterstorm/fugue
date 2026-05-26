// Fixture: default export exists but doesn't have a `dag` field. CLI must
// report { kind: "missing-dag-field" }.

export default {
  somethingElse: 42,
  description: "Not a DagRegistration",
};
